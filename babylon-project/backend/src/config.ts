import { z } from 'zod';
import type { ReturnProfile } from './types.js';

const positiveInteger = z.coerce.number().int().positive();

const environmentSchema = z
  .object({
    DATABASE_URL: z.url().refine((value) => value.startsWith('postgresql://'), {
      message: 'must be a postgresql:// URL',
    }),
    HTTP_HOST: z.string().min(1).default('0.0.0.0'),
    HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    PUBLIC_BACKEND_URL: z.url(),
    WEBAUTHN_RP_ID: z.string().min(1).max(253),
    WEBAUTHN_ORIGINS: z.string().min(1),
    ACCESS_TOKEN_TTL_SECONDS: positiveInteger.default(900),
    REFRESH_TOKEN_TTL_SECONDS: positiveInteger.default(2_592_000),
    INVITATION_TTL_SECONDS: positiveInteger.default(86_400),
    EMAIL_TOKEN_TTL_SECONDS: positiveInteger.default(900),
    ENROLLMENT_TTL_SECONDS: positiveInteger.default(900),
    CHALLENGE_TTL_SECONDS: positiveInteger.default(300),
    NATIVE_TRANSACTION_TTL_SECONDS: positiveInteger.default(600),
    RETURN_CODE_TTL_SECONDS: positiveInteger.default(120),
    SESSION_INACTIVITY_TTL_SECONDS: positiveInteger.default(604_800),
    FRESH_AUTH_TTL_SECONDS: positiveInteger.default(600),
    RECOVERY_TTL_SECONDS: positiveInteger.default(900),
    RECOVERY_COOLDOWN_SECONDS: positiveInteger.default(300),
    ADMIN_BOOTSTRAP_TOKEN: z.string().min(32).max(512),
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535),
    EMAIL_FROM: z.string().min(3).max(254),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    ALLOWED_CLIENT_ORIGINS: z.string().min(1),
    RETURN_PROFILES_JSON: z.string().min(2),
    CLEANUP_INTERVAL_SECONDS: positiveInteger.default(300),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  })
  .loose();

const returnProfileSchema = z
  .record(
    z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    z
      .object({
        clientId: z.string().min(1).max(80),
        uri: z.url(),
        development: z.boolean(),
      })
      .strict(),
  )
  .refine(
    (profiles) => Object.keys(profiles).length > 0,
    'at least one return profile is required',
  );

export interface Config {
  databaseUrl: string;
  httpHost: string;
  httpPort: number;
  publicBackendUrl: string;
  webauthnRpId: string;
  webauthnOrigins: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  invitationTtlSeconds: number;
  emailTokenTtlSeconds: number;
  enrollmentTtlSeconds: number;
  challengeTtlSeconds: number;
  nativeTransactionTtlSeconds: number;
  returnCodeTtlSeconds: number;
  sessionInactivityTtlSeconds: number;
  freshAuthTtlSeconds: number;
  recoveryTtlSeconds: number;
  recoveryCooldownSeconds: number;
  adminBootstrapToken: string;
  smtpHost: string;
  smtpPort: number;
  emailFrom: string;
  logLevel: string;
  allowedClientOrigins: string[];
  returnProfiles: Record<string, ReturnProfile>;
  cleanupIntervalSeconds: number;
  production: boolean;
}

