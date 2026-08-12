import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { addSeconds, hash, pkceChallenge } from './crypto.js';
import { conflict, forbidden, invalidRequest, notFound, unauthorized } from './errors.js';
import type { Clock, Database, Mailer, Queryable, RandomSource } from './types.js';
import type { WebAuthnProvider } from './webauthn.js';

interface InvitationRow extends QueryResultRow {
  id: string;
  email: string;
  expires_at: Date;
  consumed_at: Date | null;
}

interface UserRow extends QueryResultRow {
  id: string;
  email: string;
  status: string;
  email_verified_at: Date | null;
}

interface TokenRow extends QueryResultRow {
  id: string;
  user_id: string;
  expires_at: Date;
  consumed_at: Date | null;
  invalidated_at: Date | null;
  transaction_id: string | null;
}

interface TransactionRow extends QueryResultRow {
  id: string;
  client_id: string;
  return_profile: string;
  pkce_challenge: string;
  operation: 'register' | 'authenticate';
  user_id: string | null;
  expires_at: Date;
  completed_at: Date | null;
  exchanged_at: Date | null;
  state_hash: Buffer;
}

interface ChallengeRow extends QueryResultRow {
  id: string;
  transaction_id: string;
  user_id: string | null;
  operation: 'registration' | 'authentication';
  challenge: string;
  expires_at: Date;
  consumed_at: Date | null;
}

interface CredentialRow extends QueryResultRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[];
  device_type: 'singleDevice' | 'multiDevice';
  backed_up: boolean;
  revoked_at: Date | null;
}

interface ReturnCodeRow extends QueryResultRow {
  id: string;
  transaction_id: string;
  user_id: string;
  client_id: string;
  return_profile: string;
  operation: 'register' | 'authenticate';
  pkce_challenge: string;
  state_hash: Buffer;
  expires_at: Date;
  consumed_at: Date | null;
}

interface AccessRow extends QueryResultRow {
  session_id: string;
  user_id: string;
  email: string;
  device_id: string;
  device_name: string;
  platform: string;
  access_expires_at: Date;
  session_expires_at: Date;
  session_revoked_at: Date | null;
  device_revoked_at: Date | null;
  family_revoked_at: Date | null;
}

interface RefreshRow extends QueryResultRow {
  id: string;
  family_id: string;
  session_id: string;
  user_id: string;
  device_id: string;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
  family_revoked_at: Date | null;
  session_revoked_at: Date | null;
  device_revoked_at: Date | null;
}

interface DeviceRow extends QueryResultRow {
  id: string;
  name: string;
  platform: string;
  created_at: Date;
  last_used_at: Date;
  revoked_at: Date | null;
  current?: boolean;
}

const emailSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.email().max(254),
);
const pkceSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
const challengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/);

function requireActive(expiresAt: Date, consumedAt: Date | null, now: Date): void {
  if (consumedAt || expiresAt <= now) throw unauthorized();
}

function sameHash(actual: Buffer, raw: string): boolean {
  return actual.equals(hash(raw));
}

function deviceView(row: DeviceRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at.toISOString(),
    revoked: row.revoked_at !== null,
    ...(row.current === undefined ? {} : { current: row.current }),
  };
}

export interface RequestContext {
  requestId?: string;
}

export interface AuthenticatedSession {
  sessionId: string;
  userId: string;
  email: string;
  deviceId: string;
  deviceName: string;
  platform: string;
}

export class AuthService {
  constructor(
    private readonly database: Database,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly random: RandomSource,
    private readonly mailer: Mailer,
    private readonly webauthn: WebAuthnProvider,
  ) {}

