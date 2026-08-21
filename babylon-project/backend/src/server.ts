import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError, type ZodType } from 'zod';
import type { AuthenticatedSession, AuthService } from './auth-service.js';
import type { Config } from './config.js';
import { constantTimeEqual, hash } from './crypto.js';
import { ApiError, conflict, unauthorized } from './errors.js';
import {
  DeliveryConflictError,
  DeliveryNotFoundError,
  MessageDeliveryService,
} from './message-delivery.js';
import type { Database } from './types.js';

const envelope = (data: unknown) => ({ data });
const genericResponse = { status: 'accepted' } as const;

const email = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : value),
  z.email().max(254),
);
const token = z.string().min(32).max(512);
const state = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/);

const registrationResponseSchema = z
  .object({
    id: z.string().min(1).max(2048),
    rawId: z.string().min(1).max(2048),
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: z.string().min(1).max(16_384),
        attestationObject: z.string().min(1).max(65_536),
        transports: z.array(z.string().max(32)).max(16).optional(),
        publicKeyAlgorithm: z.number().int().optional(),
        publicKey: z.string().max(16_384).optional(),
        authenticatorData: z.string().max(16_384).optional(),
      })
      .strict(),
    authenticatorAttachment: z.string().max(32).optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()),
  })
  .strict();

const authenticationResponseSchema = z
  .object({
    id: z.string().min(1).max(2048),
    rawId: z.string().min(1).max(2048),
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: z.string().min(1).max(16_384),
        authenticatorData: z.string().min(1).max(16_384),
        signature: z.string().min(1).max(16_384),
        userHandle: z.string().max(2048).optional(),
      })
      .strict(),
    authenticatorAttachment: z.string().max(32).optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()),
  })
  .strict();

function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ') || header.length <= 7) throw unauthorized();
  return header.slice(7);
}

async function authenticated(
  service: AuthService,
  request: FastifyRequest,
): Promise<AuthenticatedSession> {
  return service.authenticate(bearer(request));
}

function authPage(title: string, operation: 'register' | 'authenticate' | 'verify'): string {
  return `<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/assets/auth.css"></head><body data-operation="${operation}"><main><h1>${title}</h1><p id="status" role="status" aria-live="polite">Előkészítés…</p><button id="action" type="button">Folytatás</button></main><script src="/assets/auth.js" defer></script></body></html>`;
}

function requestContext(request: FastifyRequest) {
  const forwardedCorrelation = request.headers['x-correlation-id'];
  const correlationId =
    typeof forwardedCorrelation === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(forwardedCorrelation)
      ? forwardedCorrelation
      : request.id;
  const ip = request.ip;
  const minimizedIp = ip.includes(':')
    ? ip.split(':').slice(0, 4).join(':')
    : ip.split('.').slice(0, 3).join('.');
  const userAgent = request.headers['user-agent'];
  const clientVersion = request.headers['x-client-version'];
  return {
    requestId: request.id,
    correlationId,
    sourceIpHash: hash(`ip-prefix:${minimizedIp}`),
    userAgentFamily: typeof userAgent === 'string' ? userAgent.slice(0, 120) : undefined,
    clientVersion: typeof clientVersion === 'string' ? clientVersion.slice(0, 40) : undefined,
  };
}

