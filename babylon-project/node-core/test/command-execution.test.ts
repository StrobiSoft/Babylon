import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CommandRegistry,
  fingerprintPublicKey,
  InMemoryReplayStore,
  NodeCore,
  replayEnvelopeDigest,
  signEnvelope,
  type PeerIdentity,
  type SignedBnpEnvelope,
  type UnsignedBnpEnvelope,
} from '../src/index.js';
import { TestDurableCommandJournal } from './test-command-journal.js';

const NOW = Date.parse('2026-09-07T03:00:00.000Z');
const TIME_POLICY = {
  maxFutureSkewMs: 30_000,
  maxLateSkewMs: 30_000,
  maxLifetimeMs: 300_000,
};
const COMMAND_POLICY = {
  maxResultBytes: 16_384,
  resultRetentionMs: 600_000,
};

function makeIdentity(nodeId: string, capabilities: string[] = []) {
  const pair = generateKeyPairSync('ed25519');
  const fingerprint = fingerprintPublicKey(pair.publicKey);
  const peer: PeerIdentity = {
    nodeId,
    status: 'active',
    keys: new Map([[fingerprint, { publicKey: pair.publicKey, status: 'active' as const }]]),
    capabilities: new Set(capabilities),
  };
  return { ...pair, fingerprint, peer };
}

function signRequest(
  privateKey: KeyObject,
  fingerprint: string,
  fields: Partial<UnsignedBnpEnvelope> & Pick<UnsignedBnpEnvelope, 'kind' | 'from' | 'to' | 'body'>,
): SignedBnpEnvelope {
  return signEnvelope(
    {
      bnp: '1',
      message_id: 'command-execution-0001',
      issued_at: '2026-09-07T03:00:00.000Z',
      expires_at: '2026-09-07T03:01:00.000Z',
      key_fingerprint: fingerprint,
      ...fields,
    },
    privateKey,
  );
}

function makeCommandFixture(options?: {
  handler?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  journal?: TestDurableCommandJournal;
  now?: () => number;
  maxResultBytes?: number;
  onCommandTrace?: (event: { phase: string; atMs: number }) => void;
  monotonicNow?: () => number;
}) {
  const sender = makeIdentity('node-sender-01', ['command.execute:core/status']);
  const local = makeIdentity('node-local-0001');
  const journal = options?.journal ?? new TestDurableCommandJournal();
  const registry = new CommandRegistry();
  let executions = 0;
  registry.register({
    table_id: 'core',
    table_version: '1',
    command_id: 'status',
    requiredCapability: 'command.execute:core/status',
    executionSemantics: 'at-most-once',
    handler: async () => {
      executions += 1;
      const result = await (options?.handler?.() ?? Promise.resolve({ ok: true }));
      return result as never;
    },
  });
  const core = new NodeCore({
    nodeId: local.peer.nodeId,
    privateKey: local.privateKey,
    keyFingerprint: local.fingerprint,
    replayStore: new InMemoryReplayStore(),
    commandJournal: journal,
    commandExecutionPolicy: {
      ...COMMAND_POLICY,
      maxResultBytes: options?.maxResultBytes ?? COMMAND_POLICY.maxResultBytes,
    },
    commandRegistry: registry,
    timePolicy: TIME_POLICY,
    responseLifetimeMs: 60_000,
    resolvePeer: () => sender.peer,
    authorize: () => true,
    now: options?.now ?? (() => NOW),
    ...(options?.onCommandTrace === undefined
      ? {}
      : { onCommandTrace: options.onCommandTrace as never }),
    ...(options?.monotonicNow === undefined ? {} : { monotonicNow: options.monotonicNow }),
  });
  const request = signRequest(sender.privateKey, sender.fingerprint, {
    kind: 'command',
    from: sender.peer.nodeId,
    to: local.peer.nodeId,
    body: { table_id: 'core', table_version: '1', command_id: 'status' },
  });
  return { sender, local, journal, registry, core, request, executions: () => executions };
}

