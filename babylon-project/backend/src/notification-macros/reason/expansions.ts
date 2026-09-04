import type { MacroExpansionEntry } from '../types.js';

export const reasonExpansions = [
  { id: '01JQ803C6N9M2K5D8F4H0R1BVA', version: '0.1.0', text: 'The requested work finished.' },
  { id: '01JQ816N4C7M9K2D5F8H0R3BVA', version: '0.1.0', text: 'More information is required.' },
  {
    id: '01JQ829M5C8N2K7D4F9H0R3BVA',
    version: '0.1.0',
    text: 'A required dependency is unavailable.',
  },
  { id: '01JQ83CN6M9K2D5F8H4R0B1VXA', version: '0.1.0', text: 'Validation failed.' },
  { id: '01JQ84FM7N2C9K5D8H4R0B3VXA', version: '0.1.0', text: 'Approval is required.' },
] as const satisfies readonly MacroExpansionEntry[];
