import type { ReplyMacroCatalogEntry } from './types.js';

export const OWNER_REPLY_OK_ID = '01K4J8Q2N6C9R5T3V7W0X1YBZA';
export const OWNER_REPLY_NO_ID = '01K4J9R3P7D0S6V2W8X1Y5ZBCA';
export const OWNER_REPLY_WAIT_ID = '01K4JAT4Q8E1R7W3X9Y2Z6ABCD';

/** IDs and workflow effects only. Human labels live in expansions.ts. */
export const replyMacroCatalog = [
  {
    id: OWNER_REPLY_OK_ID,
    version: '0.1.0',
    effect: 'approve',
    terminal: true,
    deprecation: { deprecated: false },
  },
  {
    id: OWNER_REPLY_NO_ID,
    version: '0.1.0',
    effect: 'reject',
    terminal: true,
    deprecation: { deprecated: false },
  },
  {
    id: OWNER_REPLY_WAIT_ID,
    version: '0.1.0',
    effect: 'wait',
    terminal: false,
    deprecation: { deprecated: false },
  },
] as const satisfies readonly ReplyMacroCatalogEntry[];

export const replyMacroCatalogById: ReadonlyMap<string, ReplyMacroCatalogEntry> = new Map(
  replyMacroCatalog.map((macro) => [macro.id, macro]),
);
