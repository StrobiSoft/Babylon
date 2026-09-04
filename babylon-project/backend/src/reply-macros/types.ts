export const replyMacroEffects = ['approve', 'reject', 'wait'] as const;
export type ReplyMacroEffect = (typeof replyMacroEffects)[number];

export interface ReplyMacroCatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly effect: ReplyMacroEffect;
  readonly terminal: boolean;
  readonly deprecation: {
    readonly deprecated: boolean;
    readonly replacedBy?: string;
  };
}

export interface ReplyMacroExpansionEntry {
  readonly id: string;
  readonly version: string;
  readonly label: string;
}
