import type { MacroCatalogEntry } from '../types.js';

export const reasonMacros = [
  {
    id: '01JQ803C6N9M2K5D8F4H0R1BVA',
    version: '0.1.0',
    group: 'reason',
    canonicalName: 'requested_work_finished',
    audience: ['shared'],
    deprecation: { deprecated: false },
  },
  {
    id: '01JQ816N4C7M9K2D5F8H0R3BVA',
    version: '0.1.0',
    group: 'reason',
    canonicalName: 'more_information_required',
    audience: ['operator'],
    deprecation: { deprecated: false },
  },
  {
    id: '01JQ829M5C8N2K7D4F9H0R3BVA',
    version: '0.1.0',
    group: 'reason',
    canonicalName: 'dependency_unavailable',
    audience: ['shared'],
    deprecation: { deprecated: false },
  },
  {
    id: '01JQ83CN6M9K2D5F8H4R0B1VXA',
    version: '0.1.0',
    group: 'reason',
    canonicalName: 'validation_failed',
    audience: ['shared'],
    deprecation: { deprecated: false },
  },
  {
    id: '01JQ84FM7N2C9K5D8H4R0B3VXA',
    version: '0.1.0',
    group: 'reason',
    canonicalName: 'approval_required',
    audience: ['operator'],
    deprecation: { deprecated: false },
  },
] as const satisfies readonly MacroCatalogEntry[];
