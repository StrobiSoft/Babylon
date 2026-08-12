import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth-service.js';
import { hash } from '../src/crypto.js';
import { PostgresDatabase } from '../src/database.js';
import { runMigrations } from '../src/migrations.js';
import {
  authenticationResponse,
  DeterministicRandom,
  FakeClock,
  FakeWebAuthn,
  MemoryMailer,
  pkce,
  registrationResponse,
  state,
  testConfig,
  verifier,
} from './helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('PostgreSQL authentication state machine', () => {
  const database = new PostgresDatabase(databaseUrl ?? 'postgresql://unused');
  const config = testConfig(databaseUrl ?? 'postgresql://unused');
  let clock: FakeClock;
  let random: DeterministicRandom;
  let mailer: MemoryMailer;
  let webauthn: FakeWebAuthn;
  let service: AuthService;

  beforeAll(async () => {
    const migrations = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
    await runMigrations(database, migrations);
  });

  beforeEach(async () => {
    await database.query('TRUNCATE users,invitations,audit_log RESTART IDENTITY CASCADE');
    clock = new FakeClock();
    random = new DeterministicRandom();
    mailer = new MemoryMailer();
    webauthn = new FakeWebAuthn();
    service = new AuthService(database, config, clock, random, mailer, webauthn);
  });

  afterAll(async () => database.close());

  async function registrationTransaction() {
    return service.startNativeAuth({
      clientId: 'babylon-flutter',
      returnProfile: 'desktop-local',
      pkceChallenge: pkce,
      state,
      operation: 'register',
    });
  }

  async function verifiedEnrollment(email = 'user@example.test') {
    const transaction = await registrationTransaction();
    const invitation = await service.createInvitation(email);
    await service.acceptInvitation(
      invitation.invitationCode,
      email,
      transaction.transactionToken,
      state,
    );
    const emailToken = mailer.lastToken();
    const confirmed = await service.confirmEmail(emailToken, transaction.transactionToken, state);
    return { enrollmentToken: confirmed.enrollmentToken, transaction };
  }

  async function registerAndExchange(): Promise<{
    accessToken: string;
    refreshToken: string;
    deviceId: string;
  }> {
    const { enrollmentToken, transaction } = await verifiedEnrollment();
    const options = await service.registrationOptions({
      enrollmentToken,
      transactionToken: transaction.transactionToken,
      state,
    });
    const verified = await service.verifyRegistration({
      ceremonyToken: options.ceremonyToken,
      transactionToken: transaction.transactionToken,
      state,
      response: registrationResponse,
    });
    expect(verified.redirectUrl).not.toContain('accessToken');
    expect(verified.redirectUrl).not.toContain('refreshToken');
    const tokens = await service.exchangeReturnCode({
      returnCode: verified.returnCode,
      clientId: 'babylon-flutter',
      pkceVerifier: verifier,
      state,
      deviceName: 'Teszt Windows',
      platform: 'windows',
      clientDeviceKey: 'd'.repeat(43),
    });
    const me = await service.authenticate(tokens.accessToken);
    return { ...tokens, deviceId: me.deviceId };
  }

  it('runs migrations on an empty schema and is idempotent on an existing schema', async () => {
    const migrations = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
    await runMigrations(database, migrations);
    const result = await database.query<{ count: string }>(
      'SELECT count(*) FROM schema_migrations',
    );
    expect(Number(result.rows[0]?.count)).toBeGreaterThan(0);
    const indexes = await database.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public'`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain('sessions_active_idx');
  });

  it('installs all security tables, constraints, indexes, and append-only audit protection', async () => {
    const tables = await database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE'`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'users',
        'invitations',
        'email_verification_tokens',
        'enrollment_grants',
        'native_auth_transactions',
        'webauthn_challenges',
        'passkey_credentials',
        'devices',
        'sessions',
        'refresh_token_families',
        'refresh_tokens',
        'app_return_codes',
        'audit_log',
      ]),
    );
    const indexes = await database.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public'`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'email_tokens_one_active_idx',
        'enrollment_one_active_idx',
        'passkey_credentials_credential_id_key',
        'sessions_access_token_hash_key',
        'refresh_tokens_token_hash_key',
        'app_return_codes_code_hash_key',
      ]),
    );
    await service.createInvitation('append-only@example.test');
    await expect(database.query("UPDATE audit_log SET event_type='tampered'")).rejects.toBeTruthy();
  });

  it('accepts one valid invitation and stores no raw invitation or email token', async () => {
    const invitation = await service.createInvitation('User@Example.Test');
    const transaction = await registrationTransaction();
    await service.acceptInvitation(
      invitation.invitationCode,
      'user@example.test',
      transaction.transactionToken,
      state,
    );
    const rawEmailToken = mailer.lastToken();
    const invitationRows = await database.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM invitations',
    );
    const emailRows = await database.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM email_verification_tokens',
    );
    expect(invitationRows.rows[0]?.token_hash).toEqual(hash(invitation.invitationCode));
    expect(emailRows.rows[0]?.token_hash).toEqual(hash(rawEmailToken));
    const searchable = await database.query<{ value: string }>(
      `SELECT coalesce(string_agg(metadata::text,' '),'') value FROM audit_log`,
    );
    expect(searchable.rows[0]?.value).not.toContain(invitation.invitationCode);
    expect(searchable.rows[0]?.value).not.toContain(rawEmailToken);
  });

  it.each([
    ['invalid code', 'wrong'.repeat(10), 'user@example.test'],
    ['wrong email', null, 'other@example.test'],
  ])('rejects %s', async (_name, code, email) => {
    const invitation = await service.createInvitation('user@example.test');
    const transaction = await registrationTransaction();
    await expect(
      service.acceptInvitation(
        code ?? invitation.invitationCode,
        email,
        transaction.transactionToken,
        state,
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects an expired and already-used invitation', async () => {
    const expired = await service.createInvitation('expired@example.test');
    const expiredTransaction = await registrationTransaction();
    clock.advance(config.invitationTtlSeconds + 1);
    await expect(
      service.acceptInvitation(
        expired.invitationCode,
        'expired@example.test',
        expiredTransaction.transactionToken,
        state,
      ),
    ).rejects.toBeTruthy();
    clock = new FakeClock();
    service = new AuthService(database, config, clock, random, mailer, webauthn);
    const used = await service.createInvitation('used@example.test');
    const usedTransaction = await registrationTransaction();
    await service.acceptInvitation(
      used.invitationCode,
      'used@example.test',
      usedTransaction.transactionToken,
      state,
    );
    await expect(
      service.acceptInvitation(
        used.invitationCode,
        'used@example.test',
        usedTransaction.transactionToken,
        state,
      ),
    ).rejects.toBeTruthy();
  });

  it('allows exactly one of two parallel invitation redemptions', async () => {
    const invitation = await service.createInvitation('race@example.test');
    const transaction = await registrationTransaction();
    const results = await Promise.allSettled([
      service.acceptInvitation(
        invitation.invitationCode,
        'race@example.test',
        transaction.transactionToken,
        state,
      ),
      service.acceptInvitation(
        invitation.invitationCode,
        'race@example.test',
        transaction.transactionToken,
        state,
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('handles email token validity, replay, expiry and parallel confirmation', async () => {
    const invitation = await service.createInvitation('mail@example.test');
    const transaction = await registrationTransaction();
    await service.acceptInvitation(
      invitation.invitationCode,
      'mail@example.test',
      transaction.transactionToken,
      state,
    );
    const emailToken = mailer.lastToken();
    await expect(
      service.confirmEmail('wrong'.repeat(10), transaction.transactionToken, state),
    ).rejects.toBeTruthy();
    const results = await Promise.allSettled([
      service.confirmEmail(emailToken, transaction.transactionToken, state),
      service.confirmEmail(emailToken, transaction.transactionToken, state),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(
      service.confirmEmail(emailToken, transaction.transactionToken, state),
    ).rejects.toBeTruthy();

    const expiredInvite = await service.createInvitation('mail2@example.test');
    const expiredTransaction = await registrationTransaction();
    await service.acceptInvitation(
      expiredInvite.invitationCode,
      'mail2@example.test',
      expiredTransaction.transactionToken,
      state,
    );
    const expiredToken = mailer.lastToken();
    clock.advance(config.emailTokenTtlSeconds + 1);
    await expect(
      service.confirmEmail(expiredToken, expiredTransaction.transactionToken, state),
    ).rejects.toBeTruthy();
  });

  it('resends verification, invalidates the old token, and recovers after SMTP failure', async () => {
    mailer.fail = true;
    const invitation = await service.createInvitation('retry@example.test');
    const transaction = await registrationTransaction();
    await service.acceptInvitation(
      invitation.invitationCode,
      'retry@example.test',
      transaction.transactionToken,
      state,
    );
    expect(mailer.messages).toHaveLength(0);
    mailer.fail = false;
    await service.resendVerification('retry@example.test', transaction.transactionToken, state);
    expect(mailer.messages).toHaveLength(1);
    const invalidatedToken = mailer.lastToken();
    await service.resendVerification('retry@example.test', transaction.transactionToken, state);
    const token = mailer.lastToken();
    expect(token).not.toBe(invalidatedToken);
    await expect(
      service.confirmEmail(invalidatedToken, transaction.transactionToken, state),
    ).rejects.toBeTruthy();
    await expect(
      service.confirmEmail(token, transaction.transactionToken, state),
    ).resolves.toHaveProperty('enrollmentToken');
    const unknownTransaction = await registrationTransaction();
    await expect(
      service.resendVerification(
        'unknown@example.test',
        unknownTransaction.transactionToken,
        state,
      ),
    ).resolves.toBeUndefined();
  });

  it('resumes interrupted enrollment without account enumeration', async () => {
    const original = await verifiedEnrollment('resume@example.test');
    const before = mailer.messages.length;
    await service.resumeOnboarding(
      'resume@example.test',
      original.transaction.transactionToken,
      state,
    );
    expect(mailer.messages.length).toBe(before + 1);
    expect(mailer.lastToken()).toHaveLength(43);
    const unknownTransaction = await registrationTransaction();
    await expect(
      service.resumeOnboarding('unknown@example.test', unknownTransaction.transactionToken, state),
    ).resolves.toBeUndefined();
  });

  it('enforces the registration state machine, state binding, and one-time challenge', async () => {
    const { enrollmentToken, transaction } = await verifiedEnrollment();
    await expect(
      service.registrationOptions({
        enrollmentToken,
        transactionToken: transaction.transactionToken,
        state: 'x'.repeat(43),
      }),
    ).rejects.toBeTruthy();
    const setup = await service.registrationOptions({
      enrollmentToken,
      transactionToken: transaction.transactionToken,
      state,
    });
    await expect(
      service.registrationOptions({
        enrollmentToken,
        transactionToken: transaction.transactionToken,
        state,
      }),
    ).rejects.toBeTruthy();
    const verified = await service.verifyRegistration({
      ceremonyToken: setup.ceremonyToken,
      transactionToken: transaction.transactionToken,
      state,
      response: registrationResponse,
    });
    await expect(
      service.verifyRegistration({
        ceremonyToken: setup.ceremonyToken,
        transactionToken: transaction.transactionToken,
        state,
        response: registrationResponse,
      }),
    ).rejects.toBeTruthy();
    expect(verified.redirectUrl).toContain('code=');
    expect(verified.redirectUrl).toContain('state=');
  });

  it('rejects expired WebAuthn challenges and non-allowlisted callback profiles', async () => {
    await expect(
      service.startNativeAuth({
        clientId: 'babylon-flutter',
        returnProfile: 'not-allowlisted',
        pkceChallenge: pkce,
        state,
        operation: 'register',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    const { enrollmentToken, transaction } = await verifiedEnrollment();
    const setup = await service.registrationOptions({
      enrollmentToken,
      transactionToken: transaction.transactionToken,
      state,
    });
    clock.advance(config.challengeTtlSeconds + 1);
    await expect(
      service.verifyRegistration({
        ceremonyToken: setup.ceremonyToken,
        transactionToken: transaction.transactionToken,
        state,
        response: registrationResponse,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects invalid WebAuthn registration and authentication verification', async () => {
    const { enrollmentToken, transaction } = await verifiedEnrollment();
    const setup = await service.registrationOptions({
      enrollmentToken,
      transactionToken: transaction.transactionToken,
      state,
    });
    webauthn.rejectRegistration = true;
    await expect(
      service.verifyRegistration({
        ceremonyToken: setup.ceremonyToken,
        transactionToken: transaction.transactionToken,
        state,
        response: registrationResponse,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects invalid origin, RP ID, signature, challenge, or UV verifier failures generically', async () => {
    await registerAndExchange();
    const reasons = ['origin', 'RP ID', 'signature', 'challenge', 'user verification'];
    for (const reason of reasons) {
      const transaction = await service.startNativeAuth({
        clientId: 'babylon-flutter',
        returnProfile: 'desktop-local',
        pkceChallenge: pkce,
        state,
        operation: 'authenticate',
      });
      const setup = await service.authenticationOptions({
        transactionToken: transaction.transactionToken,
        state,
      });
      webauthn.rejectAuthentication = true;
      webauthn.failureReason = reason;
      await expect(
        service.verifyAuthentication({
          ceremonyToken: setup.ceremonyToken,
          transactionToken: transaction.transactionToken,
          state,
          response: authenticationResponse,
        }),
      ).rejects.toMatchObject({
        statusCode: 401,
        message: 'A hitelesítés sikertelen vagy lejárt.',
      });
    }
  });

  it('prevents assigning one credential to two users', async () => {
    await registerAndExchange();
    const { enrollmentToken, transaction } = await verifiedEnrollment('second@example.test');
    const setup = await service.registrationOptions({
      enrollmentToken,
      transactionToken: transaction.transactionToken,
      state,
    });
    await expect(
      service.verifyRegistration({
        ceremonyToken: setup.ceremonyToken,
        transactionToken: transaction.transactionToken,
        state,
        response: registrationResponse,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('registers, exchanges via PKCE, creates a device/session, and persists across service restart', async () => {
    const tokens = await registerAndExchange();
    const me = await service.authenticate(tokens.accessToken);
    expect(me.email).toBe('user@example.test');
    expect(await service.listDevices(me)).toHaveLength(1);
    const storedSecrets = await database.query<{
      access_matches: boolean;
      refresh_matches: boolean;
    }>(
      `SELECT
         EXISTS(SELECT 1 FROM sessions WHERE access_token_hash=$1) access_matches,
         EXISTS(SELECT 1 FROM refresh_tokens WHERE token_hash=$2) refresh_matches`,
      [hash(tokens.accessToken), hash(tokens.refreshToken)],
    );
    expect(storedSecrets.rows[0]).toEqual({ access_matches: true, refresh_matches: true });
    const restarted = new AuthService(
      database,
      config,
      clock,
      new DeterministicRandom(),
      mailer,
      webauthn,
    );
    await expect(restarted.authenticate(tokens.accessToken)).resolves.toMatchObject({
      userId: me.userId,
    });
  });

  it('rejects wrong PKCE, state, client, and replayed return codes', async () => {
    const { enrollmentToken, transaction } = await verifiedEnrollment();
    const setup = await service.registrationOptions({
      enrollmentToken,
      transactionToken: transaction.transactionToken,
      state,
    });
    const verified = await service.verifyRegistration({
      ceremonyToken: setup.ceremonyToken,
      transactionToken: transaction.transactionToken,
      state,
      response: registrationResponse,
    });
    const base = {
      returnCode: verified.returnCode,
      clientId: 'babylon-flutter',
      pkceVerifier: verifier,
      state,
      deviceName: 'Device',
      platform: 'android',
      clientDeviceKey: 'd'.repeat(43),
    };
    await expect(service.exchangeReturnCode({ ...base, clientId: 'other' })).rejects.toBeTruthy();
    await expect(
      service.exchangeReturnCode({ ...base, state: 'x'.repeat(43) }),
    ).rejects.toBeTruthy();
    await expect(
      service.exchangeReturnCode({ ...base, pkceVerifier: 'b'.repeat(64) }),
    ).rejects.toBeTruthy();
    await service.exchangeReturnCode(base);
    await expect(service.exchangeReturnCode(base)).rejects.toBeTruthy();
  });

  it('rejects an expired return code', async () => {
    const { enrollmentToken, transaction } = await verifiedEnrollment();
    const setup = await service.registrationOptions({
      enrollmentToken,
      transactionToken: transaction.transactionToken,
      state,
    });
    const verified = await service.verifyRegistration({
      ceremonyToken: setup.ceremonyToken,
      transactionToken: transaction.transactionToken,
      state,
      response: registrationResponse,
    });
    clock.advance(config.returnCodeTtlSeconds + 1);
    await expect(
      service.exchangeReturnCode({
        returnCode: verified.returnCode,
        clientId: 'babylon-flutter',
        pkceVerifier: verifier,
        state,
        deviceName: 'Device',
        platform: 'android',
        clientDeviceKey: 'd'.repeat(43),
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('allows exactly one parallel return-code exchange', async () => {
    const { enrollmentToken, transaction } = await verifiedEnrollment();
    const setup = await service.registrationOptions({
      enrollmentToken,
      transactionToken: transaction.transactionToken,
      state,
    });
    const verified = await service.verifyRegistration({
      ceremonyToken: setup.ceremonyToken,
      transactionToken: transaction.transactionToken,
      state,
      response: registrationResponse,
    });
    const exchange = (key: string) =>
      service.exchangeReturnCode({
        returnCode: verified.returnCode,
        clientId: 'babylon-flutter',
        pkceVerifier: verifier,
        state,
        deviceName: 'Device',
        platform: 'android',
        clientDeviceKey: key.repeat(43),
      });
    const results = await Promise.allSettled([exchange('a'), exchange('b')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('supports discoverable passkey login with a synchronized zero counter', async () => {
    await registerAndExchange();
    const transaction = await service.startNativeAuth({
      clientId: 'babylon-flutter',
      returnProfile: 'desktop-local',
      pkceChallenge: pkce,
      state,
      operation: 'authenticate',
    });
    const setup = await service.authenticationOptions({
      transactionToken: transaction.transactionToken,
      state,
    });
    webauthn.authenticationResult.newCounter = 0;
    const verified = await service.verifyAuthentication({
      ceremonyToken: setup.ceremonyToken,
      transactionToken: transaction.transactionToken,
      state,
      response: authenticationResponse,
    });
    expect(verified.redirectUrl).toContain('code=');
    await expect(
      service.verifyAuthentication({
        ceremonyToken: setup.ceremonyToken,
        transactionToken: transaction.transactionToken,
        state,
        response: authenticationResponse,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    const counter = await database.query<{ counter: string }>(
      "SELECT counter FROM passkey_credentials WHERE credential_id='credential-1'",
    );
    expect(counter.rows[0]?.counter).toBe('0');
  });

  it('rotates refresh tokens and revokes the family on replay, including concurrent use', async () => {
    const original = await registerAndExchange();
    const rotated = await service.refresh(original.refreshToken);
    await expect(service.authenticate(original.accessToken)).rejects.toBeTruthy();
    await expect(service.authenticate(rotated.accessToken)).resolves.toBeTruthy();
    await expect(service.refresh(original.refreshToken)).rejects.toBeTruthy();
    await expect(service.authenticate(rotated.accessToken)).rejects.toBeTruthy();

    await database.query('TRUNCATE users,invitations,audit_log RESTART IDENTITY CASCADE');
    const second = await registerAndExchange();
    const results = await Promise.allSettled([
      service.refresh(second.refreshToken),
      service.refresh(second.refreshToken),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('logs out and immediately revokes issued access tokens', async () => {
    const tokens = await registerAndExchange();
    const session = await service.authenticate(tokens.accessToken);
    await service.logout(session);
    await expect(service.authenticate(tokens.accessToken)).rejects.toBeTruthy();
  });

  it('rejects expired access and refresh tokens without real waiting', async () => {
    const tokens = await registerAndExchange();
    clock.advance(config.accessTokenTtlSeconds + 1);
    await expect(service.authenticate(tokens.accessToken)).rejects.toMatchObject({
      statusCode: 401,
    });
    const rotated = await service.refresh(tokens.refreshToken);
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
    clock.advance(config.refreshTokenTtlSeconds + 1);
    await expect(service.refresh(rotated.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('renames owned devices, denies other users, and revokes all device sessions immediately', async () => {
    const tokens = await registerAndExchange();
    const session = await service.authenticate(tokens.accessToken);
    await expect(service.renameDevice(session, tokens.deviceId, 'Új név')).resolves.toMatchObject({
      name: 'Új név',
    });
    await expect(
      service.renameDevice(session, '00000000-0000-4000-8000-999999999999', 'Nope'),
    ).rejects.toMatchObject({ statusCode: 404 });
    await service.revokeDevice(session, tokens.deviceId);
    await expect(service.authenticate(tokens.accessToken)).rejects.toBeTruthy();
    await expect(service.refresh(tokens.refreshToken)).rejects.toBeTruthy();
  });

  it('cleans expired transient data but preserves audit entries', async () => {
    await service.createInvitation('cleanup@example.test');
    clock.advance(config.invitationTtlSeconds + 1);
    const counts = await service.cleanup();
    expect(counts.invitations).toBe(1);
    const audit = await database.query<{ count: string }>('SELECT count(*) FROM audit_log');
    expect(Number(audit.rows[0]?.count)).toBeGreaterThan(0);
  });
});
