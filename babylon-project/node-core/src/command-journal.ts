import type { CommandExecutionSemantics, JsonObject } from './types.js';

export type CommandJournalState = 'received' | 'started' | 'indeterminate' | 'terminal';

export interface CommandDescriptor {
  tableId: string;
  tableVersion: string;
  commandId: string;
  requiredCapability: string;
  executionSemantics: CommandExecutionSemantics;
}

export interface CommandTerminalOutcome {
  state: 'completed' | 'rejected' | 'blocked' | 'failed' | 'already_applied';
  result?: JsonObject;
  reasonCode?: string;
}

export interface CommandJournalEntry {
  senderNodeId: string;
  messageId: string;
  envelopeDigest: string;
  retainUntilMs: number;
  state: CommandJournalState;
  command: CommandDescriptor;
  receivedAtMs: number;
  attemptId?: string;
  startedAtMs?: number;
  indeterminateAtMs?: number;
  terminalAtMs?: number;
  terminal?: CommandTerminalOutcome;
}

export interface CommandReceiveInput {
  senderNodeId: string;
  messageId: string;
  envelopeDigest: string;
  retainUntilMs: number;
  command: CommandDescriptor;
  receivedAtMs: number;
}

export type CommandReceiveResult =
  | { kind: 'fresh'; entry: CommandJournalEntry }
  | { kind: 'duplicate'; entry: CommandJournalEntry }
  | { kind: 'conflict'; entry: CommandJournalEntry };

export type CommandTransitionResult =
  | { kind: 'applied'; entry: CommandJournalEntry }
  | { kind: 'stale'; entry: CommandJournalEntry }
  | { kind: 'conflict'; entry: CommandJournalEntry };

/**
 * Durable source of truth for COMMAND replay identity and execution state.
 *
 * A production implementation must make receive/start/terminal transitions atomic.
 * `terminal` is immutable, and transition methods must reject stale attempt IDs.
 * Non-terminal entries MUST NOT be evicted solely because `retainUntilMs` passed;
 * otherwise the system could forget an unresolved effect and admit a duplicate.
 * For terminal entries, `retainUntilMs` is the earliest replay/result retention
 * deadline and may be extended by the terminal transition.
 * The interface deliberately does not select a storage technology.
 */
export interface CommandJournal {
  readonly durable: boolean;

  lookup(senderNodeId: string, messageId: string): Promise<CommandJournalEntry | null>;

  receive(input: CommandReceiveInput): Promise<CommandReceiveResult>;

  start(
    senderNodeId: string,
    messageId: string,
    envelopeDigest: string,
    attemptId: string,
    startedAtMs: number,
  ): Promise<CommandTransitionResult>;

  markIndeterminate(
    senderNodeId: string,
    messageId: string,
    envelopeDigest: string,
    attemptId: string,
    indeterminateAtMs: number,
  ): Promise<CommandTransitionResult>;

  complete(
    senderNodeId: string,
    messageId: string,
    envelopeDigest: string,
    attemptId: string,
    outcome: CommandTerminalOutcome,
    terminalAtMs: number,
    retainUntilMs: number,
  ): Promise<CommandTransitionResult>;
}
