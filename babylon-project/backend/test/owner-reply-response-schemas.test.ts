import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OWNER_REPLY_NO_ID,
  OWNER_REPLY_OK_ID,
  OWNER_REPLY_WAIT_ID,
} from '../src/reply-macros/index.js';

interface ObjectSchema {
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, unknown>;
}

function readSchema(name: string): ObjectSchema {
  return JSON.parse(
    readFileSync(new URL(`../../docs/schemas/${name}`, import.meta.url), 'utf8'),
  ) as ObjectSchema;
}

describe('private owner reply response schemas', () => {
  it('pins the explicit accepted-sequence response and rejects extra fields', () => {
    const schema = readSchema('owner-reply-acceptance-v0.1.schema.json');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['accepted_sequence', 'state', 'terminal']);
    expect(Object.keys(schema.properties)).toEqual(['accepted_sequence', 'state', 'terminal']);
  });

  it('pins the bounded reconciliation response and canonical reply IDs', () => {
    const schema = readSchema('owner-reply-reconciliation-v0.1.schema.json');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      'workflow',
      'last_accepted_sequence',
      'last_accepted_reply_macro_id',
    ]);
    expect(Object.keys(schema.properties)).toEqual([
      'workflow',
      'last_accepted_sequence',
      'last_accepted_reply_macro_id',
    ]);

    const macroProperty = schema.properties['last_accepted_reply_macro_id'] as {
      oneOf: Array<{ enum?: string[] }>;
    };
    expect(macroProperty.oneOf[0]?.enum).toEqual([
      OWNER_REPLY_OK_ID,
      OWNER_REPLY_NO_ID,
      OWNER_REPLY_WAIT_ID,
    ]);
  });
});