function commaList(value: string, name: string): string[] {
  const items = [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (items.length === 0) throw new Error(`${name} must contain at least one value`);
  return items;
}

function validateUrlPolicies(config: Config): void {
  const publicUrl = new URL(config.publicBackendUrl);
  const loopbackNames = new Set(['localhost', '127.0.0.1', '::1']);
  const isLoopback = loopbackNames.has(publicUrl.hostname);
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    throw new Error('PUBLIC_BACKEND_URL must be an origin without path, query, or fragment');
  }
  if (
    publicUrl.hostname !== config.webauthnRpId &&
    !publicUrl.hostname.endsWith(`.${config.webauthnRpId}`)
  ) {
    throw new Error('WEBAUTHN_RP_ID must be the backend host or its registrable parent domain');
  }
  if (config.production && publicUrl.protocol !== 'https:') {
    throw new Error('PUBLIC_BACKEND_URL must use HTTPS in production');
  }
  if (publicUrl.protocol !== 'https:' && !(publicUrl.protocol === 'http:' && isLoopback)) {
    throw new Error('HTTP is allowed only for localhost or loopback development');
  }
  for (const [name, values] of [
    ['WEBAUTHN_ORIGINS', config.webauthnOrigins],
    ['ALLOWED_CLIENT_ORIGINS', config.allowedClientOrigins],
  ] as const) {
    for (const value of values) {
      const origin = new URL(value);
      if (value !== origin.origin) throw new Error(`${name} values must be exact origins`);
      if (
        name === 'WEBAUTHN_ORIGINS' &&
        origin.hostname !== config.webauthnRpId &&
        !origin.hostname.endsWith(`.${config.webauthnRpId}`)
      ) {
        throw new Error('WEBAUTHN_ORIGINS hosts must match WEBAUTHN_RP_ID');
      }
      if (
        origin.protocol !== 'https:' &&
        !(origin.protocol === 'http:' && !config.production && loopbackNames.has(origin.hostname))
      ) {
        throw new Error(`${name} values must use HTTPS outside loopback development`);
      }
    }
  }
  for (const [name, profile] of Object.entries(config.returnProfiles)) {
    const uri = new URL(profile.uri);
    const loopback = loopbackNames.has(uri.hostname);
    if (
      uri.protocol !== 'https:' &&
      !(profile.development && uri.protocol === 'http:' && loopback)
    ) {
      throw new Error(
        `return profile ${name} must use HTTPS or explicit loopback development HTTP`,
      );
    }
    if (config.production && (profile.development || uri.protocol !== 'https:')) {
      throw new Error(`return profile ${name} is not production-safe`);
    }
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv): Config {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const names = parsed.error.issues
      .map((issue) => issue.path.join('.') || 'environment')
      .join(', ');
    throw new Error(`Invalid configuration: ${names}`);
  }
  let returnProfiles: Record<string, ReturnProfile>;
  try {
    returnProfiles = returnProfileSchema.parse(JSON.parse(parsed.data.RETURN_PROFILES_JSON));
  } catch {
    throw new Error('Invalid configuration: RETURN_PROFILES_JSON');
  }
  const config: Config = {
    databaseUrl: parsed.data.DATABASE_URL,
    httpHost: parsed.data.HTTP_HOST,
    httpPort: parsed.data.HTTP_PORT,
    publicBackendUrl: parsed.data.PUBLIC_BACKEND_URL.replace(/\/$/, ''),
    webauthnRpId: parsed.data.WEBAUTHN_RP_ID,
    webauthnOrigins: commaList(parsed.data.WEBAUTHN_ORIGINS, 'WEBAUTHN_ORIGINS'),
    accessTokenTtlSeconds: parsed.data.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: parsed.data.REFRESH_TOKEN_TTL_SECONDS,
    invitationTtlSeconds: parsed.data.INVITATION_TTL_SECONDS,
    emailTokenTtlSeconds: parsed.data.EMAIL_TOKEN_TTL_SECONDS,
    enrollmentTtlSeconds: parsed.data.ENROLLMENT_TTL_SECONDS,
    challengeTtlSeconds: parsed.data.CHALLENGE_TTL_SECONDS,
    nativeTransactionTtlSeconds: parsed.data.NATIVE_TRANSACTION_TTL_SECONDS,
    returnCodeTtlSeconds: parsed.data.RETURN_CODE_TTL_SECONDS,
    sessionInactivityTtlSeconds: parsed.data.SESSION_INACTIVITY_TTL_SECONDS,
    freshAuthTtlSeconds: parsed.data.FRESH_AUTH_TTL_SECONDS,
    recoveryTtlSeconds: parsed.data.RECOVERY_TTL_SECONDS,
    recoveryCooldownSeconds: parsed.data.RECOVERY_COOLDOWN_SECONDS,
    adminBootstrapToken: parsed.data.ADMIN_BOOTSTRAP_TOKEN,
    smtpHost: parsed.data.SMTP_HOST,
    smtpPort: parsed.data.SMTP_PORT,
    emailFrom: parsed.data.EMAIL_FROM,
    logLevel: parsed.data.LOG_LEVEL,
    allowedClientOrigins: commaList(parsed.data.ALLOWED_CLIENT_ORIGINS, 'ALLOWED_CLIENT_ORIGINS'),
    returnProfiles,
    cleanupIntervalSeconds: parsed.data.CLEANUP_INTERVAL_SECONDS,
    production: parsed.data.NODE_ENV === 'production',
  };
  validateUrlPolicies(config);
  return config;
}
