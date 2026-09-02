import { z } from 'zod';
import { optionalTextSchema } from '../notification-macros/transport.js';

export const OWNER_REPLY_PROTOCOL_VERSION = '0.1' as const;
export const ownerDecisions = ['APPROVE', 'REJECT', 'WAIT'] as const;
export type OwnerDecision = (typeof ownerDecisions)[number];

export const ownerDecisionReplySchema = z
  .object({
    protocol_version: z.literal(OWNER_REPLY_PROTOCOL_VERSION),
    event_id: z.uuid(),
    decision: z.enum(ownerDecisions),
    timestamp: z.iso.datetime({ offset: true }),
    sequence: z.number().int().nonnegative().max(2_147_483_647),
    comment: optionalTextSchema.optional(),
  })
  .strict();

export type OwnerDecisionReply = z.infer<typeof ownerDecisionReplySchema>;

export function serializeOwnerDecisionReply(input: unknown): string {
  const reply = ownerDecisionReplySchema.parse(input);
  return JSON.stringify({
    protocol_version: reply.protocol_version,
    event_id: reply.event_id,
    decision: reply.decision,
    timestamp: reply.timestamp,
    sequence: reply.sequence,
    ...(reply.comment === undefined ? {} : { comment: reply.comment }),
  });
}

export interface OwnerReplyTransport {
  send(reply: OwnerDecisionReply): Promise<void>;
}
