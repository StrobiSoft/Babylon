import { createHash, type KeyObject, sign, verify } from 'node:crypto';

import { canonicalizeJcs } from './jcs.js';
import type { SignedBnpEnvelope, UnsignedBnpEnvelope } from './types.js';

const SIGNATURE_DOMAIN = Buffer.from('BNP/1\n', 'ascii');
const SIGNATURE_PREFIX = 'ed25519:';

function assertEd25519(key: KeyObject): void {
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('BNP v1 requires Ed25519 keys');
  }
}

export function fingerprintPublicKey(publicKey: KeyObject): string {
  assertEd25519(publicKey);
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const digest = createHash('sha256').update(spki).digest('base64url');
  return `sha256:${digest}`;
}

export function signatureTranscript(envelope: UnsignedBnpEnvelope): Buffer {
  const canonical = Buffer.from(canonicalizeJcs(envelope), 'utf8');
  return Buffer.concat([SIGNATURE_DOMAIN, canonical]);
}

export function signEnvelope(
  envelope: UnsignedBnpEnvelope,
  privateKey: KeyObject,
): SignedBnpEnvelope {
  assertEd25519(privateKey);
  const signature = sign(null, signatureTranscript(envelope), privateKey).toString('base64url');
  return { ...envelope, signature: `${SIGNATURE_PREFIX}${signature}` };
}

export function verifyEnvelopeSignature(
  envelope: SignedBnpEnvelope,
  publicKey: KeyObject,
): boolean {
  assertEd25519(publicKey);
  if (!envelope.signature.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const encoded = envelope.signature.slice(SIGNATURE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return false;
  }

  const { signature: _signature, ...unsigned } = envelope;
  const signature = Buffer.from(encoded, 'base64url');
  return verify(null, signatureTranscript(unsigned), publicKey, signature);
}
