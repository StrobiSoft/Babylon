import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CommandRegistry,
  fingerprintPublicKey,
  InMemoryReplayStore,
  NodeCore,
  signEnvelope,
  verifyEnvelopeSignature,
  type PeerIdentity,
  type ReplayClaim,
  type ReplayStore,
  type SignedBnpEnvelope,
  type UnsignedBnpEnvelope,
} from '../src/index.js';
import { TestDurableCommandJournal } from './test-command-journal.js';

class RecordingReplayStore implements ReplayStore {
  readonly durable = true;
  retainUntilMs: number | undefined;

  claim(_senderNodeId: string, _messageId: string, retainUntilMs: number): Promise<ReplayClaim> {
    this.retainUntilMs = retainUntilMs;
    return Promise.resolve('fresh');
  }
}

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
      message_id: 'message-0000000001',
      issued_at: '2026-09-07T03:00:00.000Z',
      expires_at: '2026-09-07T03:01:00.000Z',
      key_fingerprint: fingerprint,
      ...fields,
    },
    privateKey,
  );
}

describe('NODE IJET Node Core', () => {
  it('signs a full envelope and detects tampering', () => {
    const sender = makeIdentity('node-sender-01');
    const envelope = signRequest(sender.privateKey, sender.fingerprint, {
      kind: 'wake',
      from: sender.peer.nodeId,
      to: 'node-target-01',
      body: { event_code: 'N18-01' },
    });

    expect(verifyEnvelopeSignature(envelope, sender.publicKey)).toBe(true);
    expect(verifyEnvelopeSignature({ ...envelope, to: 'node-target-02' }, sender.publicKey)).toBe(
      false,
    );
  });

  it('executes an authorized command once and replays its durable terminal outcome', async () => {
    const sender = makeIdentity('node-sender-01', ['command.execute:core/status']);
    const local = makeIdentity('node-local-0001');
    const registry = new CommandRegistry();
    const journal = new TestDurableCommandJournal();
    let executions = 0;
    registry.register({
      table_id: 'core',
      table_version: '1',
      command_id: 'status',
      requiredCapability: 'command.execute:core/status',
      executionSemantics: 'at-most-once',
      handler: () => {
        executions += 1;
        return { ok: true };
      },
    });

    const makeCore = () =>
      new NodeCore({
        nodeId: local.peer.nodeId,
        privateKey: local.privateKey,
        keyFingerprint: local.fingerprint,
        replayStore: new InMemoryReplayStore(),
        commandJournal: journal,
        commandExecutionPolicy: COMMAND_POLICY,
        commandRegistry: registry,
        timePolicy: TIME_POLICY,
        responseLifetimeMs: 60_000,
        resolvePeer: (nodeId) => (nodeId === sender.peer.nodeId ? sender.peer : null),
        authorize: () => true,
        now: () => NOW,
      });
    const core = makeCore();

    const request = signRequest(sender.privateKey, sender.fingerprint, {
      kind: 'command',
      from: sender.peer.nodeId,
      to: local.peer.nodeId,
      body: { table_id: 'core', table_version: '1', command_id: 'status' },
    });

    const result = await core.process(request);
    expect(result.kind).toBe('command_result');
    expect(result.body['state']).toBe('completed');
    expect(result.in_reply_to).toBe(request.message_id);
    expect(executions).toBe(1);

    const duplicate = await core.process(request);
    expect(duplicate.body['state']).toBe('completed');
    expect(executions).toBe(1);

    const changedContent = signRequest(sender.privateKey, sender.fingerprint, {
      kind: 'command',
      from: sender.peer.nodeId,
      to: local.peer.nodeId,
      body: { table_id: 'core', table_version: '1', command_id: 'different' },
    });
    await expect(core.process(changedContent)).rejects.toMatchObject({
      code: 'REPLAY_DETECTED',
    });

    const afterRestart = await makeCore().process(request);
    expect(afterRestart.body['state']).toBe('completed');
    expect(executions).toBe(1);
  });

  it('refuses COMMAND when the durable command journal is unavailable', async () => {
    const sender = makeIdentity('node-sender-01', ['command.execute:core/status']);
    const local = makeIdentity('node-local-0001');
    const registry = new CommandRegistry();
    registry.register({
      table_id: 'core',
      table_version: '1',
      command_id: 'status',
      requiredCapability: 'command.execute:core/status',
      executionSemantics: 'idempotent',
      handler: () => ({ ok: true }),
    });

    const core = new NodeCore({
      nodeId: local.peer.nodeId,
      privateKey: local.privateKey,
      keyFingerprint: local.fingerprint,
      replayStore: new InMemoryReplayStore(),
      commandExecutionPolicy: COMMAND_POLICY,
      commandRegistry: registry,
      timePolicy: TIME_POLICY,
      responseLifetimeMs: 60_000,
      resolvePeer: () => sender.peer,
      authorize: () => true,
      now: () => NOW,
    });

    const request = signRequest(sender.privateKey, sender.fingerprint, {
      kind: 'command',
      from: sender.peer.nodeId,
      to: local.peer.nodeId,
      body: { table_id: 'core', table_version: '1', command_id: 'status' },
    });

    await expect(core.process(request)).rejects.toMatchObject({
      code: 'DURABLE_REPLAY_REQUIRED',
    });
  });

  it('requires both declared capability and local policy for READ', async () => {
    const sender = makeIdentity('node-sender-01', ['state.read:self']);
    const local = makeIdentity('node-local-0001');
    const core = new NodeCore({
      nodeId: local.peer.nodeId,
      privateKey: local.privateKey,
      keyFingerprint: local.fingerprint,
      replayStore: new InMemoryReplayStore(),
      commandRegistry: new CommandRegistry(),
      timePolicy: TIME_POLICY,
      responseLifetimeMs: 60_000,
      resolvePeer: () => sender.peer,
      authorize: ({ resource }) => resource === 'task.current',
      onRead: () => ({ phase: 'ready' }),
      now: () => NOW,
    });

    const accepted = signRequest(sender.privateKey, sender.fingerprint, {
      kind: 'read',
      from: sender.peer.nodeId,
      to: local.peer.nodeId,
      body: { resource: 'task.current', view: 'self' },
    });
    const response = await core.process(accepted);
    expect(response.kind).toBe('read_result');

    const denied = signRequest(sender.privateKey, sender.fingerprint, {
      kind: 'read',
      from: sender.peer.nodeId,
      to: local.peer.nodeId,
      message_id: 'message-0000000002',
      body: { resource: 'secret.other', view: 'self' },
    });
    await expect(core.process(denied)).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
    });
  });

  it('treats duplicate WAKE delivery as harmless', async () => {
    const sender = makeIdentity('node-sender-01');
    const local = makeIdentity('node-local-0001');
    let wakes = 0;
    const core = new NodeCore({
      nodeId: local.peer.nodeId,
      privateKey: local.privateKey,
      keyFingerprint: local.fingerprint,
      replayStore: new InMemoryReplayStore(),
      commandRegistry: new CommandRegistry(),
      timePolicy: TIME_POLICY,
      responseLifetimeMs: 60_000,
      resolvePeer: () => sender.peer,
      authorize: () => true,
      onWake: () => {
        wakes += 1;
      },
      now: () => NOW,
    });

    const request = signRequest(sender.privateKey, sender.fingerprint, {
      kind: 'wake',
      from: sender.peer.nodeId,
      to: local.peer.nodeId,
      body: { event_code: 'N18-01' },
    });

    const first = await core.process(request);
    const duplicate = await core.process(request);
    expect(first.body['status']).toBe('accepted');
    expect(duplicate.body['status']).toBe('duplicate');
    expect(wakes).toBe(1);
  });

  it('retains replay identity through expiry plus caller-supplied late skew', async () => {
    const sender = makeIdentity('node-sender-01');
    const local = makeIdentity('node-local-0001');
    const replayStore = new RecordingReplayStore();
    const core = new NodeCore({
      nodeId: local.peer.nodeId,
      privateKey: local.privateKey,
      keyFingerprint: local.fingerprint,
      replayStore,
      commandRegistry: new CommandRegistry(),
      timePolicy: TIME_POLICY,
      responseLifetimeMs: 60_000,
      resolvePeer: () => sender.peer,
      authorize: () => true,
      now: () => NOW,
    });
    const request = signRequest(sender.privateKey, sender.fingerprint, {
      kind: 'wake',
      from: sender.peer.nodeId,
      to: local.peer.nodeId,
      body: { event_code: 'N18-01' },
    });

    await core.process(request);
    expect(replayStore.retainUntilMs).toBe(
      Date.parse(request.expires_at) + TIME_POLICY.maxLateSkewMs,
    );
  });

  it('rejects tampering, the wrong recipient, and malformed crypto encodings', async () => {
    const sender = makeIdentity('node-sender-01');
    const local = makeIdentity('node-local-0001');
    const core = new NodeCore({
      nodeId: local.peer.nodeId,
      privateKey: local.privateKey,
      keyFingerprint: local.fingerprint,
      replayStore: new InMemoryReplayStore(),
      commandRegistry: new CommandRegistry(),
      timePolicy: TIME_POLICY,
      responseLifetimeMs: 60_000,
      resolvePeer: () => sender.peer,
      authorize: () => true,
      now: () => NOW,
    });
    const request = signRequest(sender.privateKey, sender.fingerprint, {
      kind: 'wake',
      from: sender.peer.nodeId,
      to: local.peer.nodeId,
      body: { event_code: 'N18-01' },
    });

    await expect(
      core.process({ ...request, body: { event_code: 'tampered' } }),
    ).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    await expect(core.process({ ...request, to: 'node-someone-01' })).rejects.toMatchObject({
      code: 'BAD_SIGNATURE',
    });
    const wrongRecipient = signRequest(sender.privateKey, sender.fingerprint, {
      kind: 'wake',
      from: sender.peer.nodeId,
      to: 'node-someone-01',
      message_id: 'wrong-recipient-00001',
      body: { event_code: 'N18-01' },
    });
    await expect(core.process(wrongRecipient)).rejects.toMatchObject({
      code: 'WRONG_RECIPIENT',
    });
    await expect(
      core.process({ ...request, key_fingerprint: `${request.key_fingerprint}=` }),
    ).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const fingerprintLast = request.key_fingerprint.at(-1) ?? '';
    const noncanonicalFingerprint = `${request.key_fingerprint.slice(0, -1)}${alphabet.charAt(alphabet.indexOf(fingerprintLast) + 1)}`;
    expect(Buffer.from(noncanonicalFingerprint.slice('sha256:'.length), 'base64url')).toEqual(
      Buffer.from(request.key_fingerprint.slice('sha256:'.length), 'base64url'),
    );
    await expect(
      core.process({ ...request, key_fingerprint: noncanonicalFingerprint }),
    ).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
    await expect(
      core.process({ ...request, signature: `${request.signature}=` }),
    ).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
  });

  it('rejects unknown or inactive nodes and keys before operation handling', async () => {
    const sender = makeIdentity('node-sender-01');
    const local = makeIdentity('node-local-0001');
    const request = signRequest(sender.privateKey, sender.fingerprint, {
      kind: 'wake',
      from: sender.peer.nodeId,
      to: local.peer.nodeId,
      body: { event_code: 'N18-01' },
    });
    const makeCore = (peer: PeerIdentity | null) =>
      new NodeCore({
        nodeId: local.peer.nodeId,
        privateKey: local.privateKey,
        keyFingerprint: local.fingerprint,
        replayStore: new InMemoryReplayStore(),
        commandRegistry: new CommandRegistry(),
        timePolicy: TIME_POLICY,
        responseLifetimeMs: 60_000,
        resolvePeer: () => peer,
        authorize: () => true,
        now: () => NOW,
      });

    await expect(makeCore(null).process(request)).rejects.toMatchObject({ code: 'UNKNOWN_NODE' });
    for (const status of ['pending', 'suspended', 'revoked'] as const) {
      await expect(makeCore({ ...sender.peer, status }).process(request)).rejects.toMatchObject({
        code: 'NODE_NOT_ACTIVE',
      });
    }
    await expect(
      makeCore({ ...sender.peer, keys: new Map() }).process(request),
    ).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
    const unrelatedKey = makeIdentity('node-unrelated-01');
    await expect(
      makeCore({
        ...sender.peer,
        keys: new Map([
          [sender.fingerprint, { publicKey: unrelatedKey.publicKey, status: 'active' as const }],
        ]),
      }).process(request),
    ).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
    for (const status of ['inactive', 'revoked'] as const) {
      const keys = new Map([
        [sender.fingerprint, { publicKey: sender.publicKey, status }],
      ] as const);
      await expect(makeCore({ ...sender.peer, keys }).process(request)).rejects.toMatchObject({
        code: 'KEY_NOT_ACTIVE',
      });
    }
  });

  it('applies caller-supplied expiry, future-skew, and maximum-lifetime policy', async () => {
    const sender = makeIdentity('node-sender-01');
    const local = makeIdentity('node-local-0001');
    const core = new NodeCore({
      nodeId: local.peer.nodeId,
      privateKey: local.privateKey,
      keyFingerprint: local.fingerprint,
      replayStore: new InMemoryReplayStore(),
      commandRegistry: new CommandRegistry(),
      timePolicy: TIME_POLICY,
      responseLifetimeMs: 60_000,
      resolvePeer: () => sender.peer,
      authorize: () => true,
      now: () => NOW,
    });
    const cases: Partial<UnsignedBnpEnvelope>[] = [
      {
        message_id: 'expired-message-0001',
        issued_at: '2026-09-07T02:58:00.000Z',
        expires_at: '2026-09-07T02:59:29.999Z',
      },
      {
        message_id: 'future-message-00001',
        issued_at: '2026-09-07T03:00:30.001Z',
        expires_at: '2026-09-07T03:01:00.001Z',
      },
      {
        message_id: 'lifetime-message-001',
        issued_at: '2026-09-07T03:00:00.000Z',
        expires_at: '2026-09-07T03:05:00.001Z',
      },
      {
        message_id: 'zero-lifetime-000001',
        issued_at: '2026-09-07T03:00:00.000Z',
        expires_at: '2026-09-07T03:00:00.000Z',
      },
    ];

    for (const fields of cases) {
      const request = signRequest(sender.privateKey, sender.fingerprint, {
        kind: 'wake',
        from: sender.peer.nodeId,
        to: local.peer.nodeId,
        body: { event_code: 'N18-01' },
        ...fields,
      });
      await expect(core.process(request)).rejects.toMatchObject({ code: 'INVALID_TIME' });
    }
  });

  it('fails closed for unknown table, version, command, and command capability', async () => {
    const sender = makeIdentity('node-sender-01');
    const local = makeIdentity('node-local-0001');
    const registry = new CommandRegistry();
    let executions = 0;
    registry.register({
      table_id: 'core',
      table_version: '1',
      command_id: 'status',
      requiredCapability: 'command.execute:core/status',
      executionSemantics: 'idempotent',
      handler: () => {
        executions += 1;
        return { ok: true };
      },
    });
    const core = new NodeCore({
      nodeId: local.peer.nodeId,
      privateKey: local.privateKey,
      keyFingerprint: local.fingerprint,
      replayStore: new InMemoryReplayStore(),
      commandJournal: new TestDurableCommandJournal(),
      commandExecutionPolicy: COMMAND_POLICY,
      commandRegistry: registry,
      timePolicy: TIME_POLICY,
      responseLifetimeMs: 60_000,
      resolvePeer: () => sender.peer,
      authorize: () => true,
      now: () => NOW,
    });
    const unknownReferences = [
      { table_id: 'other', table_version: '1', command_id: 'status' },
      { table_id: 'core', table_version: '2', command_id: 'status' },
      { table_id: 'core', table_version: '1', command_id: 'other' },
    ];

    for (const [index, body] of unknownReferences.entries()) {
      const request = signRequest(sender.privateKey, sender.fingerprint, {
        kind: 'command',
        from: sender.peer.nodeId,
        to: local.peer.nodeId,
        message_id: `unknown-command-000${index}`,
        body,
      });
      await expect(core.process(request)).rejects.toMatchObject({ code: 'UNKNOWN_COMMAND' });
    }

    const denied = signRequest(sender.privateKey, sender.fingerprint, {
      kind: 'command',
      from: sender.peer.nodeId,
      to: local.peer.nodeId,
      message_id: 'capability-denied-0001',
      body: { table_id: 'core', table_version: '1', command_id: 'status' },
    });
    await expect(core.process(denied)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    expect(executions).toBe(0);
  });

  it('signs result correlation and detects in_reply_to tampering', async () => {
    const sender = makeIdentity('node-sender-01', ['command.execute:core/status']);
    const local = makeIdentity('node-local-0001');
    const registry = new CommandRegistry();
    registry.register({
      table_id: 'core',
      table_version: '1',
      command_id: 'status',
      requiredCapability: 'command.execute:core/status',
      executionSemantics: 'idempotent',
      handler: () => ({ ok: true }),
    });
    const core = new NodeCore({
      nodeId: local.peer.nodeId,
      privateKey: local.privateKey,
      keyFingerprint: local.fingerprint,
      replayStore: new InMemoryReplayStore(),
      commandJournal: new TestDurableCommandJournal(),
      commandExecutionPolicy: COMMAND_POLICY,
      commandRegistry: registry,
      timePolicy: TIME_POLICY,
      responseLifetimeMs: 60_000,
      resolvePeer: () => sender.peer,
      authorize: () => true,
      now: () => NOW,
    });
    const request = signRequest(sender.privateKey, sender.fingerprint, {
      kind: 'command',
      from: sender.peer.nodeId,
      to: local.peer.nodeId,
      body: { table_id: 'core', table_version: '1', command_id: 'status' },
    });

    const result = await core.process(request);
    expect(result.in_reply_to).toBe(request.message_id);
    expect(verifyEnvelopeSignature(result, local.publicKey)).toBe(true);
    expect(
      verifyEnvelopeSignature(
        { ...result, in_reply_to: 'different-request-0001' },
        local.publicKey,
      ),
    ).toBe(false);
  });
});
