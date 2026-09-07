export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export const BNP_KINDS = [
  'wake',
  'read',
  'read_result',
  'command',
  'command_result',
  'ack',
  'error',
] as const;

export type BnpKind = (typeof BNP_KINDS)[number];

export interface UnsignedBnpEnvelope {
  bnp: '1';
  kind: BnpKind;
  message_id: string;
  from: string;
  to: string;
  issued_at: string;
  expires_at: string;
  key_fingerprint: string;
  body: JsonObject;
  in_reply_to?: string;
}

export interface SignedBnpEnvelope extends UnsignedBnpEnvelope {
  signature: string;
}

export type NodeLifecycleStatus = 'pending' | 'active' | 'rotating' | 'suspended' | 'revoked';

export type CommandExecutionSemantics = 'idempotent' | 'at-most-once' | 'state-checked';