  private async audit(
    queryable: Queryable,
    eventType: string,
    context: RequestContext,
    fields: {
      actorUserId?: string;
      subjectUserId?: string;
      deviceId?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    await queryable.query(
      `INSERT INTO audit_log
       (occurred_at, event_type, actor_user_id, subject_user_id, device_id, request_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        this.clock.now(),
        eventType,
        fields.actorUserId ?? null,
        fields.subjectUserId ?? null,
        fields.deviceId ?? null,
        context.requestId ?? null,
        fields.metadata ?? {},
      ],
    );
  }

  async createInvitation(
    emailInput: string,
    context: RequestContext = {},
  ): Promise<{
    invitationCode: string;
    expiresAt: string;
  }> {
    const email = emailSchema.parse(emailInput);
    const raw = this.random.token();
    const now = this.clock.now();
    const expiresAt = addSeconds(now, this.config.invitationTtlSeconds);
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO invitations(email, token_hash, created_by, created_at, expires_at)
         VALUES ($1,$2,'bootstrap-admin',$3,$4)`,
        [email, hash(raw), now, expiresAt],
      );
      await this.audit(client, 'invitation.created', context, { metadata: { email } });
    });
    return { invitationCode: raw, expiresAt: expiresAt.toISOString() };
  }

  async acceptInvitation(
    invitationCode: string,
    emailInput: string,
    transactionToken: string,
    state: string,
    context: RequestContext = {},
  ): Promise<{ status: 'verification_required' }> {
    const email = emailSchema.parse(emailInput);
    const verificationToken = this.random.token();
    const now = this.clock.now();
    const user = await this.database.transaction(async (client) => {
      const transaction = await this.lockedTransaction(client, transactionToken, 'register', now);
      if (
        !sameHash(transaction.state_hash, state) ||
        transaction.completed_at ||
        transaction.user_id
      ) {
        throw unauthorized();
      }
      const invitationResult = await client.query<InvitationRow>(
        'SELECT id,email,expires_at,consumed_at FROM invitations WHERE token_hash=$1 FOR UPDATE',
        [hash(invitationCode)],
      );
      const invitation = invitationResult.rows[0];
      if (invitation?.email !== email) throw unauthorized();
      requireActive(invitation.expires_at, invitation.consumed_at, now);
      const inserted = await client.query<UserRow>(
        `INSERT INTO users(email,status,created_at,updated_at)
         VALUES ($1,'pending_email',$2,$2)
         ON CONFLICT (email) DO NOTHING RETURNING id,email,status,email_verified_at`,
        [email, now],
      );
      const createdUser = inserted.rows[0];
      if (!createdUser) throw conflict('A meghívó nem használható fel.');
      await client.query('UPDATE invitations SET consumed_at=$1, consumed_by=$2 WHERE id=$3', [
        now,
        createdUser.id,
        invitation.id,
      ]);
      await client.query('UPDATE native_auth_transactions SET user_id=$1 WHERE id=$2', [
        createdUser.id,
        transaction.id,
      ]);
      await this.replaceEmailToken(client, createdUser.id, transaction.id, verificationToken, now);
      await this.audit(client, 'invitation.consumed', context, { subjectUserId: createdUser.id });
      return createdUser;
    });
    await this.trySendVerification(user, verificationToken, transactionToken, state, context);
    return { status: 'verification_required' };
  }

  private async replaceEmailToken(
    client: PoolClient,
    userId: string,
    transactionId: string,
    rawToken: string,
    now: Date,
  ): Promise<void> {
    await client.query(
      `UPDATE email_verification_tokens SET invalidated_at=$1
       WHERE user_id=$2 AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [now, userId],
    );
    await client.query(
      `INSERT INTO email_verification_tokens(user_id,transaction_id,token_hash,created_at,expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        userId,
        transactionId,
        hash(rawToken),
        now,
        addSeconds(now, this.config.emailTokenTtlSeconds),
      ],
    );
  }

  private async trySendVerification(
    user: Pick<UserRow, 'id' | 'email'>,
    rawToken: string,
    transactionToken: string,
    state: string,
    context: RequestContext,
  ): Promise<void> {
    try {
      const fragment = new URLSearchParams({
        token: rawToken,
        transaction: transactionToken,
        state,
      });
      const link = `${this.config.publicBackendUrl}/verify-email#${fragment.toString()}`;
      await this.mailer.send({
        to: user.email,
        subject: 'Erősítsd meg a Babylon e-mail-címedet',
        text: `Üdv a Babylonban!\n\nAz e-mail-címed megerősítéséhez nyisd meg ezt a hivatkozást:\n${link}\n\nA hivatkozás rövid ideig és csak egyszer használható.`,
      });
      await this.audit(this.database, 'email_verification.sent', context, {
        subjectUserId: user.id,
      });
    } catch {
      await this.audit(this.database, 'email_verification.delivery_failed', context, {
        subjectUserId: user.id,
      });
    }
  }

  async resendVerification(
    emailInput: string,
    transactionToken: string,
    state: string,
    context: RequestContext = {},
  ): Promise<void> {
    const email = emailSchema.parse(emailInput);
    const rawToken = this.random.token();
    const now = this.clock.now();
    const user = await this.database.transaction(async (client) => {
      const transaction = await this.lockedTransaction(client, transactionToken, 'register', now);
      if (!sameHash(transaction.state_hash, state) || transaction.completed_at)
        throw unauthorized();
      const result = await client.query<UserRow>(
        `SELECT id,email,status,email_verified_at FROM users
         WHERE email=$1 AND status='pending_email' FOR UPDATE`,
        [email],
      );
      const found = result.rows[0];
      if (!found) return null;
      if (transaction.user_id && transaction.user_id !== found.id) return null;
      await client.query('UPDATE native_auth_transactions SET user_id=$1 WHERE id=$2', [
        found.id,
        transaction.id,
      ]);
      await this.replaceEmailToken(client, found.id, transaction.id, rawToken, now);
      return found;
    });
    if (user) await this.trySendVerification(user, rawToken, transactionToken, state, context);
  }

  async confirmEmail(
    token: string,
    transactionToken: string,
    state: string,
    context: RequestContext = {},
  ): Promise<{
    enrollmentToken: string;
    expiresAt: string;
  }> {
    const enrollmentToken = this.random.token();
    const now = this.clock.now();
    const expiresAt = addSeconds(now, this.config.enrollmentTtlSeconds);
    await this.database.transaction(async (client) => {
      const transaction = await this.lockedTransaction(client, transactionToken, 'register', now);
      if (!sameHash(transaction.state_hash, state) || transaction.completed_at)
        throw unauthorized();
      const result = await client.query<TokenRow>(
        `SELECT id,user_id,transaction_id,expires_at,consumed_at,invalidated_at
         FROM email_verification_tokens WHERE token_hash=$1 FOR UPDATE`,
        [hash(token)],
      );
      const row = result.rows[0];
      if (!row || row.invalidated_at || row.transaction_id !== transaction.id) throw unauthorized();
      requireActive(row.expires_at, row.consumed_at, now);
      await client.query('UPDATE email_verification_tokens SET consumed_at=$1 WHERE id=$2', [
        now,
        row.id,
      ]);
      await client.query(
        `UPDATE users SET status='email_verified',email_verified_at=$1,updated_at=$1
         WHERE id=$2 AND status='pending_email'`,
        [now, row.user_id],
      );
      await this.replaceEnrollmentGrant(
        client,
        row.user_id,
        transaction.id,
        enrollmentToken,
        now,
        expiresAt,
      );
      await this.audit(client, 'email_verification.confirmed', context, {
        subjectUserId: row.user_id,
      });
    });
    return { enrollmentToken, expiresAt: expiresAt.toISOString() };
  }

  private async replaceEnrollmentGrant(
    client: PoolClient,
    userId: string,
    transactionId: string,
    rawToken: string,
    now: Date,
    expiresAt = addSeconds(now, this.config.enrollmentTtlSeconds),
  ): Promise<void> {
    await client.query(
      `UPDATE enrollment_grants SET invalidated_at=$1
       WHERE user_id=$2 AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [now, userId],
    );
    await client.query(
      `INSERT INTO enrollment_grants(user_id,transaction_id,token_hash,created_at,expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [userId, transactionId, hash(rawToken), now, expiresAt],
    );
  }

  async resumeOnboarding(
    emailInput: string,
    transactionToken: string,
    state: string,
    context: RequestContext = {},
  ): Promise<void> {
    const email = emailSchema.parse(emailInput);
    const enrollmentToken = this.random.token();
    const now = this.clock.now();
    const user = await this.database.transaction(async (client) => {
      const transaction = await this.lockedTransaction(client, transactionToken, 'register', now);
      if (!sameHash(transaction.state_hash, state) || transaction.completed_at)
        throw unauthorized();
      const result = await client.query<UserRow>(
        `SELECT u.id,u.email,u.status,u.email_verified_at FROM users u
         WHERE u.email=$1 AND u.status='email_verified'
         AND NOT EXISTS (SELECT 1 FROM passkey_credentials p WHERE p.user_id=u.id AND p.revoked_at IS NULL)
         FOR UPDATE`,
        [email],
      );
      const found = result.rows[0];
      if (!found) return null;
      if (transaction.user_id && transaction.user_id !== found.id) return null;
      await client.query('UPDATE native_auth_transactions SET user_id=$1 WHERE id=$2', [
        found.id,
        transaction.id,
      ]);
      await this.replaceEnrollmentGrant(client, found.id, transaction.id, enrollmentToken, now);
      return found;
    });
    if (!user) return;
    try {
      const fragment = new URLSearchParams({
        enrollment: enrollmentToken,
        transaction: transactionToken,
        state,
      });
      const link = `${this.config.publicBackendUrl}/auth/register#${fragment.toString()}`;
      await this.mailer.send({
        to: user.email,
        subject: 'Folytasd a Babylon passkey beállítását',
        text: `A Babylon-regisztráció folytatásához nyisd meg ezt a hivatkozást:\n${link}\n\nA hivatkozás rövid ideig és csak egyszer használható.`,
      });
      await this.audit(this.database, 'onboarding.resume_sent', context, {
        subjectUserId: user.id,
      });
    } catch {
      await this.audit(this.database, 'onboarding.resume_delivery_failed', context, {
        subjectUserId: user.id,
      });
    }
  }

  async startNativeAuth(input: {
    clientId: string;
    returnProfile: string;
    pkceChallenge: string;
    state: string;
    operation: 'register' | 'authenticate';
  }): Promise<{ transactionToken: string; browserUrl: string; expiresAt: string }> {
    challengeSchema.parse(input.pkceChallenge);
    stateSchema.parse(input.state);
    const profile = this.config.returnProfiles[input.returnProfile];
    if (profile?.clientId !== input.clientId) throw invalidRequest('Ismeretlen kliensprofil.');
    const transactionToken = this.random.token();
    const now = this.clock.now();
    const expiresAt = addSeconds(now, this.config.nativeTransactionTtlSeconds);
    await this.database.query(
      `INSERT INTO native_auth_transactions
       (token_hash,client_id,return_profile,pkce_challenge,state_hash,operation,created_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        hash(transactionToken),
        input.clientId,
        input.returnProfile,
        input.pkceChallenge,
        hash(input.state),
        input.operation,
        now,
        expiresAt,
      ],
    );
    const fragment = new URLSearchParams({ transaction: transactionToken, state: input.state });
    return {
      transactionToken,
      browserUrl: `${this.config.publicBackendUrl}/auth/${input.operation}#${fragment.toString()}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async lockedTransaction(
    client: PoolClient,
    rawToken: string,
    operation: 'register' | 'authenticate',
    now: Date,
  ): Promise<TransactionRow> {
    const result = await client.query<TransactionRow>(
      'SELECT * FROM native_auth_transactions WHERE token_hash=$1 FOR UPDATE',
      [hash(rawToken)],
    );
    const transaction = result.rows[0];
    if (
      transaction?.operation !== operation ||
      transaction.expires_at <= now ||
      transaction.exchanged_at
    ) {
      throw unauthorized();
    }
    return transaction;
  }

  async registrationOptions(input: {
    enrollmentToken: string;
    transactionToken: string;
    state: string;
  }): Promise<{ ceremonyToken: string; options: PublicKeyCredentialCreationOptionsJSON }> {
    const now = this.clock.now();
    stateSchema.parse(input.state);
    const prepared = await this.database.transaction(async (client) => {
      const transaction = await this.lockedTransaction(
        client,
        input.transactionToken,
        'register',
        now,
      );
      if (!sameHash(transaction.state_hash, input.state) || transaction.completed_at)
        throw unauthorized();
      const grantResult = await client.query<TokenRow>(
        `SELECT id,user_id,transaction_id,expires_at,consumed_at,invalidated_at
         FROM enrollment_grants WHERE token_hash=$1 FOR UPDATE`,
        [hash(input.enrollmentToken)],
      );
      const grant = grantResult.rows[0];
      if (!grant || grant.invalidated_at || grant.transaction_id !== transaction.id) {
        throw unauthorized();
      }
      requireActive(grant.expires_at, grant.consumed_at, now);
      const userResult = await client.query<UserRow>(
        `SELECT id,email,status,email_verified_at FROM users WHERE id=$1 AND status='email_verified'`,
        [grant.user_id],
      );
      const user = userResult.rows[0];
      if (!user) throw conflict();
      const credentials = await client.query<{ credential_id: string }>(
        'SELECT credential_id FROM passkey_credentials WHERE user_id=$1 AND revoked_at IS NULL',
        [user.id],
      );
      await client.query('UPDATE enrollment_grants SET consumed_at=$1 WHERE id=$2', [
        now,
        grant.id,
      ]);
      await client.query('UPDATE native_auth_transactions SET user_id=$1 WHERE id=$2', [
        user.id,
        transaction.id,
      ]);
      return {
        transactionId: transaction.id,
        user,
        credentialIds: credentials.rows.map((row) => row.credential_id),
      };
    });
    const options = await this.webauthn.registrationOptions({
      userId: prepared.user.id,
      email: prepared.user.email,
      existingCredentialIds: prepared.credentialIds,
    });
    const ceremonyToken = this.random.token();
    await this.database.query(
      `INSERT INTO webauthn_challenges
       (token_hash,transaction_id,user_id,operation,challenge,created_at,expires_at)
       VALUES ($1,$2,$3,'registration',$4,$5,$6)`,
      [
        hash(ceremonyToken),
        prepared.transactionId,
        prepared.user.id,
        options.challenge,
        now,
        addSeconds(now, this.config.challengeTtlSeconds),
      ],
    );
    return { ceremonyToken, options };
  }

  async authenticationOptions(input: {
    transactionToken: string;
    state: string;
  }): Promise<{ ceremonyToken: string; options: PublicKeyCredentialRequestOptionsJSON }> {
    const now = this.clock.now();
    stateSchema.parse(input.state);
    const transaction = await this.database.transaction(async (client) => {
      const row = await this.lockedTransaction(client, input.transactionToken, 'authenticate', now);
      if (!sameHash(row.state_hash, input.state) || row.completed_at) throw unauthorized();
      return row;
    });
    const options = await this.webauthn.authenticationOptions();
    const ceremonyToken = this.random.token();
    await this.database.query(
      `INSERT INTO webauthn_challenges
       (token_hash,transaction_id,operation,challenge,created_at,expires_at)
       VALUES ($1,$2,'authentication',$3,$4,$5)`,
      [
        hash(ceremonyToken),
        transaction.id,
        options.challenge,
        now,
        addSeconds(now, this.config.challengeTtlSeconds),
      ],
    );
    return { ceremonyToken, options };
  }

  private async getChallenge(
    ceremonyToken: string,
    operation: 'registration' | 'authentication',
    now: Date,
  ): Promise<ChallengeRow> {
    const result = await this.database.query<ChallengeRow>(
      'SELECT * FROM webauthn_challenges WHERE token_hash=$1 AND operation=$2',
      [hash(ceremonyToken), operation],
    );
    const challenge = result.rows[0];
    if (!challenge) throw unauthorized();
    requireActive(challenge.expires_at, challenge.consumed_at, now);
    return challenge;
  }

  private async issueReturnCode(
    client: PoolClient,
    transaction: TransactionRow,
    userId: string,
    state: string,
    context: RequestContext,
  ): Promise<{ returnCode: string; redirectUrl: string; expiresAt: string }> {
    if (!sameHash(transaction.state_hash, state)) throw unauthorized();
    const returnCode = this.random.token();
    const now = this.clock.now();
    const expiresAt = addSeconds(now, this.config.returnCodeTtlSeconds);
    await client.query(
      `INSERT INTO app_return_codes
       (transaction_id,user_id,client_id,return_profile,operation,pkce_challenge,state_hash,
        code_hash,created_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        transaction.id,
        userId,
        transaction.client_id,
        transaction.return_profile,
        transaction.operation,
        transaction.pkce_challenge,
        transaction.state_hash,
        hash(returnCode),
        now,
        expiresAt,
      ],
    );
    await client.query(
      'UPDATE native_auth_transactions SET completed_at=$1,user_id=$2 WHERE id=$3',
      [now, userId, transaction.id],
    );
    await this.audit(client, `passkey.${transaction.operation}_verified`, context, {
      subjectUserId: userId,
    });
    const profile = this.config.returnProfiles[transaction.return_profile];
    if (!profile) throw new Error('Configured return profile disappeared');
    const redirect = new URL(profile.uri);
    redirect.searchParams.set('code', returnCode);
    redirect.searchParams.set('state', state);
    return { returnCode, redirectUrl: redirect.toString(), expiresAt: expiresAt.toISOString() };
  }

  async verifyRegistration(
    input: {
      ceremonyToken: string;
      transactionToken: string;
      state: string;
      response: RegistrationResponseJSON;
    },
    context: RequestContext = {},
  ): Promise<{ returnCode: string; redirectUrl: string; expiresAt: string }> {
    const now = this.clock.now();
    const challenge = await this.getChallenge(input.ceremonyToken, 'registration', now);
    let verified;
    try {
      verified = await this.webauthn.verifyRegistration(input.response, challenge.challenge);
    } catch {
      throw unauthorized();
    }
    return this.database.transaction(async (client) => {
      const lockedChallenge = await client.query<ChallengeRow>(
        'SELECT * FROM webauthn_challenges WHERE id=$1 FOR UPDATE',
        [challenge.id],
      );
      const current = lockedChallenge.rows[0];
      if (!current) throw unauthorized();
      requireActive(current.expires_at, current.consumed_at, now);
      const transaction = await this.lockedTransaction(
        client,
        input.transactionToken,
        'register',
        now,
      );
      if (transaction.id !== current.transaction_id || transaction.user_id !== current.user_id) {
        throw unauthorized();
      }
      await client.query('UPDATE webauthn_challenges SET consumed_at=$1 WHERE id=$2', [
        now,
        current.id,
      ]);
      try {
        await client.query(
          `INSERT INTO passkey_credentials
           (user_id,credential_id,public_key,counter,transports,device_type,backed_up,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            current.user_id,
            verified.credentialId,
            Buffer.from(verified.publicKey),
            verified.counter,
            JSON.stringify(verified.transports),
            verified.deviceType,
            verified.backedUp,
            now,
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw conflict('Ez a passkey már regisztrálva van.');
        throw error;
      }
      await client.query("UPDATE users SET status='active',updated_at=$1 WHERE id=$2", [
        now,
        current.user_id,
      ]);
      if (!current.user_id) throw unauthorized();
      return this.issueReturnCode(client, transaction, current.user_id, input.state, context);
    });
  }

  async verifyAuthentication(
    input: {
      ceremonyToken: string;
      transactionToken: string;
      state: string;
      response: AuthenticationResponseJSON;
    },
    context: RequestContext = {},
  ): Promise<{ returnCode: string; redirectUrl: string; expiresAt: string }> {
    const now = this.clock.now();
    const challenge = await this.getChallenge(input.ceremonyToken, 'authentication', now);
    const credentialResult = await this.database.query<CredentialRow>(
      `SELECT * FROM passkey_credentials WHERE credential_id=$1 AND revoked_at IS NULL`,
      [input.response.id],
    );
    const credential = credentialResult.rows[0];
    if (!credential) throw unauthorized();
    const webauthnCredential: WebAuthnCredential = {
      id: credential.credential_id,
      publicKey: new Uint8Array(credential.public_key),
      counter: Number(credential.counter),
      ...(credential.transports.length > 0
        ? { transports: credential.transports as NonNullable<WebAuthnCredential['transports']> }
        : {}),
    };
    let verified;
    try {
      verified = await this.webauthn.verifyAuthentication(
        input.response,
        challenge.challenge,
        webauthnCredential,
      );
    } catch {
      throw unauthorized();
    }
    return this.database.transaction(async (client) => {
      const challengeResult = await client.query<ChallengeRow>(
        'SELECT * FROM webauthn_challenges WHERE id=$1 FOR UPDATE',
        [challenge.id],
      );
      const current = challengeResult.rows[0];
      if (!current) throw unauthorized();
      requireActive(current.expires_at, current.consumed_at, now);
      const transaction = await this.lockedTransaction(
        client,
        input.transactionToken,
        'authenticate',
        now,
      );
      if (transaction.id !== current.transaction_id) throw unauthorized();
      const lockedCredential = await client.query<CredentialRow>(
        'SELECT * FROM passkey_credentials WHERE id=$1 FOR UPDATE',
        [credential.id],
      );
      const stored = lockedCredential.rows[0];
      if (!stored || stored.revoked_at) throw unauthorized();
      const oldCounter = Number(stored.counter);
      await client.query(
        `UPDATE passkey_credentials SET counter=$1,last_used_at=$2,device_type=$3,backed_up=$4 WHERE id=$5`,
        [verified.newCounter, now, verified.deviceType, verified.backedUp, stored.id],
      );
      if (oldCounter > 0 && verified.newCounter <= oldCounter) {
        await this.audit(client, 'passkey.counter_suspicious', context, {
          subjectUserId: stored.user_id,
          metadata: { credentialId: stored.id, oldCounter, newCounter: verified.newCounter },
        });
      }
      await client.query('UPDATE webauthn_challenges SET consumed_at=$1,user_id=$2 WHERE id=$3', [
        now,
        stored.user_id,
        current.id,
      ]);
      return this.issueReturnCode(client, transaction, stored.user_id, input.state, context);
    });
  }

  async exchangeReturnCode(
    input: {
      returnCode: string;
      clientId: string;
      pkceVerifier: string;
      state: string;
      deviceName: string;
      platform: string;
      clientDeviceKey: string;
    },
    context: RequestContext = {},
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    pkceSchema.parse(input.pkceVerifier);
    stateSchema.parse(input.state);
    const deviceName = z.string().trim().min(1).max(80).parse(input.deviceName);
    const platform = z.string().trim().min(1).max(32).parse(input.platform);
    const clientDeviceKey = z.string().min(32).max(512).parse(input.clientDeviceKey);
    const accessToken = this.random.token();
    const refreshToken = this.random.token(48);
    const now = this.clock.now();
    await this.database.transaction(async (client) => {
      const result = await client.query<ReturnCodeRow>(
        'SELECT * FROM app_return_codes WHERE code_hash=$1 FOR UPDATE',
        [hash(input.returnCode)],
      );
      const code = result.rows[0];
      if (code?.client_id !== input.clientId || !sameHash(code.state_hash, input.state)) {
        throw unauthorized();
      }
      requireActive(code.expires_at, code.consumed_at, now);
      if (pkceChallenge(input.pkceVerifier) !== code.pkce_challenge) throw unauthorized();
      const transactionResult = await client.query<TransactionRow>(
        'SELECT * FROM native_auth_transactions WHERE id=$1 FOR UPDATE',
        [code.transaction_id],
      );
      const transaction = transactionResult.rows[0];
      if (!transaction || transaction.exchanged_at || transaction.expires_at <= now)
        throw unauthorized();
      const deviceHash = hash(clientDeviceKey);
      const deviceResult = await client.query<{ id: string; revoked_at: Date | null }>(
        `INSERT INTO devices(user_id,name,platform,client_device_key_hash,created_at,last_used_at)
         VALUES ($1,$2,$3,$4,$5,$5)
         ON CONFLICT (user_id,client_device_key_hash) DO UPDATE
         SET name=EXCLUDED.name,platform=EXCLUDED.platform,last_used_at=EXCLUDED.last_used_at
         WHERE devices.revoked_at IS NULL
         RETURNING id,revoked_at`,
        [code.user_id, deviceName, platform, deviceHash, now],
      );
      const device = deviceResult.rows[0];
      if (!device || device.revoked_at) throw forbidden();
      const familyId = this.random.uuid();
      const sessionId = this.random.uuid();
      const refreshExpiresAt = addSeconds(now, this.config.refreshTokenTtlSeconds);
      await client.query(
        `INSERT INTO refresh_token_families(id,user_id,device_id,created_at) VALUES ($1,$2,$3,$4)`,
        [familyId, code.user_id, device.id, now],
      );
      await client.query(
        `INSERT INTO sessions
         (id,user_id,device_id,family_id,access_token_hash,access_expires_at,created_at,last_used_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8)`,
        [
          sessionId,
          code.user_id,
          device.id,
          familyId,
          hash(accessToken),
          addSeconds(now, this.config.accessTokenTtlSeconds),
          now,
          refreshExpiresAt,
        ],
      );
      await client.query(
        `INSERT INTO refresh_tokens(family_id,session_id,token_hash,created_at,expires_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [familyId, sessionId, hash(refreshToken), now, refreshExpiresAt],
      );
      await client.query('UPDATE app_return_codes SET consumed_at=$1 WHERE id=$2', [now, code.id]);
      await client.query('UPDATE native_auth_transactions SET exchanged_at=$1 WHERE id=$2', [
        now,
        transaction.id,
      ]);
      await this.audit(client, 'session.created', context, {
        actorUserId: code.user_id,
        subjectUserId: code.user_id,
        deviceId: device.id,
      });
    });
    return { accessToken, refreshToken, expiresIn: this.config.accessTokenTtlSeconds };
  }

  async authenticate(accessToken: string): Promise<AuthenticatedSession> {
    const result = await this.database.query<AccessRow>(
      `SELECT s.id session_id,s.user_id,u.email,s.device_id,d.name device_name,d.platform,
              s.access_expires_at,s.expires_at session_expires_at,s.revoked_at session_revoked_at,
              d.revoked_at device_revoked_at,f.revoked_at family_revoked_at
       FROM sessions s JOIN users u ON u.id=s.user_id JOIN devices d ON d.id=s.device_id
       JOIN refresh_token_families f ON f.id=s.family_id
       WHERE s.access_token_hash=$1`,
      [hash(accessToken)],
    );
    const row = result.rows[0];
    const now = this.clock.now();
    if (
      !row ||
      row.access_expires_at <= now ||
      row.session_expires_at <= now ||
      row.session_revoked_at ||
      row.device_revoked_at ||
      row.family_revoked_at
    ) {
      throw unauthorized();
    }
    await this.database.transaction(async (client) => {
      await client.query('UPDATE sessions SET last_used_at=$1 WHERE id=$2', [now, row.session_id]);
      await client.query('UPDATE devices SET last_used_at=$1 WHERE id=$2', [now, row.device_id]);
    });
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      email: row.email,
      deviceId: row.device_id,
      deviceName: row.device_name,
      platform: row.platform,
    };
  }

  async refresh(
    rawToken: string,
    context: RequestContext = {},
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    const newAccess = this.random.token();
    const newRefresh = this.random.token(48);
    const now = this.clock.now();
    const result = await this.database.transaction(async (client) => {
      const tokenResult = await client.query<RefreshRow>(
        `SELECT r.*,f.user_id,f.device_id,f.revoked_at family_revoked_at,
                s.revoked_at session_revoked_at,d.revoked_at device_revoked_at
         FROM refresh_tokens r JOIN refresh_token_families f ON f.id=r.family_id
         JOIN sessions s ON s.id=r.session_id JOIN devices d ON d.id=f.device_id
         WHERE r.token_hash=$1 FOR UPDATE OF r,f,s,d`,
        [hash(rawToken)],
      );
      const token = tokenResult.rows[0];
      if (!token) return { status: 'invalid' as const };
      if (token.used_at || token.revoked_at) {
        await client.query(
          `UPDATE refresh_token_families
           SET revoked_at=COALESCE(revoked_at,$1),replay_detected_at=$1 WHERE id=$2`,
          [now, token.family_id],
        );
        await client.query(
          'UPDATE sessions SET revoked_at=COALESCE(revoked_at,$1) WHERE family_id=$2',
          [now, token.family_id],
        );
        await client.query(
          'UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,$1) WHERE family_id=$2',
          [now, token.family_id],
        );
        await this.audit(client, 'refresh_token.replay_detected', context, {
          subjectUserId: token.user_id,
          deviceId: token.device_id,
        });
        return { status: 'replay' as const };
      }
      if (
        token.expires_at <= now ||
        token.family_revoked_at ||
        token.session_revoked_at ||
        token.device_revoked_at
      ) {
        return { status: 'invalid' as const };
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO refresh_tokens(family_id,session_id,token_hash,created_at,expires_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [token.family_id, token.session_id, hash(newRefresh), now, token.expires_at],
      );
      const newTokenId = inserted.rows[0]?.id;
      if (!newTokenId) throw new Error('Failed to rotate refresh token');
      await client.query('UPDATE refresh_tokens SET used_at=$1,replaced_by=$2 WHERE id=$3', [
        now,
        newTokenId,
        token.id,
      ]);
      await client.query(
        'UPDATE sessions SET access_token_hash=$1,access_expires_at=$2,last_used_at=$3 WHERE id=$4',
        [
          hash(newAccess),
          addSeconds(now, this.config.accessTokenTtlSeconds),
          now,
          token.session_id,
        ],
      );
      await this.audit(client, 'session.refreshed', context, {
        subjectUserId: token.user_id,
        deviceId: token.device_id,
      });
      return { status: 'ok' as const };
    });
    if (result.status !== 'ok') throw unauthorized();
    return {
      accessToken: newAccess,
      refreshToken: newRefresh,
      expiresIn: this.config.accessTokenTtlSeconds,
    };
  }

  async logout(session: AuthenticatedSession, context: RequestContext = {}): Promise<void> {
    const now = this.clock.now();
    await this.database.transaction(async (client) => {
      await client.query('UPDATE sessions SET revoked_at=COALESCE(revoked_at,$1) WHERE id=$2', [
        now,
        session.sessionId,
      ]);
      await this.audit(client, 'session.logged_out', context, {
        actorUserId: session.userId,
        subjectUserId: session.userId,
        deviceId: session.deviceId,
      });
    });
  }

  async listDevices(session: AuthenticatedSession): Promise<Record<string, unknown>[]> {
    const result = await this.database.query<DeviceRow>(
      `SELECT id,name,platform,created_at,last_used_at,revoked_at,(id=$2) current
       FROM devices WHERE user_id=$1 ORDER BY created_at`,
      [session.userId, session.deviceId],
    );
    return result.rows.map(deviceView);
  }

  async renameDevice(
    session: AuthenticatedSession,
    deviceId: string,
    nameInput: string,
    context: RequestContext = {},
  ): Promise<Record<string, unknown>> {
    const name = z.string().trim().min(1).max(80).parse(nameInput);
    return this.database.transaction(async (client) => {
      const result = await client.query<DeviceRow>(
        `UPDATE devices SET name=$1 WHERE id=$2 AND user_id=$3 AND revoked_at IS NULL
         RETURNING id,name,platform,created_at,last_used_at,revoked_at`,
        [name, deviceId, session.userId],
      );
      const device = result.rows[0];
      if (!device) throw notFound();
      await this.audit(client, 'device.renamed', context, {
        actorUserId: session.userId,
        subjectUserId: session.userId,
        deviceId,
      });
      return deviceView(device);
    });
  }

  async revokeDevice(
    session: AuthenticatedSession,
    deviceId: string,
    context: RequestContext = {},
  ): Promise<{ currentDevice: boolean }> {
    const now = this.clock.now();
    await this.database.transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `UPDATE devices SET revoked_at=$1 WHERE id=$2 AND user_id=$3 AND revoked_at IS NULL RETURNING id`,
        [now, deviceId, session.userId],
      );
      if (!result.rows[0]) throw notFound();
      await client.query(
        'UPDATE sessions SET revoked_at=COALESCE(revoked_at,$1) WHERE device_id=$2',
        [now, deviceId],
      );
      await client.query(
        'UPDATE refresh_token_families SET revoked_at=COALESCE(revoked_at,$1) WHERE device_id=$2',
        [now, deviceId],
      );
      await this.audit(client, 'device.revoked', context, {
        actorUserId: session.userId,
        subjectUserId: session.userId,
        deviceId,
      });
    });
    return { currentDevice: deviceId === session.deviceId };
  }

  async cleanup(): Promise<Record<string, number>> {
    const now = this.clock.now();
    return this.database.transaction(async (client) => {
      const counts: Record<string, number> = {};
      const deletes = [
        ['webauthnChallenges', 'DELETE FROM webauthn_challenges WHERE expires_at < $1'],
        ['returnCodes', 'DELETE FROM app_return_codes WHERE expires_at < $1'],
        ['emailTokens', 'DELETE FROM email_verification_tokens WHERE expires_at < $1'],
        ['enrollmentGrants', 'DELETE FROM enrollment_grants WHERE expires_at < $1'],
        ['refreshTokens', 'DELETE FROM refresh_tokens WHERE expires_at < $1'],
        [
          'sessions',
          `DELETE FROM sessions WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1 - interval '7 days')`,
        ],
        ['nativeTransactions', 'DELETE FROM native_auth_transactions WHERE expires_at < $1'],
        ['invitations', 'DELETE FROM invitations WHERE expires_at < $1 AND consumed_at IS NULL'],
      ] as const;
      for (const [name, sql] of deletes) {
        const result = await client.query(sql, [now]);
        counts[name] = result.rowCount ?? 0;
      }
      return counts;
    });
  }
}
