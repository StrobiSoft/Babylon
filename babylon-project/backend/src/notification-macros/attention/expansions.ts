import type { MacroExpansionEntry } from '../types.js';

export const attentionExpansions = [
  { id: '01JQ7R9M2X5K8V3B6N4C1F0DYA', version: '0.1.0', text: 'Please note.' },
  { id: '01JQ7S4C8N2W6K9D3F5H0M1PXT', version: '0.1.0', text: 'Action needed.' },
  { id: '01JQ7T6V3B9N5K2M8C4D1F0RWA', version: '0.1.0', text: 'Urgent attention required.' },
] as const satisfies readonly MacroExpansionEntry[];
