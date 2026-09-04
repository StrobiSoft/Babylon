import { attentionMacros } from './attention/catalog.js';
import { reasonMacros } from './reason/catalog.js';
import { statusMacros } from './status/catalog.js';
import type { MacroCatalogEntry } from './types.js';

export const macroCatalog = [...attentionMacros, ...statusMacros, ...reasonMacros] as const;

export const macroCatalogById: ReadonlyMap<string, MacroCatalogEntry> = new Map(
  macroCatalog.map((macro) => [macro.id, macro]),
);
