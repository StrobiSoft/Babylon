import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  canonicalizeJcs,
  createMessageId,
  fingerprintPublicKey,
  InMemoryReplayStore,
  signEnvelope,
  signatureTranscript,
  verifyEnvelopeSignature,
  type SignedBnpEnvelope,
  type UnsignedBnpEnvelope,
} from '../src/index.js';

interface EnvelopeVector {
  message_id_source_128_bit_hex: string;
  unsigned_envelope: UnsignedBnpEnvelope;
  canonical_jcs_utf8: string;
  canonical_jcs_utf8_hex: string;
  transcript_hex: string;
  signature_hex: string;
  signed_envelope: SignedBnpEnvelope;
}

interface KeyVector {
  seed_hex: string;
  pkcs8_der_hex: string;
  public_key_raw_hex: string;
  spki_der_hex: string;
  fingerprint_sha256_hex: string;
  fingerprint: string;
}

interface CryptoReplayVector {
  request_key: KeyVector;
  response_key: KeyVector;
  request: EnvelopeVector;
  response: EnvelopeVector;
  replay: {
    identity: { sender_node_id: string; message_id: string };
    first_claim: string;
    same_envelope_retry: string;
    same_identity_changed_content: string;
  };
}

const vector = JSON.parse(
  readFileSync(new URL('../../docs/bnp/vectors/crypto-replay-v1.json', import.meta.url), 'utf8'),
) as CryptoReplayVector;

function loadKey(item: KeyVector) {
  const privateKey = createPrivateKey({
    key: Buffer.from(item.pkcs8_der_hex, 'hex'),
    format: 'der',
    type: 'pkcs8',
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

const requestKey = loadKey(vector.request_key);
const responseKey = loadKey(vector.response_key);

function verifyVector(
  item: EnvelopeVector,
  key: ReturnType<typeof loadKey>,
  keyVector: KeyVector,
): void {
  const canonical = canonicalizeJcs(item.unsigned_envelope);
  expect(canonical).toBe(item.canonical_jcs_utf8);
  expect(Buffer.from(canonical, 'utf8').toString('hex')).toBe(item.canonical_jcs_utf8_hex);
  expect(signatureTranscript(item.unsigned_envelope).toString('hex')).toBe(item.transcript_hex);
  expect(signEnvelope(item.unsigned_envelope, key.privateKey)).toEqual(item.signed_envelope);
  expect(
    Buffer.from(item.signed_envelope.signature.slice('ed25519:'.length), 'base64url').toString(
      'hex',
    ),
  ).toBe(item.signature_hex);
  expect(verifyEnvelopeSignature(item.signed_envelope, key.publicKey)).toBe(true);
  expect(item.signed_envelope.key_fingerprint).toBe(keyVector.fingerprint);
}

describe('BNP/1 deterministic crypto and replay vectors', () => {
  it.each([
    ['request', vector.request_key, requestKey],
    ['response', vector.response_key, responseKey],
  ] as const)(
    'reproduces the fixed %s Ed25519 key, DER SPKI, and fingerprint',
    (_name, item, key) => {
      const spki = key.publicKey.export({ format: 'der', type: 'spki' });
      expect(spki.toString('hex')).toBe(item.spki_der_hex);
      expect(spki.subarray(-32).toString('hex')).toBe(item.public_key_raw_hex);
      expect(createHash('sha256').update(spki).digest('hex')).toBe(item.fingerprint_sha256_hex);
      expect(fingerprintPublicKey(key.publicKey)).toBe(item.fingerprint);
      expect(Buffer.from(item.seed_hex, 'hex')).toHaveLength(32);
    },
  );

  it('reproduces the canonical request transcript and signature', () => {
    verifyVector(vector.request, requestKey, vector.request_key);
  });

  it('reproduces the signed response and in_reply_to binding', () => {
    verifyVector(vector.response, responseKey, vector.response_key);
    expect(vector.response.signed_envelope.in_reply_to).toBe(
      vector.request.signed_envelope.message_id,
    );
  });

  it('invalidates the signature when every signed request field is tampered', () => {
    const signed = vector.request.signed_envelope;
    const mutations: SignedBnpEnvelope[] = [
      { ...signed, bnp: '2' as '1' },
      { ...signed, kind: 'read' },
      { ...signed, message_id: 'tampered-message-0000001' },
      { ...signed, from: 'node-attacker-01' },
      { ...signed, to: 'node-target-02' },
      { ...signed, issued_at: '2026-09-07T03:00:01.000Z' },
      { ...signed, expires_at: '2026-09-07T03:01:01.000Z' },
      { ...signed, key_fingerprint: `sha256:${'A'.repeat(43)}` },
      { ...signed, body: { ...signed.body, command_id: 'other' } },
    ];

    for (const mutation of mutations) {
      expect(verifyEnvelopeSignature(mutation, requestKey.publicKey)).toBe(false);
    }
  });

  it('rejects a noncanonical base64url spelling of the same signature bytes', () => {
    const signed = vector.request.signed_envelope;
    const noncanonical = `${signed.signature.slice(0, -1)}R`;
    expect(Buffer.from(noncanonical.slice('ed25519:'.length), 'base64url')).toEqual(
      Buffer.from(signed.signature.slice('ed25519:'.length), 'base64url'),
    );
    expect(
      verifyEnvelopeSignature({ ...signed, signature: noncanonical }, requestKey.publicKey),
    ).toBe(false);
  });

  it('rejects values outside the parsed I-JSON data model before signing', () => {
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = true;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'side effect' });
    const nonEnumerable = { visible: true } as Record<string, unknown>;
    Object.defineProperty(nonEnumerable, 'hidden', { value: true });

    for (const invalid of [sparse, accessor, nonEnumerable, '\ud800']) {
      expect(() => canonicalizeJcs(invalid)).toThrow(TypeError);
    }
  });

  it('uses sender_node_id plus message_id as replay identity', async () => {
    const store = new InMemoryReplayStore();
    const { sender_node_id: sender, message_id: messageId } = vector.replay.identity;
    const sameDigest = 'same-envelope-digest';
    const changedDigest = 'changed-envelope-digest';

    expect(await store.claim(sender, messageId, 2_000, 1_000, sameDigest)).toBe(
      vector.replay.first_claim,
    );
    expect(await store.claim(sender, messageId, 2_000, 1_001, sameDigest)).toBe(
      vector.replay.same_envelope_retry,
    );
    expect(await store.claim('node-other-0001', messageId, 2_000, 1_001, sameDigest)).toBe('fresh');
    expect(await store.claim(sender, messageId, 2_000, 1_001, changedDigest)).toBe('conflict');
    expect(vector.replay.same_identity_changed_content).toBe('replay_conflict');
  });

  it('generates reference implementation message IDs from 128 random bits', () => {
    const ids = new Set(Array.from({ length: 128 }, () => createMessageId()));
    expect(ids.size).toBe(128);
    for (const id of ids) {
      expect(Buffer.from(id, 'base64url')).toHaveLength(16);
    }
  });
});
