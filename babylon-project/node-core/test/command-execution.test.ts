import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CommandRegistry,
  fingerprintPublicKey,
  InMemoryReplayStore,
  NodeCore,
  replayEnvelopeDigest,
  signEnvelope,
  type CommandDefinition,
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

type MutableCommandDefinition = {
  -readonly [Key in keyof CommandDefinition]: CommandDefinition[Key];
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
  authorize?: () => Promise<boolean> | boolean;
  maxResultBytes?: number;
  onCommandTrace?: (event: { phase: string; atMs: number }) => void;
  monotonicNow?: () => number;
}) {
  const sender = makeIdentity('node-sender-01', ['command.execute:core/status']);
  const local = makeIdentity('node-local-0001');
  const now = options?.now ?? (() => NOW);
  const journal = options?.journal ?? new TestDurableCommandJournal(now);
  const registry = new CommandRegistry();
  let executions = 0;
  const definition: MutableCommandDefinition = {
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
  };
  registry.register(definition);
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
    authorize: options?.authorize ?? (() => true),
    now,
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
  return {
    sender,
    local,
    journal,
    registry,
    definition,
    core,
    request,
    executions: () => executions,
  };
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

  it('rejects a durable RECEIVED command retried after expiry plus skew', async () => {
    let now = NOW;
    const journal = new TestDurableCommandJournal(() => now);
    journal.failNextStart = true;
    const fixture = makeCommandFixture({ journal, now: () => now });

    await expect(fixture.core.process(fixture.request)).rejects.toMatchObject({
      code: 'COMMAND_JOURNAL_FAILURE',
    });
    expect(
      (await journal.inspect(fixture.sender.peer.nodeId, fixture.request.message_id)).state,
    ).toBe('received');

    now = NOW + 60_000 + TIME_POLICY.maxLateSkewMs + 1;
    await expect(fixture.core.process(fixture.request)).rejects.toMatchObject({
      code: 'INVALID_TIME',
    });
    expect(
      (await journal.inspect(fixture.sender.peer.nodeId, fixture.request.message_id)).state,
    ).toBe('received');
    expect(fixture.executions()).toBe(0);
  });

  it('rejects a fresh command that expires in the final authorization path before START', async () => {
    let now = NOW;
    let authorizations = 0;
    const fixture = makeCommandFixture({
      now: () => now,
      authorize: () => {
        authorizations += 1;
        if (authorizations === 2) {
          now = NOW + 60_000 + TIME_POLICY.maxLateSkewMs + 1;
        }
        return true;
      },
    });

    await expect(fixture.core.process(fixture.request)).rejects.toMatchObject({
      code: 'INVALID_TIME',
    });
    expect(authorizations).toBe(2);
    expect(
      (await fixture.journal.inspect(fixture.sender.peer.nodeId, fixture.request.message_id)).state,
    ).toBe('received');
    expect(fixture.executions()).toBe(0);
  });

  it('rejects a delayed START that crosses expiry at the atomic journal boundary', async () => {
    let now = NOW;
    const journal = new TestDurableCommandJournal(() => now);
    journal.beforeStart = () => {
      now = NOW + 60_000 + TIME_POLICY.maxLateSkewMs + 1;
      return Promise.resolve();
    };
    const fixture = makeCommandFixture({ journal, now: () => now });

    await expect(fixture.core.process(fixture.request)).rejects.toMatchObject({
      code: 'INVALID_TIME',
    });
    expect(
      (await journal.inspect(fixture.sender.peer.nodeId, fixture.request.message_id)).state,
    ).toBe('received');
    expect(fixture.executions()).toBe(0);
  });

  it('binds final authorization to an immutable command definition and handler snapshot', async () => {
    const finalAuthorizationMutations: (() => void)[] = [];
    let authorizations = 0;
    let replacementExecutions = 0;
    const fixture = makeCommandFixture({
      authorize: () => {
        authorizations += 1;
        if (authorizations === 2) {
          finalAuthorizationMutations.forEach((mutate) => mutate());
        }
        return true;
      },
    });
    finalAuthorizationMutations.push(() => {
      fixture.definition.requiredCapability = 'command.execute:core/replacement';
      fixture.definition.handler = async () => {
        replacementExecutions += 1;
        return { replacement: true };
      };
      expect(() => fixture.registry.register(fixture.definition)).toThrow(
        'duplicate command registration',
      );
    });

    const result = await fixture.core.process(fixture.request);

    expect(result.body['state']).toBe('completed');
    expect(result.body['result']).toEqual({ ok: true });
    expect(authorizations).toBe(2);
    expect(fixture.executions()).toBe(1);
    expect(replacementExecutions).toBe(0);
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

  it('recovers a terminal result when complete commits and then throws', async () => {
    const journal = new TestDurableCommandJournal();
    journal.throwAfterNextComplete = true;
    const fixture = makeCommandFixture({ journal });

    const result = await fixture.core.process(fixture.request);

    expect(result.body['state']).toBe('completed');
    expect(
      (await journal.inspect(fixture.sender.peer.nodeId, fixture.request.message_id)).state,
    ).toBe('terminal');
    expect(fixture.executions()).toBe(1);
  });

  it('retains INDETERMINATE when markIndeterminate commits and then throws', async () => {
    const journal = new TestDurableCommandJournal();
    journal.throwAfterNextIndeterminate = true;
    const fixture = makeCommandFixture({
      journal,
      handler: () => Promise.reject(new Error('effect outcome unknown')),
    });

    await expect(fixture.core.process(fixture.request)).rejects.toMatchObject({
      code: 'COMMAND_JOURNAL_FAILURE',
    });
    expect(
      (await journal.inspect(fixture.sender.peer.nodeId, fixture.request.message_id)).state,
    ).toBe('indeterminate');

    const duplicate = await fixture.core.process(fixture.request);
    expect(duplicate.body['state']).toBe('blocked');
    expect(duplicate.body['reason_code']).toBe('INDETERMINATE');
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

  it('preserves one executor across lookup/receive and receive/start contention', async () => {
    const journal = new TestDurableCommandJournal();
    let lookupArrivals = 0;
    let releaseLookups: (() => void) | undefined;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });
    journal.beforeLookup = async () => {
      lookupArrivals += 1;
      if (lookupArrivals === 2) {
        journal.beforeLookup = undefined;
        releaseLookups?.();
      }
      await lookupGate;
    };

    let startArrivals = 0;
    let releaseStarts: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStarts = resolve;
    });
    journal.beforeStart = async () => {
      startArrivals += 1;
      if (startArrivals === 2) {
        journal.beforeStart = undefined;
        releaseStarts?.();
      }
      await startGate;
    };

    let releaseHandler: (() => void) | undefined;
    let reportHandlerEntered: (() => void) | undefined;
    const handlerEntered = new Promise<void>((resolve) => {
      reportHandlerEntered = resolve;
    });
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const fixture = makeCommandFixture({
      journal,
      handler: async () => {
        reportHandlerEntered?.();
        await handlerGate;
        return { ok: true };
      },
    });

    const firstPromise = fixture.core.process(fixture.request);
    const secondPromise = fixture.core.process(fixture.request);
    await handlerEntered;
    const firstSettled = await Promise.race([firstPromise, secondPromise]);
    expect(firstSettled.body['state']).toBe('accepted');
    expect(lookupArrivals).toBe(2);
    expect(startArrivals).toBe(2);
    expect(fixture.executions()).toBe(1);

    releaseHandler?.();
    const results = await Promise.all([firstPromise, secondPromise]);
    expect(results.map((result) => result.body['state']).sort()).toEqual(['accepted', 'completed']);
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

  it('extends terminal retention from the actual terminal commit time', async () => {
    let now = NOW;
    const fixture = makeCommandFixture({
      now: () => now,
      handler: () => {
        now = NOW + 20 * 60_000;
        return { ok: true };
      },
    });

    await fixture.core.process(fixture.request);
    const terminal = await fixture.journal.inspect(
      fixture.sender.peer.nodeId,
      fixture.request.message_id,
    );
    expect(terminal.state).toBe('terminal');
    expect(terminal.terminalAtMs).toBe(now);
    expect(terminal.retainUntilMs).toBe(now + COMMAND_POLICY.resultRetentionMs);
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

  it('rejects stale attempts across STARTED, INDETERMINATE, and TERMINAL transitions', async () => {
    const journal = new TestDurableCommandJournal();
    const digest = replayEnvelopeDigest(makeCommandFixture().request);
    await journal.receive({
      senderNodeId: 'node-sender-01',
      messageId: 'stale-transition-0001',
      envelopeDigest: digest,
      retainUntilMs: NOW + COMMAND_POLICY.resultRetentionMs,
      command: {
        tableId: 'core',
        tableVersion: '1',
        commandId: 'status',
        requiredCapability: 'command.execute:core/status',
        executionSemantics: 'at-most-once',
      },
      receivedAtMs: NOW,
    });
    const started = await journal.start({
      senderNodeId: 'node-sender-01',
      messageId: 'stale-transition-0001',
      envelopeDigest: digest,
      attemptId: 'current-attempt',
      validUntilMs: NOW + 1,
    });
    expect(started.kind).toBe('applied');

    const staleStartedMark = await journal.markIndeterminate(
      'node-sender-01',
      'stale-transition-0001',
      digest,
      'stale-attempt',
      NOW,
    );
    const staleStartedComplete = await journal.complete(
      'node-sender-01',
      'stale-transition-0001',
      digest,
      'stale-attempt',
      { state: 'failed' },
      NOW,
      NOW + COMMAND_POLICY.resultRetentionMs,
    );
    expect(staleStartedMark.kind).toBe('stale');
    expect(staleStartedComplete.kind).toBe('stale');
    expect((await journal.inspect('node-sender-01', 'stale-transition-0001')).state).toBe(
      'started',
    );

    await journal.markIndeterminate(
      'node-sender-01',
      'stale-transition-0001',
      digest,
      'current-attempt',
      NOW,
    );
    const staleIndeterminateStart = await journal.start({
      senderNodeId: 'node-sender-01',
      messageId: 'stale-transition-0001',
      envelopeDigest: digest,
      attemptId: 'stale-attempt',
      validUntilMs: NOW + 1,
    });
    const staleIndeterminateComplete = await journal.complete(
      'node-sender-01',
      'stale-transition-0001',
      digest,
      'stale-attempt',
      { state: 'failed' },
      NOW,
      NOW + COMMAND_POLICY.resultRetentionMs,
    );
    expect(staleIndeterminateStart.kind).toBe('stale');
    expect(staleIndeterminateComplete.kind).toBe('stale');
    expect((await journal.inspect('node-sender-01', 'stale-transition-0001')).state).toBe(
      'indeterminate',
    );

    const fixture = makeCommandFixture();
    await fixture.core.process(fixture.request);
    const terminal = await fixture.journal.inspect(
      fixture.sender.peer.nodeId,
      fixture.request.message_id,
    );
    expect(terminal.state).toBe('terminal');

    const staleTerminalStart = await fixture.journal.start({
      senderNodeId: fixture.sender.peer.nodeId,
      messageId: fixture.request.message_id,
      envelopeDigest: replayEnvelopeDigest(fixture.request),
      attemptId: 'stale-attempt-id',
      validUntilMs: NOW + 1,
    });
    const staleTerminalMark = await fixture.journal.markIndeterminate(
      fixture.sender.peer.nodeId,
      fixture.request.message_id,
      replayEnvelopeDigest(fixture.request),
      'stale-attempt-id',
      NOW + 1,
    );
    const staleTerminalComplete = await fixture.journal.complete(
      fixture.sender.peer.nodeId,
      fixture.request.message_id,
      replayEnvelopeDigest(fixture.request),
      'stale-attempt-id',
      { state: 'failed', reasonCode: 'STALE_WRITE' },
      NOW + 1,
      NOW + COMMAND_POLICY.resultRetentionMs + 1,
    );
    expect(staleTerminalStart.kind).toBe('stale');
    expect(staleTerminalMark.kind).toBe('stale');
    expect(staleTerminalComplete.kind).toBe('stale');
    expect(staleTerminalComplete.entry.state).toBe('terminal');
    expect(staleTerminalComplete.entry.terminal?.state).toBe('completed');
  });
});
