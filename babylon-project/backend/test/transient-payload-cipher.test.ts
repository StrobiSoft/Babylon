import { describe, expect, it } from 'vitest';
import { Aes256GcmTransientPayloadCipher } from '../src/translation/transient-payload-cipher.js';

const key = Buffer.alloc(32, 7);

describe('transient payload cipher', () => {
  it('round-trips encrypted payloads while hiding plaintext', () => {
    const cipher = new Aes256GcmTransientPayloadCipher(key);
    const plaintext = JSON.stringify({ sourceText: 'Szia világ', targetLanguage: 'en' });
    const envelope = cipher.encrypt(plaintext, '00000000-0000-4000-8000-000000000401');

    expect(envelope).not.toContain('Szia világ');
    expect(cipher.decrypt(envelope, '00000000-0000-4000-8000-000000000401')).toBe(plaintext);
  });

  it('binds ciphertext to associated request data', () => {
    const cipher = new Aes256GcmTransientPayloadCipher(key);
    const envelope = cipher.encrypt('secret payload', 'request-a');

    expect(() => cipher.decrypt(envelope, 'request-b')).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const cipher = new Aes256GcmTransientPayloadCipher(key);
    const envelope = cipher.encrypt('secret payload', 'request-a');
    const parts = envelope.split('.');
    parts[3] = `${parts[3]?.slice(0, -1)}A`;

    expect(() => cipher.decrypt(parts.join('.'), 'request-a')).toThrow();
  });

  it('rejects invalid key sizes and empty payloads', () => {
    expect(() => new Aes256GcmTransientPayloadCipher(Buffer.alloc(31))).toThrow();
    const cipher = new Aes256GcmTransientPayloadCipher(key);
    expect(() => cipher.encrypt('', 'request-a')).toThrow();
  });
});
