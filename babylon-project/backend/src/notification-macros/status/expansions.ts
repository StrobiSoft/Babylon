import type { MacroExpansionEntry } from '../types.js';

export const statusExpansions = [
  { id: '01JQ7V2H8M4K6C9N3D5F0R1BXP', version: '0.1.0', text: 'Work has started.' },
  { id: '01JQ7W5N2C8M4K9D6F3H0R1BVA', version: '0.1.0', text: 'Work is complete.' },
  { id: '01JQ7X8C5N2K4M9D6F3H0R1BVT', version: '0.1.0', text: 'Work is blocked.' },
  { id: '01JQ7Y3M8C5N2K9D6F4H0R1BVA', version: '0.1.0', text: 'A decision is required.' },
  { id: '01JQ7Z6N3C8M5K2D9F4H0R1BVA', version: '0.1.0', text: 'Work failed.' },
] as const satisfies readonly MacroExpansionEntry[];
