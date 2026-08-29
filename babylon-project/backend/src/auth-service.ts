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
import { ApiError, conflict, forbidden, invalidRequest, notFound, unauthorized } from './errors.js';
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
  user_status: string;
  user_security_version: string;
  session_security_version: string;
  inactivity_expires_at: Date;
  authenticated_at: Date;
  step_up_at: Date | null;
  assurance_level: 'aal1' | 'aal2' | 'aal3';
  authentication_method: string;
  security_generation: string;
}

interface CachedMutableAccessState {
  generation: string;
  session: AuthenticatedSession;
}

interface CachedAccessValidationRow extends QueryResultRow {
  security_generation: string;
  access_expires_at: Date | null;
  session_expires_at: Date | null;
  inactivity_expires_at: Date | null;
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
  inactivity_expires_at: Date;
  user_status: string;
  user_security_version: string;
  session_security_version: string;
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
  requestId?: string | undefined;
  correlationId?: string | undefined;
  sourceIpHash?: Buffer | undefined;
  userAgentFamily?: string | undefined;
  clientVersion?: string | undefined;
}

export interface AuthenticatedSession {
  sessionId: string;
  userId: string;
  email: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  assuranceLevel: 'aal1' | 'aal2' | 'aal3';
  authenticationMethod: string;
  authenticatedAt: Date;
  stepUpAt: Date | null;
}

export class AuthService {
  private readonly mutableAccessStateByToken = new Map<string, CachedMutableAccessState>();

  constructor(
    private readonly database: Database,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly random: RandomSource,
    private readonly mailer: Mailer,
    private readonly webauthn: WebAuthnProvider,
  ) {}

  private cloneSession(session: AuthenticatedSession): AuthenticatedSession {
    return {
      ...session,
      authenticatedAt: new Date(session.authenticatedAt),
      stepUpAt: session.stepUpAt ? new Date(session.stepUpAt) : null,
    };
  }

  private rememberMutableAccessState(cacheKey: string, state: CachedMutableAccessState): void {
    this.mutableAccessStateByToken.delete(cacheKey);
    this.mutableAccessStateByToken.set(cacheKey, {
      generation: state.generation,
      session: this.cloneSession(state.session),
    });
    if (this.mutableAccessStateByToken.size > 10_000) {
      const oldest = this.mutableAccessStateByToken.keys().next().value;
      if (oldest) this.mutableAccessStateByToken.delete(oldest);
    }
  }