export async function buildServer(input: {
  config: Config;
  database: Database;
  service: AuthService;
  delivery?: MessageDeliveryService;
}): Promise<FastifyInstance> {
  const { config, database, service } = input;
  const delivery = input.delivery;
  const app = Fastify({
    // The transport-v1 envelope accepts a 65,536-byte payload encoded as base64,
    // plus bounded JSON metadata. Keep framework rejection above that contract.
    bodyLimit: 90_112,
    requestTimeout: 30_000,
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'request.headers.authorization',
          'body.token',
          'body.invitationCode',
          'body.enrollmentToken',
          'body.transactionToken',
          'body.ceremonyToken',
          'body.returnCode',
          'body.refreshToken',
          'body.pkceVerifier',
          'body.payload',
        ],
        censor: '[REDACTED]',
      },
    },
    genReqId: (request) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  const allowedOrigins = new Set([
    ...config.allowedClientOrigins,
    new URL(config.publicBackendUrl).origin,
  ]);

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) callback(null, true);
      else callback(new Error('Origin not allowed'), false);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'x-request-id',
      'x-correlation-id',
      'x-client-version',
    ],
    maxAge: 600,
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
  });
  await app.register(rateLimit, { global: false, keyGenerator: (request) => request.ip });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    reply.header('x-correlation-id', requestContext(request).correlationId);
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'A kérés mezői nem érvényesek.',
          requestId: request.id,
        },
      });
    }
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, requestId: request.id },
      });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: 'Túl sok kérés. Próbáld később.',
          requestId: request.id,
        },
      });
    }
    const frameworkStatus = (error as { statusCode?: number }).statusCode;
    if (frameworkStatus && frameworkStatus >= 400 && frameworkStatus < 500) {
      const code = frameworkStatus === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST';
      const message =
        frameworkStatus === 413
          ? 'A kérési törzs legfeljebb 64 KiB lehet.'
          : 'A kérés nem érvényes.';
      return reply.code(frameworkStatus).send({
        error: { code, message, requestId: request.id },
      });
    }
    if (error instanceof Error && error.message === 'Origin not allowed') {
      return reply.code(403).send({
        error: {
          code: 'CORS_DENIED',
          message: 'A kliensorigin nem engedélyezett.',
          requestId: request.id,
        },
      });
    }
    request.log.error({ err: error }, 'Unhandled request error');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Belső szolgáltatáshiba.', requestId: request.id },
    });
  });

  app.get('/health/live', () => envelope({ status: 'live' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await database.query('SELECT 1');
      return envelope({ status: 'ready' });
    } catch {
      return reply
        .code(503)
        .send({ error: { code: 'NOT_READY', message: 'Az adatbázis nem érhető el.' } });
    }
  });

  const sensitiveRate = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/v1/admin/invitations', sensitiveRate, async (request, reply) => {
    const adminToken = bearer(request);
    if (!constantTimeEqual(adminToken, config.adminBootstrapToken)) throw unauthorized();
    const body = parse(z.object({ email }).strict(), request.body);
    const result = await service.createInvitation(body.email, requestContext(request));
    return reply.code(201).send(envelope(result));
  });

  app.post('/api/v1/onboarding/accept-invitation', sensitiveRate, async (request, reply) => {
    const body = parse(
      z.object({ invitationCode: token, email, transactionToken: token, state }).strict(),
      request.body,
    );
    const result = await service.acceptInvitation(
      body.invitationCode,
      body.email,
      body.transactionToken,
      body.state,
      requestContext(request),
    );
    return reply.code(202).send(envelope(result));
  });

  app.post('/api/v1/email-verification/resend', sensitiveRate, async (request, reply) => {
    const body = parse(z.object({ email, transactionToken: token, state }).strict(), request.body);
    await service.resendVerification(
      body.email,
      body.transactionToken,
      body.state,
      requestContext(request),
    );
    return reply.code(202).send(envelope(genericResponse));
  });

  app.post('/api/v1/onboarding/resume', sensitiveRate, async (request, reply) => {
    const body = parse(z.object({ email, transactionToken: token, state }).strict(), request.body);
    await service.resumeOnboarding(
      body.email,
      body.transactionToken,
      body.state,
      requestContext(request),
    );
    return reply.code(202).send(envelope(genericResponse));
  });

  app.post('/api/v1/email-verification/confirm', sensitiveRate, async (request) => {
    const body = parse(z.object({ token, transactionToken: token, state }).strict(), request.body);
    return envelope(
      await service.confirmEmail(
        body.token,
        body.transactionToken,
        body.state,
        requestContext(request),
      ),
    );
  });

  app.post('/api/v1/native-auth/start', sensitiveRate, async (request, reply) => {
    const body = parse(
      z
        .object({
          clientId: z.string().min(1).max(80),
          returnProfile: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
          pkceChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          state,
          operation: z.enum(['register', 'authenticate']),
        })
        .strict(),
      request.body,
    );
    return reply.code(201).send(envelope(await service.startNativeAuth(body)));
  });

  app.post('/api/v1/passkeys/registration/options', sensitiveRate, async (request) => {
    const body = parse(
      z.object({ enrollmentToken: token, transactionToken: token, state }).strict(),
      request.body,
    );
    return envelope(await service.registrationOptions(body));
  });

  app.post('/api/v1/passkeys/registration/verify', sensitiveRate, async (request) => {
    const body = parse(
      z
        .object({
          ceremonyToken: token,
          transactionToken: token,
          state,
          response: registrationResponseSchema,
        })
        .strict(),
      request.body,
    );
    return envelope(
      await service.verifyRegistration(
        { ...body, response: body.response as RegistrationResponseJSON },
        requestContext(request),
      ),
    );
  });

  app.post('/api/v1/passkeys/authentication/options', sensitiveRate, async (request) => {
    const body = parse(z.object({ transactionToken: token, state }).strict(), request.body);
    return envelope(await service.authenticationOptions(body));
  });

  app.post('/api/v1/passkeys/authentication/verify', sensitiveRate, async (request) => {
    const body = parse(
      z
        .object({
          ceremonyToken: token,
          transactionToken: token,
          state,
          response: authenticationResponseSchema,
        })
        .strict(),
      request.body,
    );
    return envelope(
      await service.verifyAuthentication(
        { ...body, response: body.response as AuthenticationResponseJSON },
        requestContext(request),
      ),
    );
  });

  app.post('/api/v1/native-auth/exchange', sensitiveRate, async (request) => {
    const body = parse(
      z
        .object({
          returnCode: token,
          clientId: z.string().min(1).max(80),
          pkceVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
          state,
          deviceName: z.string().trim().min(1).max(80),
          platform: z.string().trim().min(1).max(32),
          clientDeviceKey: z.string().min(32).max(512),
        })
        .strict(),
      request.body,
    );
    return envelope(await service.exchangeReturnCode(body, requestContext(request)));
  });

  app.post('/api/v1/sessions/refresh', sensitiveRate, async (request) => {
    const body = parse(z.object({ refreshToken: token }).strict(), request.body);
    return envelope(await service.refresh(body.refreshToken, requestContext(request)));
  });

  app.post('/api/v1/sessions/logout', async (request, reply) => {
    const session = await authenticated(service, request);
    parse(z.object({}).strict(), request.body ?? {});
    await service.logout(session, requestContext(request));
    return reply.code(204).send();
  });

  app.get('/api/v1/me', async (request) => {
    const session = await authenticated(service, request);
    return envelope({ id: session.userId, email: session.email, deviceId: session.deviceId });
  });

  app.get('/api/v1/devices', async (request) => {
    const session = await authenticated(service, request);
    return envelope({ items: await service.listDevices(session) });
  });

  app.patch('/api/v1/devices/:id', async (request) => {
    const session = await authenticated(service, request);
    const params = parse(z.object({ id: z.uuid() }).strict(), request.params);
    const body = parse(z.object({ name: z.string().trim().min(1).max(80) }).strict(), request.body);
    return envelope(
      await service.renameDevice(session, params.id, body.name, requestContext(request)),
    );
  });

  app.delete('/api/v1/devices/:id', async (request, reply) => {
    const session = await authenticated(service, request);
    const params = parse(z.object({ id: z.uuid() }).strict(), request.params);
    const result = await service.revokeDevice(session, params.id, requestContext(request));
    return reply
      .code(result.currentDevice ? 200 : 204)
      .send(result.currentDevice ? envelope(result) : undefined);
  });

  app.get('/api/v1/sessions', async (request) => {
    const session = await authenticated(service, request);
    return envelope({
      currentSessionId: session.sessionId,
      items: await service.listSessions(session),
    });
  });

  app.delete('/api/v1/sessions/:id', async (request) => {
    const session = await authenticated(service, request);
    const params = parse(z.object({ id: z.uuid() }).strict(), request.params);
    return envelope(await service.revokeSession(session, params.id, requestContext(request)));
  });

  app.post('/api/v1/sessions/revoke-others', async (request) => {
    const session = await authenticated(service, request);
    parse(z.object({}).strict(), request.body ?? {});
    return envelope(await service.revokeSessions(session, 'others', requestContext(request)));
  });

  app.post('/api/v1/sessions/revoke-all', async (request) => {
    const session = await authenticated(service, request);
    parse(z.object({}).strict(), request.body ?? {});
    return envelope(await service.revokeSessions(session, 'all', requestContext(request)));
  });

  app.get('/api/v1/passkeys', async (request) => {
    const session = await authenticated(service, request);
    return envelope({ items: await service.listPasskeys(session) });
  });

  app.post('/api/v1/passkeys/add', sensitiveRate, async (request) => {
    const session = await authenticated(service, request);
    const body = parse(z.object({ transactionToken: token, state }).strict(), request.body);
    return envelope(
      await service.preparePasskeyAddition(
        session,
        body.transactionToken,
        body.state,
        requestContext(request),
      ),
    );
  });

  app.patch('/api/v1/passkeys/:id', async (request, reply) => {
    const session = await authenticated(service, request);
    const params = parse(z.object({ id: z.uuid() }).strict(), request.params);
    const body = parse(z.object({ name: z.string().trim().min(1).max(80) }).strict(), request.body);
    await service.renamePasskey(session, params.id, body.name, requestContext(request));
    return reply.code(204).send();
  });

  app.delete('/api/v1/passkeys/:id', async (request, reply) => {
    const session = await authenticated(service, request);
    const params = parse(z.object({ id: z.uuid() }).strict(), request.params);
    await service.revokePasskey(session, params.id, requestContext(request));
    return reply.code(204).send();
  });

  app.post('/api/v1/recovery/codes/regenerate', sensitiveRate, async (request) => {
    const session = await authenticated(service, request);
    parse(z.object({}).strict(), request.body ?? {});
    return envelope(await service.regenerateRecoveryCodes(session, requestContext(request)));
  });

  app.post('/api/v1/recovery/start', sensitiveRate, async (request, reply) => {
    const body = parse(z.object({ email }).strict(), request.body);
    await service.checkAbuse('recovery-email', body.email.toLowerCase(), {
      max: 3,
      windowSeconds: 900,
      cooldownSeconds: 300,
    });
    await service.startRecovery(body.email, requestContext(request));
    return reply.code(202).send(envelope(genericResponse));
  });

  app.post('/api/v1/recovery/complete', sensitiveRate, async (request) => {
    const body = parse(
      z
        .object({
          email,
          recoveryToken: token,
          recoveryCode: token,
          transactionToken: token,
          state,
        })
        .strict(),
      request.body,
    );
    await service.checkAbuse('recovery-complete', body.email.toLowerCase(), {
      max: 5,
      windowSeconds: 900,
      cooldownSeconds: 300,
    });
    return envelope(await service.completeRecovery(body, requestContext(request)));
  });

  app.post('/api/v1/messages', async (request, reply) => {
    if (!delivery) throw new Error('Message delivery service is unavailable');
    const session = await authenticated(service, request);
    const body = parse(
      z
        .object({
          requestId: z.uuid(),
          recipientId: z.uuid(),
          payloadFormat: z.literal('transport-v1'),
          payload: z.base64().max(87_384),
        })
        .strict(),
      request.body,
    );
    try {
      const result = await delivery.accept({
        requestId: body.requestId,
        senderUserId: session.userId,
        recipientUserId: body.recipientId,
        payloadFormat: body.payloadFormat,
        payload: Buffer.from(body.payload, 'base64'),
      });
      return await reply.code(202).send(envelope(result));
    } catch (error) {
      if (error instanceof DeliveryConflictError)
        throw conflict('A request ID már más címzetthez tartozik.');
      throw error;
    }
  });

  app.get('/api/v1/messages/pending', async (request) => {
    if (!delivery) throw new Error('Message delivery service is unavailable');
    const session = await authenticated(service, request);
    const query = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).strict(),
      request.query,
    );
    return envelope({ items: await delivery.listPending(session.userId, query.limit) });
  });

  app.get('/api/v1/messages/:requestId', async (request) => {
    if (!delivery) throw new Error('Message delivery service is unavailable');
    const session = await authenticated(service, request);
    const params = parse(z.object({ requestId: z.uuid() }).strict(), request.params);
    try {
      return await Promise.resolve(
        envelope(await delivery.status(session.userId, params.requestId)),
      );
    } catch (error) {
      if (error instanceof DeliveryNotFoundError) throw unauthorized();
      throw error;
    }
  });

  app.post('/api/v1/messages/:requestId/ack', async (request) => {
    if (!delivery) throw new Error('Message delivery service is unavailable');
    const session = await authenticated(service, request);
    const params = parse(z.object({ requestId: z.uuid() }).strict(), request.params);
    const body = parse(z.object({ senderId: z.uuid() }).strict(), request.body);
    try {
      return envelope(await delivery.acknowledge(session.userId, params.requestId, body.senderId));
    } catch (error) {
      if (error instanceof DeliveryNotFoundError) throw unauthorized();
      throw error;
    }
  });

  app.get('/api/v1/security-events', async (request) => {
    const session = await authenticated(service, request);
    return envelope({ items: await service.listSecurityEvents(session) });
  });

  app.post('/api/v1/admin/users/:id/status', sensitiveRate, async (request, reply) => {
    const adminToken = bearer(request);
    if (!constantTimeEqual(adminToken, config.adminBootstrapToken)) throw unauthorized();
    const params = parse(z.object({ id: z.uuid() }).strict(), request.params);
    const body = parse(
      z
        .object({
          status: z.enum([
            'active',
            'suspended',
            'locked',
            'disabled',
            'pending_deletion',
            'tombstoned',
          ]),
          reason: z.string().trim().min(3).max(240),
        })
        .strict(),
      request.body,
    );
    await service.transitionUserStatus(
      params.id,
      body.status,
      body.reason,
      requestContext(request),
    );
    return reply.code(204).send();
  });

  const [authScript, authStyles] = await Promise.all([
    readFile(new URL('../public/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/auth.css', import.meta.url), 'utf8'),
  ]);
  app.get('/assets/auth.js', async (_request, reply) =>
    reply.type('application/javascript; charset=utf-8').send(authScript),
  );
  app.get('/assets/auth.css', async (_request, reply) =>
    reply.type('text/css; charset=utf-8').send(authStyles),
  );
  app.get('/verify-email', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(authPage('E-mail ellenőrzése', 'verify')),
  );
  app.get('/auth/register', async (_request, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .send(authPage('Babylon passkey létrehozása', 'register')),
  );
  app.get('/auth/authenticate', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(authPage('Belépés passkeyjel', 'authenticate')),
  );

  return app;
}
