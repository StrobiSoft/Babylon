import { z } from 'zod';
import { macroGroups } from './types.js';

export const NOTIFICATION_MACRO_PROTOCOL_VERSION = '0.1' as const;
export const MAX_OPTIONAL_TEXT_CODE_POINTS = 280;
export const MAX_OPTIONAL_TEXT_UTF8_BYTES = 1_024;

function hasDisallowedControlCharacter(text: string): boolean {
  return Array.from(text).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      ((codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
        (codePoint >= 127 && codePoint <= 159))
    );
  });
}

function hasDisallowedUnicodeScalar(text: string): boolean {
  return Array.from(text).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      ((codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        codePoint === 0x061c ||
        codePoint === 0x200e ||
        codePoint === 0x200f ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069))
    );
  });
}

function hasVisibleContent(text: string): boolean {
  return /[^\s\p{Cf}]/u.test(text);
}

const macroIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u, 'invalid opaque macro ID');
const macroVersionSchema = z
  .string()
  .max(32)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, 'invalid macro version');

export const optionalTextSchema = z
  .string()
  .refine((text) => Array.from(text).length >= 1, 'optional text must not be empty')
  .refine(hasVisibleContent, 'optional text must contain visible content')
  .refine(
    (text) => Array.from(text).length <= MAX_OPTIONAL_TEXT_CODE_POINTS,
    `optional text exceeds ${MAX_OPTIONAL_TEXT_CODE_POINTS} Unicode code points`,
  )
  .refine(
    (text) => new TextEncoder().encode(text).byteLength <= MAX_OPTIONAL_TEXT_UTF8_BYTES,
    `optional text exceeds ${MAX_OPTIONAL_TEXT_UTF8_BYTES} UTF-8 bytes`,
  )
  .refine((text) => text === text.normalize('NFC'), 'optional text must use NFC normalization')
  .refine(
    (text) => !hasDisallowedControlCharacter(text),
    'optional text contains a disallowed control character',
  )
  .refine(
    (text) => !hasDisallowedUnicodeScalar(text),
    'optional text contains an unpaired surrogate or bidirectional formatting control',
  );

export const macroFragmentSchema = z
  .object({
    kind: z.literal('macro'),
    group: z.enum(macroGroups),
    macroId: macroIdSchema,
    macroVersion: macroVersionSchema,
  })
  .strict();

export const textFragmentSchema = z
  .object({
    kind: z.literal('optional_text'),
    text: optionalTextSchema,
  })
  .strict();

export const notificationFragmentSchema = z.discriminatedUnion('kind', [
  macroFragmentSchema,
  textFragmentSchema,
]);
export type NotificationFragment = z.infer<typeof notificationFragmentSchema>;

export const replayMetadataSchema = z
  .object({
    attempt: z.number().int().nonnegative().max(100),
    originalMessageId: z.uuid().optional(),
  })
  .strict()
  .superRefine((replay, context) => {
    if (replay.attempt === 0 && replay.originalMessageId !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['originalMessageId'],
        message: 'an original message ID is forbidden on the first attempt',
      });
    }
    if (replay.attempt > 0 && replay.originalMessageId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['originalMessageId'],
        message: 'a replay must identify the original message',
      });
    }
  });

export const notificationFragmentEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(NOTIFICATION_MACRO_PROTOCOL_VERSION),
    eventId: z.uuid(),
    messageId: z.uuid(),
    createdAt: z.iso.datetime({ offset: true }),
    sequence: z
      .object({
        message: z.number().int().nonnegative(),
        fragment: z.number().int().nonnegative(),
        totalFragments: z.number().int().min(2).max(4),
      })
      .strict(),
    replay: replayMetadataSchema,
    fragment: notificationFragmentSchema,
  })
  .strict()
  .superRefine((envelope, context) => {
    if (envelope.sequence.fragment >= envelope.sequence.totalFragments) {
      context.addIssue({
        code: 'custom',
        path: ['sequence', 'fragment'],
        message: 'fragment sequence must be smaller than totalFragments',
      });
    }
    if (
      envelope.replay.originalMessageId !== undefined &&
      envelope.replay.originalMessageId === envelope.messageId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['replay', 'originalMessageId'],
        message: 'a replay message ID must differ from its original message ID',
      });
    }
  });

export type NotificationFragmentEnvelope = z.infer<typeof notificationFragmentEnvelopeSchema>;

export interface AssembledNotificationMessage {
  readonly protocolVersion: typeof NOTIFICATION_MACRO_PROTOCOL_VERSION;
  readonly eventId: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly sequence: { readonly message: number };
  readonly replay: {
    readonly attempt: number;
    readonly originalMessageId?: string;
  };
  readonly fragments: readonly NotificationFragment[];
}
