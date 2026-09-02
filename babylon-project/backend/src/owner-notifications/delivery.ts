import type { AssembledNotificationMessage } from '../notification-macros/index.js';
import { macroExpansions } from '../notification-macros/expansion.js';

export interface EndpointMacroExpansion {
  readonly id: string;
  readonly version: string;
  readonly text: string;
}

export interface OwnerNotificationDelivery {
  readonly notification: AssembledNotificationMessage;
  readonly expansions: readonly EndpointMacroExpansion[];
}

const expansionByKey = new Map(
  macroExpansions.map((entry) => [`${entry.id}@${entry.version}`, entry]),
);

/** Endpoint adapter: expansions stay outside the portable macro-core wire object. */
export function createOwnerNotificationDelivery(
  notification: AssembledNotificationMessage,
): OwnerNotificationDelivery {
  const expansions = notification.fragments.flatMap((fragment) => {
    if (fragment.kind !== 'macro') return [];
    const expansion = expansionByKey.get(`${fragment.macroId}@${fragment.macroVersion}`);
    if (expansion === undefined) {
      throw new Error(`no endpoint expansion for ${fragment.macroId}@${fragment.macroVersion}`);
    }
    return [{ id: expansion.id, version: expansion.version, text: expansion.text }];
  });
  return { notification, expansions };
}
