import {
  ownerDecisionReplySchema,
  serializeOwnerDecisionReply,
  type OwnerDecisionReply,
} from './protocol.js';
import type {
  OwnerReplyRouteLookup,
  OwnerReplyRouteSnapshot,
  OwnerReplyRouter,
  OwnerWorkflowState,
} from './reply-router.js';

export interface OwnerReplyAcceptedResponse {
  readonly accepted_sequence: number;
  readonly state: OwnerWorkflowState;
  readonly terminal: boolean;
}

/** Exact private/local adapter seam. Deliberately not mounted in backend/src/server.ts. */
export class LocalPrivateOwnerReplyAdapter {
  constructor(private readonly router: OwnerReplyRouter) {}

  async submit(serializedEnvelope: string): Promise<Readonly<OwnerReplyAcceptedResponse>> {
    let input: unknown;
    try {
      input = JSON.parse(serializedEnvelope) as unknown;
    } catch {
      input = serializedEnvelope;
    }
    const routed = await this.router.route(input);
    const accepted = ownerDecisionReplySchema.parse(input);
    return {
      accepted_sequence: accepted.sequence,
      state: routed.state,
      terminal: routed.terminal,
    };
  }

  reconcile(lookup: OwnerReplyRouteLookup): Promise<Readonly<OwnerReplyRouteSnapshot>> {
    return this.router.reconcile(lookup);
  }
}

export class LocalOwnerReplyTransport {
  constructor(private readonly adapter: LocalPrivateOwnerReplyAdapter) {}

  send(reply: OwnerDecisionReply): Promise<Readonly<OwnerReplyAcceptedResponse>> {
    return this.adapter.submit(serializeOwnerDecisionReply(reply));
  }

  reconcile(lookup: OwnerReplyRouteLookup): Promise<Readonly<OwnerReplyRouteSnapshot>> {
    return this.adapter.reconcile(lookup);
  }
}
