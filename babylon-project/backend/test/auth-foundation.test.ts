import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth-service.js';
import { PostgresDatabase } from '../src/database.js';
import { runMigrations } from '../src/migrations.js';
import {
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

describeDatabase('advanced authentication foundation', () => {
  const database = new PostgresDatabase(databaseUrl ?? 'postgresql://unused');
  const config = testConfig(databaseUrl ?? 'postgresql://unused');
  let clock: FakeClock;
  let random: DeterministicRandom;
  let mailer: MemoryMailer;
  let service: AuthService;

  beforeAll(async () => {
    await runMigrations(
      database,
      resolve(dirname(fileURLToPath(import.meta.url)), '../migrations'),
    );
  });

  beforeEach(async () => {
    await database.query(
      'TRUNCATE abuse_counters,users,invitations,audit_log RESTART IDENTITY CASCADE',
    );
    clock = new FakeClock();
    random = new DeterministicRandom();
    mailer = new MemoryMailer();
    service = new AuthService(database, config, clock, random, mailer, new FakeWebAuthn());
  });

  afterAll(async () => database.close());

  async function activeSession(email = 'foundation@example.test') {
    const transaction = await service.startNativeAuth({
      clientId: 'babylon-flutter',
      returnProfile: 'desktop-local',
      pkceChallenge: pkce,
      state,
      operation: 'register',
    });
    const invitation = await service.createInvitation(email);
    await service.acceptInvitation(
      invitation.invitationCode,
      email,
      transaction.transactionToken,
      state,
    );
    const confirmation = await service.confirmEmail(
      mailer.lastToken(),
      transaction.transactionToken,
      state,
    );
    const options = await service.registrationOptions({
      enrollmentToken: confirmation.enrollmentToken,
      transactionToken: transaction.transactionToken,
      state,
    });
    const verified = await service.verifyRegistration({
      ceremonyToken: options.ceremonyToken,
      transactionToken: transaction.transactionToken,
      state,
      response: registrationResponse,
    });
    const tokens = await service.exchangeReturnCode({
      returnCode: verified.returnCode,
      clientId: 'babylon-flutter',
      pkceVerifier: verifier,
      state,
      deviceName: 'Foundation device',
      platform: 'windows',
      clientDeviceKey: 'foundation-device-key-is-long-enough-000000',
    });
    return { tokens, session: await service.authenticate(tokens.accessToken) };
  }

  it('models identity, assurance, session metadata and user-managed revocation', async () => {
    const { session, tokens } = await activeSession();
    expect(session.assuranceLevel).toBe('aal2');
    expect(session.authenticationMethod).toBe('webauthn_uv');
    const identities = await database.query(
      `SELECT type,verified_at FROM identities WHERE user_id=$1`,
      [session.userId],
    );
    expect(identities.rows).toHaveLength(1);
    expect(identities.rows[0]?.type).toBe('email');
    expect(identities.rows[0]?.verified_at).toBeTruthy();
    const sessions = await service.listSessions(session);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ current: true, assuranceLevel: 'aal2' });
    expect(await service.revokeSessions(session, 'others')).toEqual({ revoked: 0 });
    await service.revokeSession(session, session.sessionId);
    await expect(service.authenticate(tokens.accessToken)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('rate-limits session and device activity writes during authentication', async () => {
    const { session, tokens } = await activeSession('activity@example.test');
    const readActivity = async () => {
      const result = await database.query<{
        session_last_used_at: Date;
        device_last_used_at: Date;
      }>(
        `SELECT s.last_used_at session_last_used_at,d.last_used_at device_last_used_at
         FROM sessions s JOIN devices d ON d.id=s.device_id WHERE s.id=$1`,
        [session.sessionId],
      );
      return result.rows[0]!;
    };

    const initial = await readActivity();
    clock.advance(29);
    await service.authenticate(tokens.accessToken);
    const beforeBoundary = await readActivity();
    expect(beforeBoundary.session_last_used_at).toEqual(initial.session_last_used_at);
    expect(beforeBoundary.device_last_used_at).toEqual(initial.device_last_used_at);

    clock.advance(1);
    const expected = clock.now();
    await service.authenticate(tokens.accessToken);
    const atBoundary = await readActivity();
    expect(atBoundary.session_last_used_at).toEqual(expected);
    expect(atBoundary.device_last_used_at).toEqual(expected);
  });

  it('exposes passkey metadata and protects the last active credential', async () => {
    const { session } = await activeSession();
    const passkeys = await service.listPasskeys(session);
    expect(passkeys).toHaveLength(1);
    expect(passkeys[0]).toMatchObject({
      name: 'Passkey',
      backedUp: true,
      backupEligible: true,
      revoked: false,
    });
    const id = passkeys[0]?.id as string;
    await service.renamePasskey(session, id, 'Laptop passkey');
    expect((await service.listPasskeys(session))[0]).toMatchObject({ name: 'Laptop passkey' });
    await expect(service.revokePasskey(session, id)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
  });

  it('requires e-mail transaction plus one-time code for recovery and revokes sessions', async () => {
    const { session, tokens } = await activeSession('recover@example.test');
    const generated = await service.regenerateRecoveryCodes(session);
    expect(generated.codes).toHaveLength(10);
    await service.startRecovery('recover@example.test');
    const message = mailer.messages.at(-1)?.text ?? '';
    const recoveryToken = /token:\n([^\n]+)/.exec(message)?.[1];
    expect(recoveryToken).toBeTruthy();
    const transaction = await service.startNativeAuth({
      clientId: 'babylon-flutter',
      returnProfile: 'desktop-local',
      pkceChallenge: pkce,
      state: 'r'.repeat(43),
      operation: 'register',
    });
    const completed = await service.completeRecovery({
      email: 'recover@example.test',
      recoveryToken: recoveryToken!,
      recoveryCode: generated.codes[0]!,
      transactionToken: transaction.transactionToken,
      state: 'r'.repeat(43),
    });
    expect(completed.enrollmentToken).toHaveLength(43);
    await expect(service.authenticate(tokens.accessToken)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      service.completeRecovery({
        email: 'recover@example.test',
        recoveryToken: recoveryToken!,
        recoveryCode: generated.codes[0]!,
        transactionToken: transaction.transactionToken,
        state: 'r'.repeat(43),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const event = await database.query(
      `SELECT event_type FROM security_events WHERE subject_user_id=$1 AND event_type='recovery.completed'`,
      [session.userId],
    );
    expect(event.rowCount).toBe(1);
  });

  it('enforces lifecycle transitions and globally invalidates existing sessions', async () => {
    const { session, tokens } = await activeSession();
    await service.transitionUserStatus(session.userId, 'suspended', 'security review');
    await expect(service.authenticate(tokens.accessToken)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await service.transitionUserStatus(session.userId, 'active', 'review completed');
    await expect(service.authenticate(tokens.accessToken)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    const events = await database.query<{ event_type: string }>(
      `SELECT event_type FROM security_events WHERE subject_user_id=$1 ORDER BY id`,
      [session.userId],
    );
    expect(events.rows.map((row) => row.event_type)).toContain('account.suspended');
  });

  it('applies account-keyed cooldown without permanent lockout', async () => {
    await service.checkAbuse('recovery-email', 'user@example.test', {
      max: 2,
      windowSeconds: 60,
      cooldownSeconds: 30,
    });
    await service.checkAbuse('recovery-email', 'user@example.test', {
      max: 2,
      windowSeconds: 60,
      cooldownSeconds: 30,
    });
    await expect(
      service.checkAbuse('recovery-email', 'user@example.test', {
        max: 2,
        windowSeconds: 60,
        cooldownSeconds: 30,
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    clock.advance(61);
    await service.checkAbuse('recovery-email', 'user@example.test', {
      max: 2,
      windowSeconds: 60,
      cooldownSeconds: 30,
    });
  });

  it('keeps security events immutable', async () => {
    const { session } = await activeSession();
    await expect(
      database.query(`UPDATE security_events SET outcome='failure' WHERE subject_user_id=$1`, [
        session.userId,
      ]),
    ).rejects.toThrow(/append-only/);
  });
});
