export const macroGroups = ['attention', 'status', 'reason'] as const;
export type MacroGroup = (typeof macroGroups)[number];

export const macroAudiences = ['operator', 'agent', 'shared'] as const;
export type MacroAudience = (typeof macroAudiences)[number];

export const macroSeverities = ['info', 'success', 'warning', 'error', 'critical'] as const;
export type MacroSeverity = (typeof macroSeverities)[number];

export const macroPriorities = ['low', 'normal', 'high', 'urgent'] as const;
export type MacroPriority = (typeof macroPriorities)[number];

export interface MacroDeprecationState {
  readonly deprecated: boolean;
  readonly replacedBy?: string;
}

interface MacroCatalogEntryBase {
  readonly id: string;
  readonly version: string;
  readonly canonicalName: string;
  readonly audience: readonly MacroAudience[];
  readonly deprecation: MacroDeprecationState;
}

export type MacroCatalogEntry =
  | (MacroCatalogEntryBase & {
      readonly group: 'attention';
      readonly severity: MacroSeverity;
      readonly priority: MacroPriority;
    })
  | (MacroCatalogEntryBase & {
      readonly group: 'status';
      readonly severity: MacroSeverity;
      readonly priority: MacroPriority;
      readonly statusKind: 'progress' | 'terminal' | 'decision';
    })
  | (MacroCatalogEntryBase & { readonly group: 'reason' });

export interface MacroExpansionEntry {
  readonly id: string;
  readonly version: string;
  readonly text: string;
}
