import type { MacroCatalogEntry } from '../types.js';

export const attentionMacros = [
  {
    id: '01JQ7R9M2X5K8V3B6N4C1F0DYA',
    version: '0.1.0',
    group: 'attention',
    canonicalName: 'please_note',
    audience: ['shared'],
    severity: 'info',
    priority: 'normal',
    deprecation: { deprecated: false },
  },
  {
    id: '01JQ7S4C8N2W6K9D3F5H0M1PXT',
    version: '0.1.0',
    group: 'attention',
    canonicalName: 'action_needed',
    audience: ['operator'],
    severity: 'warning',
    priority: 'high',
    deprecation: { deprecated: false },
  },
  {
    id: '01JQ7T6V3B9N5K2M8C4D1F0RWA',
    version: '0.1.0',
    group: 'attention',
    canonicalName: 'urgent_attention',
    audience: ['operator'],
    severity: 'critical',
    priority: 'urgent',
    deprecation: { deprecated: false },
  },
] as const satisfies readonly MacroCatalogEntry[];
