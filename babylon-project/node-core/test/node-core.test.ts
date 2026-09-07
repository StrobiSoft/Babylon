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

class TestDurableReplayStore implements ReplayStore {
  readonly durable = true;
  readonly #seen = new Set<string>();

  async claim(senderNodeId: string, messageId: string): Promise<ReplayClaim> {
    const key = `${senderNodeId}\u0000${messageId}`;
    if (this.#seen.has(key)) {
      return 'duplicate';
    }
    this.#seen.add(key);
    return 'fresh';
  }
}

const NOW = Date.parse('2026-09-07T03:00:00.000Z');
const TIME_POLICY = {
  maxFutureSkewMs: 30_000,
  maxLateSkewMs: 30_000,
  maxLifetimeMs: 300_000,
};

function makeIdentity(nodeId: string, capabilities: string[] = []) {
  const pair = generateKeyPairSync('ed25519');
  const fingerprint = fingerprintPublicKey(pair.publicKey);
  const peer: PeerIdentity = {
    nodeId,
    status: 'active',
    publicKeys: new Map([[fingerprint, pair.publicKey]]),
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

  it('executes an authorized command once and blocks transport replay', async () => {
    const sender = makeIdentity('node-sender-01', ['command.execute:core/status']);
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
      replayStore: new TestDurableReplayStore(),
      commandRegistry: registry,
      timePolicy: TIME_POLICY,
      responseLifetimeMs: 60_000,
      resolvePeer: (nodeId) => (nodeId === sender.peer.nodeId ? sender.peer : null),
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
    expect(result.kind).toBe('command_result');
    expect(result.in_reply_to).toBe(request.message_id);
    expect(executions).toBe(1);

    await expect(core.process(request)).rejects.toMatchObject({
      code: 'REPLAY_DETECTED',
    });
    expect(executions).toBe(1);
  });

  it('refuses COMMAND when replay storage is volatile', async () => {
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
});
