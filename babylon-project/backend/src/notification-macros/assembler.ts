import { macroCatalogById } from './catalog.js';
import {
  notificationFragmentEnvelopeSchema,
  type AssembledNotificationMessage,
  type NotificationFragment,
  type NotificationFragmentEnvelope,
} from './transport.js';
import type { MacroGroup } from './types.js';

export type MacroAssemblyErrorCode =
  | 'INVALID_ENVELOPE'
  | 'MESSAGE_METADATA_MISMATCH'
  | 'UNKNOWN_MACRO_ID'
  | 'WRONG_MACRO_GROUP'
  | 'UNSUPPORTED_MACRO_VERSION'
  | 'DEPRECATED_MACRO'
  | 'INCOMPATIBLE_DUPLICATE'
  | 'INCOMPLETE_MESSAGE'
  | 'MISSING_REQUIRED_REASON';

export class MacroAssemblyError extends Error {
  constructor(
    readonly code: MacroAssemblyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MacroAssemblyError';
  }
}

export type FragmentAcceptance =
  | { readonly status: 'accepted'; readonly received: number; readonly expected: number }
  | { readonly status: 'duplicate'; readonly received: number; readonly expected: number };

interface MessageIdentity {
  readonly protocolVersion: '0.1';
  readonly eventId: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly messageSequence: number;
  readonly totalFragments: number;
  readonly replay: NotificationFragmentEnvelope['replay'];
}

const canonicalGroupOrder: Readonly<Record<MacroGroup, number>> = {
  attention: 0,
  status: 1,
  reason: 2,
};

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fragmentSlot(fragment: NotificationFragment): MacroGroup | 'optional_text' {
  return fragment.kind === 'macro' ? fragment.group : 'optional_text';
}

export class NotificationMacroAssembler {
  private identity: MessageIdentity | undefined;
  private readonly fragmentsBySequence = new Map<number, NotificationFragment>();

  accept(input: unknown): FragmentAcceptance {
    const parsed = notificationFragmentEnvelopeSchema.safeParse(input);
    if (!parsed.success) {
      throw new MacroAssemblyError(
        'INVALID_ENVELOPE',
        parsed.error.issues[0]?.message ?? 'invalid envelope',
      );
    }

    const envelope = parsed.data;
    this.validateMacro(envelope.fragment);
    this.bindOrValidateIdentity(envelope);

    const existingAtSequence = this.fragmentsBySequence.get(envelope.sequence.fragment);
    if (existingAtSequence !== undefined) {
      if (equalJson(existingAtSequence, envelope.fragment)) {
        return this.acceptance('duplicate');
      }
      throw new MacroAssemblyError(
        'INCOMPATIBLE_DUPLICATE',
        `fragment sequence ${envelope.sequence.fragment} already contains different data`,
      );
    }

    const slot = fragmentSlot(envelope.fragment);
    for (const existing of this.fragmentsBySequence.values()) {
      if (fragmentSlot(existing) === slot) {
        throw new MacroAssemblyError(
          'INCOMPATIBLE_DUPLICATE',
          `message already contains a ${slot} fragment at another sequence`,
        );
      }
    }

    this.fragmentsBySequence.set(envelope.sequence.fragment, envelope.fragment);
    return this.acceptance('accepted');
  }

  assemble(): AssembledNotificationMessage {
    const identity = this.identity;
    if (identity === undefined) {
      throw new MacroAssemblyError('INCOMPLETE_MESSAGE', 'no fragments have arrived');
    }
    if (this.fragmentsBySequence.size !== identity.totalFragments) {
      throw new MacroAssemblyError('INCOMPLETE_MESSAGE', 'not all declared fragments have arrived');
    }

    for (let index = 0; index < identity.totalFragments; index += 1) {
      if (!this.fragmentsBySequence.has(index)) {
        throw new MacroAssemblyError('INCOMPLETE_MESSAGE', `fragment sequence ${index} is missing`);
      }
    }

    const fragments = [...this.fragmentsBySequence.values()];
    const macros = fragments.filter(
      (fragment): fragment is Extract<NotificationFragment, { kind: 'macro' }> =>
        fragment.kind === 'macro',
    );
    const attention = macros.find((fragment) => fragment.group === 'attention');
    const status = macros.find((fragment) => fragment.group === 'status');
    if (attention === undefined || status === undefined) {
      throw new MacroAssemblyError(
        'INCOMPLETE_MESSAGE',
        'a message must contain one attention macro and one status macro',
      );
    }

    const statusMetadata = macroCatalogById.get(status.macroId);
    const reason = macros.find((fragment) => fragment.group === 'reason');
    if (
      statusMetadata?.group === 'status' &&
      statusMetadata.statusKind !== 'progress' &&
      reason === undefined
    ) {
      throw new MacroAssemblyError(
        'MISSING_REQUIRED_REASON',
        'terminal and decision messages require an explicit reason macro',
      );
    }

    const ordered = [...fragments].sort((left, right) => {
      if (left.kind === 'optional_text') return right.kind === 'optional_text' ? 0 : 1;
      if (right.kind === 'optional_text') return -1;
      return canonicalGroupOrder[left.group] - canonicalGroupOrder[right.group];
    });

    return {
      protocolVersion: identity.protocolVersion,
      eventId: identity.eventId,
      messageId: identity.messageId,
      createdAt: identity.createdAt,
      sequence: { message: identity.messageSequence },
      replay:
        identity.replay.originalMessageId === undefined
          ? { attempt: identity.replay.attempt }
          : {
              attempt: identity.replay.attempt,
              originalMessageId: identity.replay.originalMessageId,
            },
      fragments: ordered,
    };
  }

  private acceptance(status: FragmentAcceptance['status']): FragmentAcceptance {
    return {
      status,
      received: this.fragmentsBySequence.size,
      expected: this.identity?.totalFragments ?? 0,
    };
  }

  private validateMacro(fragment: NotificationFragment): void {
    if (fragment.kind !== 'macro') return;
    const macro = macroCatalogById.get(fragment.macroId);
    if (macro === undefined) {
      throw new MacroAssemblyError('UNKNOWN_MACRO_ID', `unknown macro ID ${fragment.macroId}`);
    }
    if (macro.group !== fragment.group) {
      throw new MacroAssemblyError(
        'WRONG_MACRO_GROUP',
        `macro ${fragment.macroId} does not belong to ${fragment.group}`,
      );
    }
    if (macro.version !== fragment.macroVersion) {
      throw new MacroAssemblyError(
        'UNSUPPORTED_MACRO_VERSION',
        `macro ${fragment.macroId} does not support version ${fragment.macroVersion}`,
      );
    }
    if (macro.deprecation.deprecated) {
      throw new MacroAssemblyError('DEPRECATED_MACRO', `macro ${fragment.macroId} is deprecated`);
    }
  }

  private bindOrValidateIdentity(envelope: NotificationFragmentEnvelope): void {
    const candidate: MessageIdentity = {
      protocolVersion: envelope.protocolVersion,
      eventId: envelope.eventId,
      messageId: envelope.messageId,
      createdAt: envelope.createdAt,
      messageSequence: envelope.sequence.message,
      totalFragments: envelope.sequence.totalFragments,
      replay: envelope.replay,
    };
    if (this.identity === undefined) {
      this.identity = candidate;
      return;
    }
    if (!equalJson(this.identity, candidate)) {
      throw new MacroAssemblyError(
        'MESSAGE_METADATA_MISMATCH',
        'all fragments must carry identical message, sequence, timestamp, and replay metadata',
      );
    }
  }
}