  private async audit(
    queryable: Queryable,
    eventType: string,
    context: RequestContext,
    fields: {
      actorUserId?: string;
      subjectUserId?: string;
      deviceId?: string;
      metadata?: Record<string, unknown>;
      sessionId?: string;
      outcome?: 'success' | 'failure' | 'blocked';
    } = {},
  ): Promise<void> {
    await queryable.query(
      `INSERT INTO audit_log
       (occurred_at,event_type,action,outcome,actor_user_id,subject_user_id,device_id,session_id,
        request_id,correlation_id,security_context,metadata)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        this.clock.now(),
        eventType,
        fields.outcome ?? 'success',
        fields.actorUserId ?? null,
        fields.subjectUserId ?? null,
        fields.deviceId ?? null,
        fields.sessionId ?? null,
        context.requestId ?? null,
        context.correlationId ?? context.requestId ?? null,
        {
          userAgentFamily: context.userAgentFamily,
          clientVersion: context.clientVersion,
        },
        fields.metadata ?? {},
      ],
    );
  }

  private async securityEvent(
    queryable: Queryable,
    eventType: string,
    severity: 'info' | 'low' | 'medium' | 'high' | 'critical',
    outcome: 'success' | 'failure' | 'blocked' | 'detected',
    context: RequestContext,
    fields: {
      actorUserId?: string | undefined;
      subjectUserId?: string | undefined;
      sessionId?: string | undefined;
      deviceId?: string | undefined;
      metadata?: Record<string, unknown>;
      notify?: boolean;
    } = {},
  ): Promise<void> {
    await queryable.query(
      `INSERT INTO security_events
       (occurred_at,event_type,severity,outcome,actor_user_id,subject_user_id,session_id,device_id,
        request_id,correlation_id,source_ip_hash,metadata,notification_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        this.clock.now(),
        eventType,
        severity,
        outcome,
        fields.actorUserId ?? null,
        fields.subjectUserId ?? null,
        fields.sessionId ?? null,
        fields.deviceId ?? null,
        context.requestId ?? null,
        context.correlationId ?? context.requestId ?? null,
        context.sourceIpHash ?? null,
        fields.metadata ?? {},
        fields.notify ? 'pending' : 'not_required',
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
         VALUES ($1,'pending_verification',$2,$2)
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
      await client.query(
        `INSERT INTO identities(user_id,type,issuer,subject,normalized_subject,created_at)
         VALUES ($1,'email','babylon',$2,$2,$3) ON CONFLICT DO NOTHING`,
        [createdUser.id, email, now],
      );
      await this.replaceEmailToken(client, createdUser.id, transaction.id, verificationToken, now);
      await this.audit(client, 'invitation.consumed', context, { subjectUserId: createdUser.id });
      await this.securityEvent(client, 'account.invitation_consumed', 'info', 'success', context, {
        subjectUserId: createdUser.id,
      });
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
         WHERE email=$1 AND status='pending_verification' AND email_verified_at IS NULL FOR UPDATE`,
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
        `UPDATE users SET email_verified_at=$1,updated_at=$1
         WHERE id=$2 AND status='pending_verification' AND email_verified_at IS NULL`,
        [now, row.user_id],
      );
      await client.query(
        `UPDATE identities SET verified_at=$1,last_used_at=$1
         WHERE user_id=$2 AND type='email'`,
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
         WHERE u.email=$1 AND u.status='pending_verification' AND u.email_verified_at IS NOT NULL
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
        `SELECT id,email,status,email_verified_at FROM users
         WHERE id=$1 AND status IN ('pending_verification','active') AND email_verified_at IS NOT NULL`,
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
           (user_id,credential_id,public_key,counter,transports,device_type,backed_up,
            backup_eligible,authenticator_attachment,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)`,
          [
            current.user_id,
            verified.credentialId,
            Buffer.from(verified.publicKey),
            verified.counter,
            JSON.stringify(verified.transports),
            verified.deviceType,
            verified.backedUp,
            input.response.authenticatorAttachment ?? null,
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
      await this.securityEvent(client, 'passkey.created', 'medium', 'success', context, {
        subjectUserId: current.user_id ?? undefined,
        notify: true,
      });
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
        await client.query(
          `UPDATE passkey_credentials
           SET compromise_suspected_at=COALESCE(compromise_suspected_at,$1) WHERE id=$2`,
          [now, stored.id],
        );
        await this.audit(client, 'passkey.counter_suspicious', context, {
          subjectUserId: stored.user_id,
          metadata: { credentialId: stored.id, oldCounter, newCounter: verified.newCounter },
        });
        await this.securityEvent(
          client,
          'passkey.counter_suspicious',
          'high',
          'detected',
          context,
          {
            subjectUserId: stored.user_id,
            metadata: { credentialId: stored.id, oldCounter, newCounter: verified.newCounter },
            notify: true,
          },
        );
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
         (id,user_id,device_id,family_id,access_token_hash,access_expires_at,created_at,last_used_at,
          last_refreshed_at,inactivity_expires_at,expires_at,authentication_method,assurance_level,
          authenticated_at,step_up_at,ip_prefix_hash,user_agent_family,client_version,security_version)
         SELECT $1,$2,$3,$4,$5,$6,$7,$7,$7,$8,$9,'webauthn_uv','aal2',$7,$7,$10,$11,$12,
                security_version FROM users WHERE id=$2`,
        [
          sessionId,
          code.user_id,
          device.id,
          familyId,
          hash(accessToken),
          addSeconds(now, this.config.accessTokenTtlSeconds),
          now,
          addSeconds(now, this.config.sessionInactivityTtlSeconds),
          refreshExpiresAt,
          context.sourceIpHash ?? null,
          context.userAgentFamily ?? null,
          context.clientVersion ?? null,
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
      await this.securityEvent(client, 'login.succeeded', 'info', 'success', context, {
        actorUserId: code.user_id,
        subjectUserId: code.user_id,
        sessionId,
        deviceId: device.id,
      });
    });
    return { accessToken, refreshToken, expiresIn: this.config.accessTokenTtlSeconds };
  }

  async authenticate(accessToken: string): Promise<AuthenticatedSession> {
    const accessTokenHash = hash(accessToken);
    const cacheKey = accessTokenHash.toString('hex');
    const now = this.clock.now();
    const cached = this.mutableAccessStateByToken.get(cacheKey);
    if (cached) {
      const validation = await this.database.query<CachedAccessValidationRow>(
        `SELECT g.generation::text security_generation,
                s.access_expires_at,s.expires_at session_expires_at,s.inactivity_expires_at
         FROM auth_security_generation g
         LEFT JOIN sessions s ON s.id=$1 AND s.access_token_hash=$2
         WHERE g.singleton=true`,
        [cached.session.sessionId, accessTokenHash],
      );
      const current = validation.rows[0];
      if (
        current?.security_generation === cached.generation &&
        current.access_expires_at &&
        current.access_expires_at > now &&
        current.session_expires_at &&
        current.session_expires_at > now &&
        current.inactivity_expires_at &&
        current.inactivity_expires_at > now
      ) {
        await this.database.transaction(async (client) => {
          await client.query('UPDATE sessions SET last_used_at=$1 WHERE id=$2', [
            now,
            cached.session.sessionId,
          ]);
          await client.query('UPDATE devices SET last_used_at=$1 WHERE id=$2', [
            now,
            cached.session.deviceId,
          ]);
        });
        return this.cloneSession(cached.session);
      }
      if (current?.security_generation !== cached.generation) {
        this.mutableAccessStateByToken.clear();
      } else {
        this.mutableAccessStateByToken.delete(cacheKey);
      }
    }

    const result = await this.database.query<AccessRow>(
      `SELECT s.id session_id,s.user_id,u.email,u.status user_status,
              u.security_version user_security_version,s.security_version session_security_version,
              s.device_id,d.name device_name,d.platform,
              s.access_expires_at,s.expires_at session_expires_at,s.revoked_at session_revoked_at,
              s.inactivity_expires_at,s.authenticated_at,s.step_up_at,s.assurance_level,
              s.authentication_method,d.revoked_at device_revoked_at,f.revoked_at family_revoked_at,
              g.generation::text security_generation
       FROM sessions s JOIN users u ON u.id=s.user_id JOIN devices d ON d.id=s.device_id
       JOIN refresh_token_families f ON f.id=s.family_id
       CROSS JOIN auth_security_generation g
       WHERE s.access_token_hash=$1`,
      [accessTokenHash],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.access_expires_at <= now ||
      row.session_expires_at <= now ||
      row.inactivity_expires_at <= now ||
      row.user_status !== 'active' ||
      row.user_security_version !== row.session_security_version ||
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
    const session: AuthenticatedSession = {
      sessionId: row.session_id,
      userId: row.user_id,
      email: row.email,
      deviceId: row.device_id,
      deviceName: row.device_name,
      platform: row.platform,
      assuranceLevel: row.assurance_level,
      authenticationMethod: row.authentication_method,
      authenticatedAt: row.authenticated_at,
      stepUpAt: row.step_up_at,
    };
    this.rememberMutableAccessState(cacheKey, {
      generation: row.security_generation,
      session,
    });
    return this.cloneSession(session);
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
                s.revoked_at session_revoked_at,s.inactivity_expires_at,
                s.security_version session_security_version,u.security_version user_security_version,
                u.status user_status,d.revoked_at device_revoked_at
         FROM refresh_tokens r JOIN refresh_token_families f ON f.id=r.family_id
         JOIN sessions s ON s.id=r.session_id JOIN devices d ON d.id=f.device_id
         JOIN users u ON u.id=f.user_id
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
        await this.securityEvent(client, 'token.replay_detected', 'critical', 'detected', context, {
          subjectUserId: token.user_id,
          sessionId: token.session_id,
          deviceId: token.device_id,
          notify: true,
        });
        return { status: 'replay' as const };
      }
      if (
        token.expires_at <= now ||
        token.inactivity_expires_at <= now ||
        token.user_status !== 'active' ||
        token.user_security_version !== token.session_security_version ||
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
        `UPDATE sessions SET access_token_hash=$1,access_expires_at=$2,last_used_at=$3,
         last_refreshed_at=$3,inactivity_expires_at=$4 WHERE id=$5`,
        [
          hash(newAccess),
          addSeconds(now, this.config.accessTokenTtlSeconds),
          now,
          addSeconds(now, this.config.sessionInactivityTtlSeconds),
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

  private requireFresh(session: AuthenticatedSession): void {
    const reference = session.stepUpAt ?? session.authenticatedAt;
    if (
      session.assuranceLevel === 'aal1' ||
      reference.getTime() + this.config.freshAuthTtlSeconds * 1000 <= this.clock.now().getTime()
    ) {
      throw forbidden();
    }
  }

  async listSessions(session: AuthenticatedSession): Promise<Record<string, unknown>[]> {
    const result = await this.database.query<{
      id: string;
      device_id: string;
      device_name: string;
      platform: string;
      created_at: Date;
      last_used_at: Date;
      last_refreshed_at: Date;
      expires_at: Date;
      inactivity_expires_at: Date;
      assurance_level: string;
      authentication_method: string;
      revoked_at: Date | null;
      revoked_reason: string | null;
    }>(
      `SELECT s.id,s.device_id,d.name device_name,d.platform,s.created_at,s.last_used_at,
              s.last_refreshed_at,s.expires_at,s.inactivity_expires_at,s.assurance_level,
              s.authentication_method,s.revoked_at,s.revoked_reason
       FROM sessions s JOIN devices d ON d.id=s.device_id
       WHERE s.user_id=$1 ORDER BY s.created_at DESC`,
      [session.userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      deviceId: row.device_id,
      deviceName: row.device_name,
      platform: row.platform,
      current: row.id === session.sessionId,
      createdAt: row.created_at.toISOString(),
      lastUsedAt: row.last_used_at.toISOString(),
      lastRefreshedAt: row.last_refreshed_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      inactivityExpiresAt: row.inactivity_expires_at.toISOString(),
      assuranceLevel: row.assurance_level,
      authenticationMethod: row.authentication_method,
      revoked: row.revoked_at !== null,
      revokedReason: row.revoked_reason,
    }));
  }

  async revokeSession(
    session: AuthenticatedSession,
    sessionId: string,
    context: RequestContext = {},
  ): Promise<{ current: boolean }> {
    const now = this.clock.now();
    await this.database.transaction(async (client) => {
      const result = await client.query<{ id: string; device_id: string }>(
        `UPDATE sessions SET revoked_at=COALESCE(revoked_at,$1),revoked_reason='user_revoked'
         WHERE id=$2 AND user_id=$3 RETURNING id,device_id`,
        [now, sessionId, session.userId],
      );
      const revoked = result.rows[0];
      if (!revoked) throw notFound();
      await this.audit(client, 'session.revoked', context, {
        actorUserId: session.userId,
        subjectUserId: session.userId,
        sessionId,
        deviceId: revoked.device_id,
      });
      await this.securityEvent(client, 'session.revoked', 'medium', 'success', context, {
        actorUserId: session.userId,
        subjectUserId: session.userId,
        sessionId,
        deviceId: revoked.device_id,
      });
    });
    return { current: sessionId === session.sessionId };
  }

  async revokeSessions(
    session: AuthenticatedSession,
    mode: 'others' | 'all',
    context: RequestContext = {},
  ): Promise<{ revoked: number }> {
    this.requireFresh(session);
    const now = this.clock.now();
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE sessions SET revoked_at=COALESCE(revoked_at,$1),revoked_reason=$2
         WHERE user_id=$3 AND revoked_at IS NULL AND ($4::boolean OR id<>$5)`,
        [
          now,
          mode === 'all' ? 'user_revoked_all' : 'user_revoked_others',
          session.userId,
          mode === 'all',
          session.sessionId,
        ],
      );
      await this.audit(client, `session.${mode}_revoked`, context, {
        actorUserId: session.userId,
        subjectUserId: session.userId,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        metadata: { count: result.rowCount ?? 0 },
      });
      await this.securityEvent(client, 'session.bulk_revoked', 'high', 'success', context, {
        actorUserId: session.userId,
        subjectUserId: session.userId,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        metadata: { mode, count: result.rowCount ?? 0 },
        notify: true,
      });
      return { revoked: result.rowCount ?? 0 };
    });
  }

