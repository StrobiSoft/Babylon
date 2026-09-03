import type { ReplyMacroExpansionEntry } from './types.js';
import { OWNER_REPLY_NO_ID, OWNER_REPLY_OK_ID, OWNER_REPLY_WAIT_ID } from './catalog.js';

/** Trusted endpoint data. Transport and router modules must not import this file. */
export const replyMacroExpansions = [
  { id: OWNER_REPLY_OK_ID, version: '0.1.0', label: 'OK / mehet' },
  { id: OWNER_REPLY_NO_ID, version: '0.1.0', label: 'Semmiképp' },
  { id: OWNER_REPLY_WAIT_ID, version: '0.1.0', label: 'Kérlek, várj' },
] as const satisfies readonly ReplyMacroExpansionEntry[];
