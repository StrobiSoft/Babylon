import { z } from 'zod';

export const OWNER_REPLY_PROTOCOL_VERSION = '0.1' as const;
export const opaqueReplyMacroIdSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u, 'invalid opaque reply macro ID');
export const opaqueHandleSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u, 'invalid opaque handle');

export const ownerDecisionReplySchema = z
  .object({
    protocol_version: z.literal(OWNER_REPLY_PROTOCOL_VERSION),
    event_id: z.uuid(),
    reply_macro_id: opaqueReplyMacroIdSchema,
    sequence: z.number().int().nonnegative().max(2_147_483_647),
    timestamp: z.iso.datetime({ offset: true }),
    sender_id: opaqueHandleSchema,
    return_route: opaqueHandleSchema,
  })
  .strict();

export type OwnerDecisionReply = z.infer<typeof ownerDecisionReplySchema>;

export function serializeOwnerDecisionReply(input: unknown): string {
  const reply = ownerDecisionReplySchema.parse(input);
  return JSON.stringify({
    protocol_version: reply.protocol_version,
    event_id: reply.event_id,
    reply_macro_id: reply.reply_macro_id,
    sequence: reply.sequence,
    timestamp: reply.timestamp,
    sender_id: reply.sender_id,
    return_route: reply.return_route,
  });
}

export interface OwnerReplyTransport {
  send(reply: OwnerDecisionReply): Promise<void>;
}