describe('NODE IJET COMMAND execution journal', () => {
  it('recovers a durable RECEIVED record after a START gate failure without duplicate execution', async () => {
    const journal = new TestDurableCommandJournal();
    journal.failNextStart = true;
    const fixture = makeCommandFixture({ journal });

    await expect(fixture.core.process(fixture.request)).rejects.toMatchObject({
      code: 'COMMAND_JOURNAL_FAILURE',
    });
    expect(
      (await journal.inspect(fixture.sender.peer.nodeId, fixture.request.message_id)).state,
    ).toBe('received');
    expect(fixture.executions()).toBe(0);

    const retry = await fixture.core.process(fixture.request);
    expect(retry.body['state']).toBe('completed');
    expect(fixture.executions()).toBe(1);
  });

  it('quarantines handler failure as INDETERMINATE and does not auto-rerun it', async () => {
    const fixture = makeCommandFixture({
      handler: () => Promise.reject(new Error('effect outcome unknown')),
    });

    const first = await fixture.core.process(fixture.request);
    expect(first.body['state']).toBe('blocked');
    expect(first.body['reason_code']).toBe('INDETERMINATE');
    expect(
      (await fixture.journal.inspect(fixture.sender.peer.nodeId, fixture.request.message_id)).state,
    ).toBe('indeterminate');

    const duplicate = await fixture.core.process(fixture.request);
    expect(duplicate.body['state']).toBe('blocked');
    expect(fixture.executions()).toBe(1);
  });

  it('leaves STARTED conservative when terminal persistence fails after handler return', async () => {
    const journal = new TestDurableCommandJournal();
    journal.failNextComplete = true;
    const fixture = makeCommandFixture({ journal });

    await expect(fixture.core.process(fixture.request)).rejects.toMatchObject({
      code: 'COMMAND_JOURNAL_FAILURE',
    });
    const started = await journal.inspect(fixture.sender.peer.nodeId, fixture.request.message_id);
    expect(started.state).toBe('started');
    expect(fixture.executions()).toBe(1);

    const duplicate = await fixture.core.process(fixture.request);
    expect(duplicate.body['state']).toBe('accepted');
    expect(fixture.executions()).toBe(1);
  });

  it('allows only one concurrent executor past the atomic STARTED gate', async () => {
    let releaseHandler: (() => void) | undefined;
    let reportEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      reportEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const fixture = makeCommandFixture({
      handler: async () => {
        reportEntered?.();
        await gate;
        return { ok: true };
      },
    });

    const firstPromise = fixture.core.process(fixture.request);
    await entered;
    const concurrent = await fixture.core.process(fixture.request);
    expect(concurrent.body['state']).toBe('accepted');
    expect(fixture.executions()).toBe(1);

    releaseHandler?.();
    const first = await firstPromise;
    expect(first.body['state']).toBe('completed');
    expect(fixture.executions()).toBe(1);
  });

  it('replays a known terminal result after request expiry but rejects a new expired command', async () => {
    let now = NOW;
    const fixture = makeCommandFixture({ now: () => now });
    const first = await fixture.core.process(fixture.request);
    expect(first.body['state']).toBe('completed');

    now = NOW + 15 * 60_000;
    const duplicate = await fixture.core.process(fixture.request);
    expect(duplicate.body['state']).toBe('completed');
    expect(fixture.executions()).toBe(1);

    const newExpired = signRequest(fixture.sender.privateKey, fixture.sender.fingerprint, {
      kind: 'command',
      from: fixture.sender.peer.nodeId,
      to: fixture.local.peer.nodeId,
      message_id: 'command-execution-0002',
      body: { table_id: 'core', table_version: '1', command_id: 'status' },
    });
    await expect(fixture.core.process(newExpired)).rejects.toMatchObject({ code: 'INVALID_TIME' });
  });

  it('treats an oversized handler result as INDETERMINATE rather than pretending the effect failed', async () => {
    const fixture = makeCommandFixture({
      maxResultBytes: 16,
      handler: () => ({ value: 'this-result-is-too-large' }),
    });

    const result = await fixture.core.process(fixture.request);
    expect(result.body['state']).toBe('blocked');
    expect(result.body['reason_code']).toBe('INDETERMINATE');
    expect(
      (await fixture.journal.inspect(fixture.sender.peer.nodeId, fixture.request.message_id)).state,
    ).toBe('indeterminate');
  });

  it('keeps command instrumentation metadata-only and non-blocking', async () => {
    const phases: string[] = [];
    let tick = 0;
    const fixture = makeCommandFixture({
      onCommandTrace: (event) => {
        phases.push(event.phase);
        if (event.phase === 'handler_returned') {
          throw new Error('observer failure must not affect execution');
        }
      },
      monotonicNow: () => {
        tick += 1;
        return tick;
      },
    });

    const result = await fixture.core.process(fixture.request);
    expect(result.body['state']).toBe('completed');
    expect(phases).toContain('received');
    expect(phases).toContain('started');
    expect(phases).toContain('handler_returned');
    expect(phases).toContain('terminal_committed');
    expect(phases).toContain('response_signed');
  });

  it('keeps TERMINAL immutable against a stale attempt', async () => {
    const fixture = makeCommandFixture();
    await fixture.core.process(fixture.request);
    const terminal = await fixture.journal.inspect(
      fixture.sender.peer.nodeId,
      fixture.request.message_id,
    );
    expect(terminal.state).toBe('terminal');

    const stale = await fixture.journal.complete(
      fixture.sender.peer.nodeId,
      fixture.request.message_id,
      replayEnvelopeDigest(fixture.request),
      'stale-attempt-id',
      { state: 'failed', reasonCode: 'STALE_WRITE' },
      NOW + 1,
    );
    expect(stale.kind).toBe('stale');
    expect(stale.entry.state).toBe('terminal');
    expect(stale.entry.terminal?.state).toBe('completed');
  });
});
