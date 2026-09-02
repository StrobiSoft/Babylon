import { attentionExpansions } from './attention/expansions.js';
import { reasonExpansions } from './reason/expansions.js';
import { statusExpansions } from './status/expansions.js';
import type { AssembledNotificationMessage } from './transport.js';
import type { MacroExpansionEntry } from './types.js';

export const macroExpansions = [
  ...attentionExpansions,
  ...statusExpansions,
  ...reasonExpansions,
] as const;

const expansionTable: ReadonlyMap<string, MacroExpansionEntry> = new Map(
  macroExpansions.map((entry) => [`${entry.id}@${entry.version}`, entry]),
);

export function expandNotification(message: AssembledNotificationMessage): string {
  return message.fragments
    .map((fragment) => {
      if (fragment.kind === 'optional_text') return fragment.text;
      const entry = expansionTable.get(`${fragment.macroId}@${fragment.macroVersion}`);
      if (entry === undefined) {
        throw new Error(`no endpoint expansion for ${fragment.macroId}@${fragment.macroVersion}`);
      }
      return entry.text;
    })
    .join(' ');
}
