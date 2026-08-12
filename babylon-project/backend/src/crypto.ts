import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Clock, RandomSource } from './types.js';

export const systemClock: Clock = { now: () => new Date() };

export const secureRandom: RandomSource = {
  token: (bytes = 32) => randomBytes(bytes).toString('base64url'),
  uuid: () => randomUUID(),
};

export function hash(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function pkceChallenge(verifier: string): string {
  return hash(verifier).toString('base64url');
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = hash(left);
  const rightDigest = hash(right);
  return timingSafeEqual(leftDigest, rightDigest);
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}
