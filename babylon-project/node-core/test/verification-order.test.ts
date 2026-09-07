import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CommandRegistry,
  fingerprintPublicKey,
  InMemoryReplayStore,
  NodeCore,
  signEnvelope,
  type PeerIdentity,
} from '../src/index.js';

const NOW = Date.parse('2026-09-07T03:00:00.000Z');
const TIME_POLICY = {
  maxFutureSkewMs: 30_000,
  maxLateSkewMs: 30_000,
  maxLifetimeMs: 300_000,
};

function identity(nodeId: string) {
  const pair = generateKeyPairSync('ed25519');
  const fingerprint = fingerprintPublicKey(pair.publicKey);
  const peer: PeerIdentity = {
    nodeId,
    status: 'active',
    publicKeys: new Map([[fingerprint, pair.publicKey]]),
    capabilities: new Set(),
  };
  return { ...pair, fingerprint, peer };
}

function makeCore(local: ReturnType<typeof identity>, resolvePeer: () => PeerIdentity | null) {
  return new NodeCore({
    nodeId: local.peer.nodeId,
    privateKey: local.privateKey,
    keyFingerprint: local.fingerprint,
    replayStore: new InMemoryReplayStore(),
    commandRegistry: new CommandRegistry(),
    timePolicy: TIME_POLICY,
    responseLifetimeMs: 60_000,
    resolvePeer,
    authorize: () => true,
    now: () => NOW,
  });
}

describe('NODE IJET verification order', () => {
  it('does not reveal recipient binding before sender identity is known', async () => {
    const outsider = identity('node-outsider-01');
    const local = identity('node-local-0001');
    const core = makeCore(local, () => null);
    const request = signEnvelope(
      {
        bnp: '1',
        kind: 'wake',
        message_id: 'message-0000000001',
        from: outsider.peer.nodeId,
        to: 'node-wrong-0001',
        issued_at: '2026-09-07T03:00:00.000Z',
        expires_at: '2026-09-07T03:01:00.000Z',
        key_fingerprint: outsider.fingerprint,
        body: { event_code: 'N18-01' },
      },
      outsider.privateKey,
    );

    await expect(core.process(request)).rejects.toMatchObject({ code: 'UNKNOWN_NODE' });
  });

  it('checks signature before reporting wrong recipient for an enrolled sender', async () => {
    const sender = identity('node-sender-01');
    const attacker = identity('node-attacker-01');
    const local = identity('node-local-0001');
    const core = makeCore(local, () => sender.peer);
    const request = signEnvelope(
      {
        bnp: '1',
        kind: 'wake',
        message_id: 'message-0000000001',
        from: sender.peer.nodeId,
        to: 'node-wrong-0001',
        issued_at: '2026-09-07T03:00:00.000Z',
        expires_at: '2026-09-07T03:01:00.000Z',
        key_fingerprint: sender.fingerprint,
        body: { event_code: 'N18-01' },
      },
      attacker.privateKey,
    );

    await expect(core.process(request)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
  });
});
