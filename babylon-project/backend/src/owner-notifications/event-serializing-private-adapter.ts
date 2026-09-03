import { LocalPrivateOwnerReplyAdapter } from './private-test-adapter.js';

type SubmitResult = Awaited<ReturnType<LocalPrivateOwnerReplyAdapter['submit']>>;
type ReconcileInput = Parameters<LocalPrivateOwnerReplyAdapter['reconcile']>[0];
type ReconcileResult = Awaited<ReturnType<LocalPrivateOwnerReplyAdapter['reconcile']>>;

/**
 * Runtime wrapper for the exact local/private owner-reply adapter seam.
 *
 * A client can lose the acknowledgement while the server is still consuming the reply. Route-state
 * reconciliation for that same event must therefore wait behind the in-flight submission; otherwise
 * it can observe a stale "not consumed" snapshot and cause an unsafe duplicate retry decision.
 *
 * This wrapper is deliberately transport-neutral. It binds no socket, registers no Fastify route,
 * opens no listener, and adds no authentication mechanism. The eventual private N Agent runtime
 * must place its authenticated transport in front of this seam.
 */
export class EventSerializingPrivateOwnerReplyAdapter {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly delegate: LocalPrivateOwnerReplyAdapter) {}

  async submit(serializedEnvelope: string): Promise<SubmitResult> {
    return this.serialized(eventQueueKey(serializedEnvelope), () =>
      this.delegate.submit(serializedEnvelope),
    );
  }

  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    return this.serialized(input.eventId, async () => this.delegate.reconcile(input));
  }

  private async serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.queues.set(key, queued);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(key) === queued) this.queues.delete(key);
    }
  }
}

function eventQueueKey(serializedEnvelope: string): string {
  try {
    const decoded = JSON.parse(serializedEnvelope) as unknown;
    if (typeof decoded !== 'object' || decoded === null) return '__invalid__';
    const eventId = (decoded as Record<string, unknown>)['event_id'];
    return typeof eventId === 'string' ? eventId : '__invalid__';
  } catch {
    return '__invalid__';
  }
}
