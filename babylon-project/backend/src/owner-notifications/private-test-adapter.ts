import { serializeOwnerDecisionReply, type OwnerDecisionReply } from './protocol.js';
import type {
  OwnerReplyRouteLookup,
  OwnerReplyRouteSnapshot,
  OwnerReplyRouter,
  OwnerWorkflowState,
} from './reply-router.js';

/** Exact private/local adapter seam. Deliberately not mounted in backend/src/server.ts. */
export class LocalPrivateOwnerReplyAdapter {
  constructor(private readonly router: OwnerReplyRouter) {}

  async submit(
    serializedEnvelope: string,
  ): Promise<Readonly<{ state: OwnerWorkflowState; terminal: boolean }>> {
    let input: unknown;
    try {
      input = JSON.parse(serializedEnvelope) as unknown;
    } catch {
      input = serializedEnvelope;
    }
    return this.router.route(input);
  }

  reconcile(lookup: OwnerReplyRouteLookup): Readonly<OwnerReplyRouteSnapshot> {
    return this.router.reconcile(lookup);
  }
}

export class LocalOwnerReplyTransport {
  constructor(private readonly adapter: LocalPrivateOwnerReplyAdapter) {}

  async send(reply: OwnerDecisionReply): Promise<void> {
    await this.adapter.submit(serializeOwnerDecisionReply(reply));
  }

  reconcile(lookup: OwnerReplyRouteLookup): Readonly<OwnerReplyRouteSnapshot> {
    return this.adapter.reconcile(lookup);
  }
}
