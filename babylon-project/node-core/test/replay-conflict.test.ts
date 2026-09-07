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

describe('NODE IJET replay conflict handling', () => {
  it('rejects a reused message id when the signed envelope content changes', async () => {
    const sender = identity('node-sender-01');
    const local = identity('node-local-0001');
    let wakeCount = 0;
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
        wakeCount += 1;
      },
      now: () => NOW,
    });

    const common = {
      bnp: '1' as const,
      kind: 'wake' as const,
      message_id: 'message-0000000001',
      from: sender.peer.nodeId,
      to: local.peer.nodeId,
      issued_at: '2026-09-07T03:00:00.000Z',
      expires_at: '2026-09-07T03:01:00.000Z',
      key_fingerprint: sender.fingerprint,
    };

    const first = signEnvelope({ ...common, body: { event_code: 'N18-01' } }, sender.privateKey);
    const conflict = signEnvelope(
      { ...common, body: { event_code: 'N18-02' } },
      sender.privateKey,
    );

    await core.process(first);
    expect(wakeCount).toBe(1);

    await expect(core.process(conflict)).rejects.toMatchObject({ code: 'REPLAY_CONFLICT' });
    expect(wakeCount).toBe(1);
  });
});