  async listPasskeys(session: AuthenticatedSession): Promise<Record<string, unknown>[]> {
    const result = await this.database.query<{
      id: string;
      name: string;
      transports: string[];
      device_type: string;
      backed_up: boolean;
      backup_eligible: boolean;
      authenticator_attachment: string | null;
      created_at: Date;
      last_used_at: Date | null;
      revoked_at: Date | null;
      compromise_suspected_at: Date | null;
    }>(
      `SELECT id,name,transports,device_type,backed_up,backup_eligible,authenticator_attachment,
              created_at,last_used_at,revoked_at,compromise_suspected_at
       FROM passkey_credentials WHERE user_id=$1 ORDER BY created_at`,
      [session.userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      transports: row.transports,
      deviceType: row.device_type,
      backedUp: row.backed_up,
      backupEligible: row.backup_eligible,
      authenticatorAttachment: row.authenticator_attachment,
      createdAt: row.created_at.toISOString(),
      lastUsedAt: row.last_used_at?.toISOString() ?? null,
      revoked: row.revoked_at !== null,
      compromiseSuspected: row.compromise_suspected_at !== null,
    }));
  }

  async preparePasskeyAddition(
    session: AuthenticatedSession,
    transactionToken: string,
    state: string,
    context: RequestContext = {},
  ): Promise<{ enrollmentToken: string; expiresAt: string }> {
    this.requireFresh(session);
    stateSchema.parse(state);
    const now = this.clock.now();
    const enrollmentToken = this.random.token();
    const expiresAt = addSeconds(now, this.config.enrollmentTtlSeconds);
    await this.database.transaction(async (client) => {
      const transaction = await this.lockedTransaction(client, transactionToken, 'register', now);
      if (!sameHash(transaction.state_hash, state) || transaction.completed_at)
        throw unauthorized();
      await client.query('UPDATE native_auth_transactions SET user_id=$1 WHERE id=$2', [
        session.userId,
        transaction.id,
      ]);
      await this.replaceEnrollmentGrant(
        client,
        session.userId,
        transaction.id,
        enrollmentToken,
        now,
        expiresAt,
      );
      await this.audit(client, 'passkey.addition_started', context, {
        actorUserId: session.userId,
        subjectUserId: session.userId,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
      });
    });
    return { enrollmentToken, expiresAt: expiresAt.toISOString() };
  }

  async renamePasskey(
    session: AuthenticatedSession,
    credentialId: string,
    nameInput: string,
    context: RequestContext = {},
  ): Promise<void> {
    const name = z.string().trim().min(1).max(80).parse(nameInput);
    const result = await this.database.query(
      `UPDATE passkey_credentials SET name=$1 WHERE id=$2 AND user_id=$3 AND revoked_at IS NULL`,
      [name, credentialId, session.userId],
    );
    if (!result.rowCount) throw notFound();
    await this.audit(this.database, 'passkey.renamed', context, {
      actorUserId: session.userId,
      subjectUserId: session.userId,
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      metadata: { credentialId },
    });
  }

  async revokePasskey(
    session: AuthenticatedSession,
    credentialId: string,
    context: RequestContext = {},
  ): Promise<void> {
    this.requireFresh(session);
    const now = this.clock.now();
    await this.database.transaction(async (client) => {
      const active = await client.query<{ id: string }>(
        `SELECT id FROM passkey_credentials
         WHERE user_id=$1 AND revoked_at IS NULL FOR UPDATE`,
        [session.userId],
      );
      if (active.rows.length <= 1) throw conflict('Az utolsó aktív passkey nem vonható vissza.');
      const result = await client.query(
        `UPDATE passkey_credentials SET revoked_at=$1,revoked_reason='user_revoked'
         WHERE id=$2 AND user_id=$3 AND revoked_at IS NULL`,
        [now, credentialId, session.userId],
      );
      if (!result.rowCount) throw notFound();
      await this.audit(client, 'passkey.revoked', context, {
        actorUserId: session.userId,
        subjectUserId: session.userId,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        metadata: { credentialId },
      });
      await this.securityEvent(client, 'passkey.revoked', 'high', 'success', context, {
        actorUserId: session.userId,
        subjectUserId: session.userId,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        notify: true,
      });
    });
  }

  async regenerateRecoveryCodes(
    session: AuthenticatedSession,
    context: RequestContext = {},
  ): Promise<{ codes: string[] }> {
    this.requireFresh(session);
    const now = this.clock.now();
    const codes = Array.from({ length: 10 }, () => this.random.token(18));
    await this.database.transaction(async (client) => {
      await client.query(
        `UPDATE recovery_code_sets SET invalidated_at=$1 WHERE user_id=$2 AND invalidated_at IS NULL`,
        [now, session.userId],
      );
      const setId = this.random.uuid();
      await client.query(
        `INSERT INTO recovery_code_sets(id,user_id,created_at,created_by_session_id)
         VALUES ($1,$2,$3,$4)`,
        [setId, session.userId, now, session.sessionId],
      );
      for (const code of codes) {
        await client.query(
          `INSERT INTO recovery_codes(set_id,code_hash,created_at) VALUES ($1,$2,$3)`,
          [setId, hash(`recovery:${code}`), now],
        );
      }
      await this.audit(client, 'recovery.codes_regenerated', context, {
        actorUserId: session.userId,
        subjectUserId: session.userId,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
      });
      await this.securityEvent(client, 'recovery.codes_regenerated', 'high', 'success', context, {
        actorUserId: session.userId,
        subjectUserId: session.userId,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        notify: true,
      });
    });
    return { codes };
  }

  async startRecovery(emailInput: string, context: RequestContext = {}): Promise<void> {
    const email = emailSchema.parse(emailInput);
    const now = this.clock.now();
    const raw = this.random.token();
    const result = await this.database.transaction(async (client) => {
      const user = await client.query<UserRow>(
        `SELECT id,email,status,email_verified_at FROM users
         WHERE email=$1 AND status='active' AND email_verified_at IS NOT NULL FOR UPDATE`,
        [email],
      );
      const found = user.rows[0];
      if (!found) return null;
      const recent = await client.query(
        `SELECT 1 FROM auth_transactions WHERE user_id=$1 AND purpose='recovery'
         AND created_at>$2 AND invalidated_at IS NULL LIMIT 1`,
        [found.id, addSeconds(now, -this.config.recoveryCooldownSeconds)],
      );
      if (recent.rowCount) return null;
      await client.query(
        `UPDATE auth_transactions SET invalidated_at=$1
         WHERE user_id=$2 AND purpose='recovery' AND consumed_at IS NULL AND invalidated_at IS NULL`,
        [now, found.id],
      );
      await client.query(
        `INSERT INTO auth_transactions(token_hash,purpose,user_id,created_at,expires_at)
         VALUES ($1,'recovery',$2,$3,$4)`,
        [
          hash(`recovery-email:${raw}`),
          found.id,
          now,
          addSeconds(now, this.config.recoveryTtlSeconds),
        ],
      );
      return found;
    });
    if (!result) return;
    try {
      await this.mailer.send({
        to: result.email,
        subject: 'Babylon fiók-helyreállítás',
        text: `Helyreállítási kérelmet kaptunk. A rövid életű ellenőrző token:\n${raw}\n\nA folytatáshoz egy korábban elmentett recovery code is szükséges. Ha nem te kérted, hagyd figyelmen kívül.`,
      });
      await this.securityEvent(this.database, 'recovery.started', 'high', 'success', context, {
        subjectUserId: result.id,
        notify: true,
      });
    } catch {
      await this.securityEvent(
        this.database,
        'recovery.delivery_failed',
        'high',
        'failure',
        context,
        {
          subjectUserId: result.id,
        },
      );
    }
  }

  async completeRecovery(
    input: {
      email: string;
      recoveryToken: string;
      recoveryCode: string;
      transactionToken: string;
      state: string;
    },
    context: RequestContext = {},
  ): Promise<{ enrollmentToken: string; expiresAt: string }> {
    const email = emailSchema.parse(input.email);
    stateSchema.parse(input.state);
    const now = this.clock.now();
    const enrollmentToken = this.random.token();
    const expiresAt = addSeconds(now, this.config.enrollmentTtlSeconds);
    return this.database.transaction(async (client) => {
      const recovery = await client.query<{
        id: string;
        user_id: string;
        expires_at: Date;
        consumed_at: Date | null;
        invalidated_at: Date | null;
      }>(
        `SELECT id,user_id,expires_at,consumed_at,invalidated_at FROM auth_transactions
         WHERE token_hash=$1 AND purpose='recovery' FOR UPDATE`,
        [hash(`recovery-email:${input.recoveryToken}`)],
      );
      const tx = recovery.rows[0];
      if (!tx || tx.expires_at <= now || tx.consumed_at || tx.invalidated_at) throw unauthorized();
      const user = await client.query<UserRow>(
        `SELECT id,email,status,email_verified_at FROM users WHERE id=$1 AND email=$2 FOR UPDATE`,
        [tx.user_id, email],
      );
      if (user.rows[0]?.status !== 'active') throw unauthorized();
      const code = await client.query<{ id: string }>(
        `SELECT c.id FROM recovery_codes c JOIN recovery_code_sets s ON s.id=c.set_id
         WHERE s.user_id=$1 AND s.invalidated_at IS NULL AND c.code_hash=$2 AND c.used_at IS NULL
         FOR UPDATE OF c`,
        [tx.user_id, hash(`recovery:${input.recoveryCode}`)],
      );
      if (!code.rows[0]) throw unauthorized();
      const native = await this.lockedTransaction(client, input.transactionToken, 'register', now);
      if (!sameHash(native.state_hash, input.state) || native.completed_at) throw unauthorized();
      await client.query('UPDATE recovery_codes SET used_at=$1 WHERE id=$2', [
        now,
        code.rows[0].id,
      ]);
      await client.query('UPDATE auth_transactions SET consumed_at=$1 WHERE id=$2', [now, tx.id]);
      await client.query('UPDATE native_auth_transactions SET user_id=$1 WHERE id=$2', [
        tx.user_id,
        native.id,
      ]);
      await this.replaceEnrollmentGrant(
        client,
        tx.user_id,
        native.id,
        enrollmentToken,
        now,
        expiresAt,
      );
      await client.query(
        `UPDATE users SET security_version=security_version+1,updated_at=$1 WHERE id=$2`,
        [now, tx.user_id],
      );
      await client.query(
        `UPDATE sessions SET revoked_at=COALESCE(revoked_at,$1),revoked_reason='account_recovery'
         WHERE user_id=$2`,
        [now, tx.user_id],
      );
      await this.audit(client, 'recovery.completed', context, {
        subjectUserId: tx.user_id,
      });
      await this.securityEvent(client, 'recovery.completed', 'critical', 'success', context, {
        subjectUserId: tx.user_id,
        notify: true,
      });
      return { enrollmentToken, expiresAt: expiresAt.toISOString() };
    });
  }

  async transitionUserStatus(
    userId: string,
    target: 'active' | 'suspended' | 'locked' | 'disabled' | 'pending_deletion' | 'tombstoned',
    reason: string,
    context: RequestContext = {},
  ): Promise<void> {
    const allowed: Record<string, string[]> = {
      active: ['suspended', 'locked', 'disabled', 'pending_deletion'],
      suspended: ['active', 'disabled'],
      locked: ['active', 'disabled'],
      disabled: ['active', 'pending_deletion'],
      pending_deletion: ['active', 'tombstoned'],
    };
    const now = this.clock.now();
    await this.database.transaction(async (client) => {
      const current = await client.query<{ status: string }>(
        'SELECT status FROM users WHERE id=$1 FOR UPDATE',
        [userId],
      );
      const status = current.rows[0]?.status;
      if (!status) throw notFound();
      if (!allowed[status]?.includes(target)) throw conflict();
      await client.query(
        `UPDATE users SET status=$1,status_changed_at=$2,status_reason=$3,updated_at=$2,
         security_version=security_version+1,deleted_at=CASE WHEN $1='tombstoned' THEN $2 ELSE deleted_at END
         WHERE id=$4`,
        [target, now, reason, userId],
      );
      await client.query(
        `UPDATE sessions SET revoked_at=COALESCE(revoked_at,$1),revoked_reason='account_status_changed'
         WHERE user_id=$2`,
        [now, userId],
      );
      await this.audit(client, 'account.status_changed', context, {
        subjectUserId: userId,
        metadata: { from: status, to: target, reason },
      });
      await this.securityEvent(client, `account.${target}`, 'high', 'success', context, {
        subjectUserId: userId,
        metadata: { from: status, reason },
        notify: true,
      });
    });
  }

  async listSecurityEvents(session: AuthenticatedSession): Promise<Record<string, unknown>[]> {
    const result = await this.database.query<{
      id: string;
      occurred_at: Date;
      event_type: string;
      severity: string;
      outcome: string;
      request_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT id::text,occurred_at,event_type,severity,outcome,request_id,metadata
       FROM security_events WHERE subject_user_id=$1 ORDER BY occurred_at DESC LIMIT 100`,
      [session.userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at.toISOString(),
      type: row.event_type,
      severity: row.severity,
      outcome: row.outcome,
      requestId: row.request_id,
      metadata: row.metadata,
    }));
  }

  async checkAbuse(
    scope: string,
    key: string,
    limits: { max: number; windowSeconds: number; cooldownSeconds: number },
  ): Promise<void> {
    const now = this.clock.now();
    const keyHash = hash(`abuse:${scope}:${key}`);
    const windowStart = addSeconds(now, -limits.windowSeconds);
    const result = await this.database.transaction(async (client) => {
      const row = await client.query<{
        attempts: number;
        window_started_at: Date;
        blocked_until: Date | null;
      }>(
        'SELECT attempts,window_started_at,blocked_until FROM abuse_counters WHERE scope=$1 AND key_hash=$2 FOR UPDATE',
        [scope, keyHash],
      );
      const current = row.rows[0];
      if (current?.blocked_until && current.blocked_until > now) return false;
      const attempts =
        current && current.window_started_at > windowStart ? current.attempts + 1 : 1;
      const blockedUntil =
        attempts > limits.max
          ? addSeconds(
              now,
              limits.cooldownSeconds * Math.min(8, 2 ** Math.min(3, attempts - limits.max - 1)),
            )
          : null;
      await client.query(
        `INSERT INTO abuse_counters(scope,key_hash,window_started_at,attempts,blocked_until,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT(scope,key_hash) DO UPDATE SET window_started_at=EXCLUDED.window_started_at,
         attempts=EXCLUDED.attempts,blocked_until=EXCLUDED.blocked_until,updated_at=EXCLUDED.updated_at`,
        [
          scope,
          keyHash,
          attempts === 1 ? now : (current?.window_started_at ?? now),
          attempts,
          blockedUntil,
          now,
        ],
      );
      return blockedUntil === null;
    });
    if (!result) throw new ApiError(429, 'RATE_LIMITED', 'Túl sok kérés. Próbáld később.');
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
          `DELETE FROM sessions WHERE expires_at < $1 OR inactivity_expires_at < $1
           OR (revoked_at IS NOT NULL AND revoked_at < $1 - interval '7 days')`,
        ],
        ['authTransactions', 'DELETE FROM auth_transactions WHERE expires_at < $1'],
        [
          'abuseCounters',
          `DELETE FROM abuse_counters WHERE updated_at < $1::timestamptz - interval '7 days'`,
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
