export type ReplayClaim = 'fresh' | 'duplicate' | 'conflict';

export interface ReplayStore {
  readonly durable: boolean;
  claim(
    senderNodeId: string,
    messageId: string,
    envelopeDigest: string,
    retainUntilMs: number,
    nowMs: number,
  ): Promise<ReplayClaim>;
}

interface ReplayEntry {
  envelopeDigest: string;
  retainUntilMs: number;
}

export class InMemoryReplayStore implements ReplayStore {
  readonly durable = false;
  readonly #entries = new Map<string, ReplayEntry>();

  claim(
    senderNodeId: string,
    messageId: string,
    envelopeDigest: string,
    retainUntilMs: number,
    nowMs: number,
  ): Promise<ReplayClaim> {
    this.#purge(nowMs);
    const key = `${senderNodeId}\u0000${messageId}`;
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      return Promise.resolve(existing.envelopeDigest === envelopeDigest ? 'duplicate' : 'conflict');
    }
    this.#entries.set(key, { envelopeDigest, retainUntilMs });
    return Promise.resolve('fresh');
  }

  #purge(nowMs: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.retainUntilMs < nowMs) {
        this.#entries.delete(key);
      }
    }
  }
}
