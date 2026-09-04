import { serializeOwnerDecisionReply, type OwnerDecisionReply } from './protocol.js';
import type { OwnerReplyRouter, OwnerWorkflowState } from './reply-router.js';

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
}

export class LocalOwnerReplyTransport {
  constructor(private readonly adapter: LocalPrivateOwnerReplyAdapter) {}

  async send(reply: OwnerDecisionReply): Promise<void> {
    await this.adapter.submit(serializeOwnerDecisionReply(reply));
  }
}
