import { describe, expect, it } from 'vitest';
import {
  MacroAssemblyError,
  NotificationMacroAssembler,
  expandNotification,
  macroCatalog,
  notificationFragmentEnvelopeSchema,
  type NotificationFragment,
} from '../src/notification-macros/index.js';

const ATTENTION = '01JQ7S4C8N2W6K9D3F5H0M1PXT';
const STATUS_STARTED = '01JQ7V2H8M4K6C9N3D5F0R1BXP';
const STATUS_COMPLETED = '01JQ7W5N2C8M4K9D6F3H0R1BVA';
const STATUS_DECISION = '01JQ7Y3M8C5N2K9D6F4H0R1BVA';
const REASON_FINISHED = '01JQ803C6N9M2K5D8F4H0R1BVA';
const REASON_APPROVAL = '01JQ84FM7N2C9K5D8H4R0B3VXA';

const EVENT_ID = '10000000-0000-4000-8000-000000000001';
const MESSAGE_ID = '20000000-0000-4000-8000-000000000002';
const ORIGINAL_MESSAGE_ID = '30000000-0000-4000-8000-000000000003';

function macro(group: 'attention' | 'status' | 'reason', macroId: string): NotificationFragment {
  return { kind: 'macro', group, macroId, macroVersion: '0.1.0' };
}

function envelope(
  fragment: NotificationFragment,
  fragmentSequence: number,
  totalFragments: number,
  options: {
    messageId?: string;
    replay?: { attempt: number; originalMessageId?: string };
  } = {},
): unknown {
  return {
    protocolVersion: '0.1',
    eventId: EVENT_ID,
    messageId: options.messageId ?? MESSAGE_ID,
    createdAt: '2026-09-03T00:00:00.000Z',
    sequence: { message: 17, fragment: fragmentSequence, totalFragments },
    replay: options.replay ?? { attempt: 0 },
    fragment,
  };
}

function errorCode(operation: () => unknown): string | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(MacroAssemblyError);
    return (error as MacroAssemblyError).code;
  }
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [
      value,
      ...rest,
    ]),
  );
}

