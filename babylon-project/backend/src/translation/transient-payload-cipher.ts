import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const algorithm = 'aes-256-gcm';
const version = 'v1';
const nonceBytes = 12;
const authTagBytes = 16;
const maximumPlaintextBytes = 196_608;

export interface TransientPayloadCipher {
  encrypt(plaintext: string, associatedData: string): string;
  decrypt(envelope: string, associatedData: string): string;
}

export class Aes256GcmTransientPayloadCipher implements TransientPayloadCipher {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('Transient payload encryption key must be 32 bytes.');
    this.#key = Buffer.from(key);
  }

  encrypt(plaintext: string, associatedData: string): string {
    const plaintextBuffer = Buffer.from(plaintext, 'utf8');
    if (plaintextBuffer.length === 0 || plaintextBuffer.length > maximumPlaintextBytes) {
      throw new Error('Transient payload plaintext length is outside the allowed range.');
    }
    if (associatedData.length === 0) throw new Error('Associated data is required.');

    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv(algorithm, this.#key, nonce, { authTagLength: authTagBytes });
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      version,
      nonce.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(envelope: string, associatedData: string): string {
    if (associatedData.length === 0) throw new Error('Associated data is required.');
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== version) {
      throw new Error('Unsupported transient payload envelope.');
    }

    const nonce = Buffer.from(parts[1] ?? '', 'base64url');
    const tag = Buffer.from(parts[2] ?? '', 'base64url');
    const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');
    if (nonce.length !== nonceBytes || tag.length !== authTagBytes || ciphertext.length === 0) {
      throw new Error('Malformed transient payload envelope.');
    }

    const decipher = createDecipheriv(algorithm, this.#key, nonce, { authTagLength: authTagBytes });
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length === 0 || plaintext.length > maximumPlaintextBytes) {
      throw new Error('Decrypted transient payload length is outside the allowed range.');
    }
    return plaintext.toString('utf8');
  }
}
