import type {
  CommandJournal,
  CommandJournalEntry,
  CommandReceiveInput,
  CommandReceiveResult,
  CommandTerminalOutcome,
  CommandTransitionResult,
} from '../src/index.js';

function key(senderNodeId: string, messageId: string): string {
  return `${senderNodeId}\u0000${messageId}`;
}

function cloneEntry(entry: CommandJournalEntry): CommandJournalEntry {
  return {
    ...entry,
    command: { ...entry.command },
    ...(entry.terminal === undefined
      ? {}
      : {
          terminal: {
            ...entry.terminal,
            ...(entry.terminal.result === undefined
              ? {}
              : { result: structuredClone(entry.terminal.result) }),
          },
        }),
  };
}

export class TestDurableCommandJournal implements CommandJournal {
  readonly durable = true;
  readonly #entries = new Map<string, CommandJournalEntry>();
  failNextReceive = false;
  failNextStart = false;
  failNextComplete = false;
  failNextIndeterminate = false;

  lookup(senderNodeId: string, messageId: string): Promise<CommandJournalEntry | null> {
    const entry = this.#entries.get(key(senderNodeId, messageId));
    return Promise.resolve(entry === undefined ? null : cloneEntry(entry));
  }

  receive(input: CommandReceiveInput): Promise<CommandReceiveResult> {
    if (this.failNextReceive) {
      this.failNextReceive = false;
      return Promise.reject(new Error('injected receive failure'));
    }
    const entryKey = key(input.senderNodeId, input.messageId);
    const existing = this.#entries.get(entryKey);
    if (existing !== undefined) {
      return Promise.resolve({
        kind: existing.envelopeDigest === input.envelopeDigest ? 'duplicate' : 'conflict',
        entry: cloneEntry(existing),
      });
    }
    const entry: CommandJournalEntry = {
      ...input,
      command: { ...input.command },
      state: 'received',
    };
    this.#entries.set(entryKey, entry);
    return Promise.resolve({ kind: 'fresh', entry: cloneEntry(entry) });
  }

  start(
    senderNodeId: string,
    messageId: string,
    envelopeDigest: string,
    attemptId: string,
    startedAtMs: number,
  ): Promise<CommandTransitionResult> {
    if (this.failNextStart) {
      this.failNextStart = false;
      return Promise.reject(new Error('injected start failure'));
    }
    const entry = this.#required(senderNodeId, messageId);
    if (entry.envelopeDigest !== envelopeDigest) {
      return Promise.resolve({ kind: 'conflict', entry: cloneEntry(entry) });
    }
    if (entry.state !== 'received') {
      return Promise.resolve({ kind: 'stale', entry: cloneEntry(entry) });
    }
    entry.state = 'started';
    entry.attemptId = attemptId;
    entry.startedAtMs = startedAtMs;
    return Promise.resolve({ kind: 'applied', entry: cloneEntry(entry) });
  }

  markIndeterminate(
    senderNodeId: string,
    messageId: string,
    envelopeDigest: string,
    attemptId: string,
    indeterminateAtMs: number,
  ): Promise<CommandTransitionResult> {
    if (this.failNextIndeterminate) {
      this.failNextIndeterminate = false;
      return Promise.reject(new Error('injected indeterminate failure'));
    }
    const entry = this.#required(senderNodeId, messageId);
    if (entry.envelopeDigest !== envelopeDigest) {
      return Promise.resolve({ kind: 'conflict', entry: cloneEntry(entry) });
    }
    if (entry.state !== 'started' || entry.attemptId !== attemptId) {
      return Promise.resolve({ kind: 'stale', entry: cloneEntry(entry) });
    }
    entry.state = 'indeterminate';
    entry.indeterminateAtMs = indeterminateAtMs;
    return Promise.resolve({ kind: 'applied', entry: cloneEntry(entry) });
  }

  complete(
    senderNodeId: string,
    messageId: string,
    envelopeDigest: string,
    attemptId: string,
    outcome: CommandTerminalOutcome,
    terminalAtMs: number,
    retainUntilMs: number,
  ): Promise<CommandTransitionResult> {
    if (this.failNextComplete) {
      this.failNextComplete = false;
      return Promise.reject(new Error('injected complete failure'));
    }
    const entry = this.#required(senderNodeId, messageId);
    if (entry.envelopeDigest !== envelopeDigest) {
      return Promise.resolve({ kind: 'conflict', entry: cloneEntry(entry) });
    }
    if (entry.state !== 'started' || entry.attemptId !== attemptId) {
      return Promise.resolve({ kind: 'stale', entry: cloneEntry(entry) });
    }
    entry.state = 'terminal';
    entry.terminalAtMs = terminalAtMs;
    entry.retainUntilMs = Math.max(entry.retainUntilMs, retainUntilMs);
    entry.terminal = {
      ...outcome,
      ...(outcome.result === undefined ? {} : { result: structuredClone(outcome.result) }),
    };
    return Promise.resolve({ kind: 'applied', entry: cloneEntry(entry) });
  }

  async inspect(senderNodeId: string, messageId: string): Promise<CommandJournalEntry> {
    const entry = await this.lookup(senderNodeId, messageId);
    if (entry === null) {
      throw new Error('missing test journal entry');
    }
    return entry;
  }

  #required(senderNodeId: string, messageId: string): CommandJournalEntry {
    const entry = this.#entries.get(key(senderNodeId, messageId));
    if (entry === undefined) {
      throw new Error('missing command journal entry');
    }
    return entry;
  }
}
