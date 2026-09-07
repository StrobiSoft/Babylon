import { randomBytes } from 'node:crypto';

import {
  BNP_KINDS,
  type BnpKind,
  type JsonObject,
  type SignedBnpEnvelope,
  type UnsignedBnpEnvelope,
} from './types.js';

const MESSAGE_ID_MIN = 16;
const MESSAGE_ID_MAX = 128;
const NODE_ID_MIN = 8;
const NODE_ID_MAX = 128;
const FINGERPRINT_PATTERN = /^sha256:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const SIGNATURE_PATTERN = /^ed25519:[A-Za-z0-9_-]{85}[AQgw]$/;
const RESPONSE_KINDS = new Set<BnpKind>(['read_result', 'command_result', 'ack', 'error']);

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
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
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
  if (typeof value !== 'string' || !value.endsWith('Z') || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`invalid ${field}`);
  }
}

function isBnpKind(value: unknown): value is BnpKind {
  return typeof value === 'string' && (BNP_KINDS as readonly string[]).includes(value);
}

function hasCanonicalBase64url(value: string, prefix: string, byteLength: number): boolean {
  const encoded = value.slice(prefix.length);
  const decoded = Buffer.from(encoded, 'base64url');
  return decoded.length === byteLength && decoded.toString('base64url') === encoded;
}

function assertEnvelope(value: unknown, signed: boolean): void {
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
  assertString(value['key_fingerprint'], 'key_fingerprint', 1, 256);
  if (
    !FINGERPRINT_PATTERN.test(value['key_fingerprint']) ||
    !hasCanonicalBase64url(value['key_fingerprint'], 'sha256:', 32)
  ) {
    throw new TypeError('invalid key_fingerprint');
  }

  if (signed) {
    assertString(value['signature'], 'signature', 1, 512);
    if (
      !SIGNATURE_PATTERN.test(value['signature']) ||
      !hasCanonicalBase64url(value['signature'], 'ed25519:', 64)
    ) {
      throw new TypeError('invalid signature');
    }
  } else if (value['signature'] !== undefined) {
    throw new TypeError('unsigned envelope contains signature');
  }

  if (!isPlainObject(value['body'])) {
    throw new TypeError('body must be an object');
  }

  if (value['in_reply_to'] !== undefined) {
    assertString(value['in_reply_to'], 'in_reply_to', MESSAGE_ID_MIN, MESSAGE_ID_MAX);
  }

  const responseKind = RESPONSE_KINDS.has(value['kind']);
  if (responseKind !== (value['in_reply_to'] !== undefined)) {
    throw new TypeError(
      responseKind
        ? 'response envelope requires in_reply_to'
        : 'request envelope must not contain in_reply_to',
    );
  }
}

export function assertUnsignedEnvelope(value: unknown): asserts value is UnsignedBnpEnvelope {
  assertEnvelope(value, false);
}

export function assertSignedEnvelope(value: unknown): asserts value is SignedBnpEnvelope {
  assertEnvelope(value, true);
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

  if (expiresAt <= issuedAt) {
    throw new TypeError('expires_at must be later than issued_at');
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
