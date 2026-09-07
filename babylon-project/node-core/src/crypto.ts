import { createHash, type KeyObject, sign, verify } from 'node:crypto';

import { canonicalizeJcs } from './jcs.js';
import { assertUnsignedEnvelope } from './envelope.js';
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
  assertUnsignedEnvelope(envelope);
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
  const { signature, ...unsigned } = envelope;
  if (!signature.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const encoded = signature.slice(SIGNATURE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{85}[AQgw]$/.test(encoded)) {
    return false;
  }

  const signatureBytes = Buffer.from(encoded, 'base64url');
  if (signatureBytes.length !== 64) {
    return false;
  }
  if (signatureBytes.toString('base64url') !== encoded) {
    return false;
  }
  try {
    return verify(null, signatureTranscript(unsigned), publicKey, signatureBytes);
  } catch {
    return false;
  }
}
