import { randomBytes } from 'node:crypto';

import { BNP_KINDS, type BnpKind, type JsonObject, type SignedBnpEnvelope } from './types.js';

const MESSAGE_ID_MIN = 16;
const MESSAGE_ID_MAX = 128;
const NODE_ID_MIN = 8;
const NODE_ID_MAX = 128;

const ENVELOPE_KEYS = new Set([
  'bnp',
  'kind',
  'message_id',
  'from',
  'to',
  'issued_at',
  'expires_at',
  'key_fingerprint',
  'body',
  'in_reply_to',
  'signature',
]);

export interface TimePolicy {
  maxFutureSkewMs: number;
  maxLateSkewMs: number;
  maxLifetimeMs: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return (
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
  );
}

function assertString(
  value: unknown,
  field: string,
  min: number,
  max: number,
): asserts value is string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new TypeError(`invalid ${field}`);
  }
}

function assertUtcTimestamp(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.endsWith('Z') ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`invalid ${field}`);
  }
}

function isBnpKind(value: unknown): value is BnpKind {
  return typeof value === 'string' && (BNP_KINDS as readonly string[]).includes(value);
}

export function assertSignedEnvelope(value: unknown): asserts value is SignedBnpEnvelope {
  if (!isPlainObject(value)) {
    throw new TypeError('envelope must be an object');
  }

  for (const key of Object.keys(value)) {
    if (!ENVELOPE_KEYS.has(key)) {
      throw new TypeError('envelope contains an unknown field');
    }
  }

  if (value['bnp'] !== '1') {
    throw new TypeError('unsupported BNP version');
  }
  if (!isBnpKind(value['kind'])) {
    throw new TypeError('invalid message kind');
  }

  assertString(value['message_id'], 'message_id', MESSAGE_ID_MIN, MESSAGE_ID_MAX);
  assertString(value['from'], 'from', NODE_ID_MIN, NODE_ID_MAX);
  assertString(value['to'], 'to', NODE_ID_MIN, NODE_ID_MAX);
  assertUtcTimestamp(value['issued_at'], 'issued_at');
  assertUtcTimestamp(value['expires_at'], 'expires_at');
  assertString(value['key_fingerprint'], 'key_fingerprint', 16, 256);
  assertString(value['signature'], 'signature', 16, 512);

  if (!isPlainObject(value['body'])) {
    throw new TypeError('body must be an object');
  }

  if (value['in_reply_to'] !== undefined) {
    assertString(value['in_reply_to'], 'in_reply_to', MESSAGE_ID_MIN, MESSAGE_ID_MAX);
  }
}

export function validateEnvelopeTime(
  envelope: SignedBnpEnvelope,
  nowMs: number,
  policy: TimePolicy,
): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`invalid time policy: ${name}`);
    }
  }

  const issuedAt = Date.parse(envelope.issued_at);
  const expiresAt = Date.parse(envelope.expires_at);

  if (expiresAt < issuedAt) {
    throw new TypeError('expires_at precedes issued_at');
  }
  if (issuedAt > nowMs + policy.maxFutureSkewMs) {
    throw new TypeError('message issued too far in the future');
  }
  if (expiresAt < nowMs - policy.maxLateSkewMs) {
    throw new TypeError('message expired');
  }
  if (expiresAt - issuedAt > policy.maxLifetimeMs) {
    throw new TypeError('message lifetime exceeds local policy');
  }
}

export function createMessageId(): string {
  return randomBytes(16).toString('base64url');
}

export function asJsonObject(value: Record<string, unknown>): JsonObject {
  return value as JsonObject;
}