describe('notification macro v0.1', () => {
  it('assembles the same canonical message for every fragment arrival order', () => {
    const fragments = [
      envelope(macro('reason', REASON_FINISHED), 0, 4),
      envelope({ kind: 'optional_text', text: 'Build 42.' }, 1, 4),
      envelope(macro('attention', ATTENTION), 2, 4),
      envelope(macro('status', STATUS_COMPLETED), 3, 4),
    ];

    const assembled = permutations(fragments).map((arrivalOrder) => {
      const assembler = new NotificationMacroAssembler();
      for (const item of arrivalOrder) assembler.accept(item);
      return assembler.assemble();
    });

    expect(
      assembled.every((message) => JSON.stringify(message) === JSON.stringify(assembled[0])),
    ).toBe(true);
    expect(
      assembled[0]?.fragments.map((fragment) =>
        fragment.kind === 'macro' ? fragment.group : fragment.kind,
      ),
    ).toEqual(['attention', 'status', 'reason', 'optional_text']);
  });

  it('handles exact duplicates idempotently and preserves explicit replay provenance', () => {
    const replay = { attempt: 1, originalMessageId: ORIGINAL_MESSAGE_ID };
    const options = { messageId: MESSAGE_ID, replay };
    const assembler = new NotificationMacroAssembler();
    const attention = envelope(macro('attention', ATTENTION), 0, 2, options);

    expect(assembler.accept(attention)).toMatchObject({ status: 'accepted', received: 1 });
    expect(assembler.accept(attention)).toMatchObject({ status: 'duplicate', received: 1 });
    assembler.accept(envelope(macro('status', STATUS_STARTED), 1, 2, options));
    expect(assembler.assemble().replay).toEqual(replay);
  });

  it('rejects malformed replay metadata and metadata changes between fragments', () => {
    expect(
      notificationFragmentEnvelopeSchema.safeParse(
        envelope(macro('attention', ATTENTION), 0, 2, { replay: { attempt: 1 } }),
      ).success,
    ).toBe(false);

    const assembler = new NotificationMacroAssembler();
    assembler.accept(envelope(macro('attention', ATTENTION), 0, 2));
    expect(
      errorCode(() =>
        assembler.accept(
          envelope(macro('status', STATUS_STARTED), 1, 2, {
            messageId: '40000000-0000-4000-8000-000000000004',
          }),
        ),
      ),
    ).toBe('MESSAGE_METADATA_MISMATCH');
  });

  it('rejects unknown IDs, wrong groups, malformed and unsupported versions', () => {
    const unknown = new NotificationMacroAssembler();
    expect(
      errorCode(() =>
        unknown.accept(envelope(macro('attention', '01JQ999N4C7M2K5D8F0H3R6BVA'), 0, 2)),
      ),
    ).toBe('UNKNOWN_MACRO_ID');

    const wrongGroup = new NotificationMacroAssembler();
    expect(errorCode(() => wrongGroup.accept(envelope(macro('reason', ATTENTION), 0, 2)))).toBe(
      'WRONG_MACRO_GROUP',
    );

    const malformed = new NotificationMacroAssembler();
    expect(
      errorCode(() =>
        malformed.accept(
          envelope(
            { kind: 'macro', group: 'attention', macroId: ATTENTION, macroVersion: 'v0.1' },
            0,
            2,
          ),
        ),
      ),
    ).toBe('INVALID_ENVELOPE');

    const unsupported = new NotificationMacroAssembler();
    expect(
      errorCode(() =>
        unsupported.accept(
          envelope(
            { kind: 'macro', group: 'attention', macroId: ATTENTION, macroVersion: '0.2.0' },
            0,
            2,
          ),
        ),
      ),
    ).toBe('UNSUPPORTED_MACRO_VERSION');
  });

  it('rejects incompatible sequence and group duplicates', () => {
    const sequenceConflict = new NotificationMacroAssembler();
    sequenceConflict.accept(envelope(macro('attention', ATTENTION), 0, 2));
    expect(
      errorCode(() => sequenceConflict.accept(envelope(macro('status', STATUS_STARTED), 0, 2))),
    ).toBe('INCOMPATIBLE_DUPLICATE');

    const groupConflict = new NotificationMacroAssembler();
    groupConflict.accept(envelope(macro('status', STATUS_STARTED), 0, 3));
    expect(
      errorCode(() => groupConflict.accept(envelope(macro('status', STATUS_COMPLETED), 1, 3))),
    ).toBe('INCOMPATIBLE_DUPLICATE');
  });

  it.each([
    ['terminal', STATUS_COMPLETED],
    ['decision', STATUS_DECISION],
  ])('rejects an incomplete %s message with no supplied reason', (_label, statusId) => {
    const assembler = new NotificationMacroAssembler();
    assembler.accept(envelope(macro('attention', ATTENTION), 0, 2));
    assembler.accept(envelope(macro('status', statusId), 1, 2));
    expect(errorCode(() => assembler.assemble())).toBe('MISSING_REQUIRED_REASON');
  });

  it('allows a non-terminal message without inventing a reason or text', () => {
    const assembler = new NotificationMacroAssembler();
    assembler.accept(envelope(macro('attention', ATTENTION), 0, 2));
    assembler.accept(envelope(macro('status', STATUS_STARTED), 1, 2));
    expect(assembler.assemble().fragments).toHaveLength(2);
  });

  it('enforces optional-text Unicode, byte, normalization, and control-character bounds', () => {
    const invalidText = ['x'.repeat(281), '😀'.repeat(257), 'Cafe\u0301', 'unsafe\u0000text'];
    for (const text of invalidText) {
      const assembler = new NotificationMacroAssembler();
      expect(
        errorCode(() => assembler.accept(envelope({ kind: 'optional_text', text }, 0, 3))),
      ).toBe('INVALID_ENVELOPE');
    }
    expect(
      notificationFragmentEnvelopeSchema.safeParse(
        envelope({ kind: 'optional_text', text: 'Café\nDetails follow.' }, 0, 3),
      ).success,
    ).toBe(true);
  });

  it('keeps every opaque macro ID unique and every catalog record versioned', () => {
    const ids = macroCatalog.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of macroCatalog) {
      expect(entry.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
      expect(entry.version).toBe('0.1.0');
      expect(entry.canonicalName).not.toBe('');
      expect(entry.audience.length).toBeGreaterThan(0);
      expect(entry.deprecation).toHaveProperty('deprecated');
      if (entry.group === 'status')
        expect(entry.statusKind).toMatch(/^(progress|terminal|decision)$/u);
    }
  });

  it('is deterministic and transports IDs without endpoint expansion text', () => {
    const assembler = new NotificationMacroAssembler();
    assembler.accept(envelope(macro('reason', REASON_APPROVAL), 2, 3));
    assembler.accept(envelope(macro('status', STATUS_DECISION), 1, 3));
    assembler.accept(envelope(macro('attention', ATTENTION), 0, 3));

    const first = assembler.assemble();
    expect(assembler.assemble()).toEqual(first);
    const wire = JSON.stringify(first);
    expect(wire).not.toContain('Action needed.');
    expect(wire).not.toContain('A decision is required.');
    expect(wire).not.toContain('canonicalName');
    expect(expandNotification(first)).toBe(
      'Action needed. A decision is required. Approval is required.',
    );
  });
});
