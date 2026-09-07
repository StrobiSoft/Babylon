export type ReplayClaim = 'fresh' | 'duplicate';

export interface ReplayStore {
  readonly durable: boolean;
  claim(
    senderNodeId: string,
    messageId: string,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<ReplayClaim>;
}

export class InMemoryReplayStore implements ReplayStore {
  readonly durable = false;
  readonly #entries = new Map<string, number>();

  claim(
    senderNodeId: string,
    messageId: string,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<ReplayClaim> {
    this.#purge(nowMs);
    const key = `${senderNodeId}\u0000${messageId}`;
    if (this.#entries.has(key)) {
      return Promise.resolve('duplicate');
    }
    this.#entries.set(key, expiresAtMs);
    return Promise.resolve('fresh');
  }

  #purge(nowMs: number): void {
    for (const [key, expiresAt] of this.#entries) {
      if (expiresAt < nowMs) {
        this.#entries.delete(key);
      }
    }
  }
}
