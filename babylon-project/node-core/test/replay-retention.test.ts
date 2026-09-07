import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CommandRegistry,
  fingerprintPublicKey,
  InMemoryReplayStore,
  NodeCore,
  signEnvelope,
  validateEnvelopeTime,
  type PeerIdentity,
} from '../src/index.js';

const ISSUED_AT = Date.parse('2026-09-07T03:00:00.000Z');
const EXPIRES_AT = Date.parse('2026-09-07T03:01:00.000Z');
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
    keys: new Map([[fingerprint, { publicKey: pair.publicKey, status: 'active' as const }]]),
    capabilities: new Set(),
  };
  return { ...pair, fingerprint, peer };
}

describe('NODE IJET replay/time boundary', () => {
  it('rejects a zero-length validity window', () => {
    const sender = identity('node-sender-01');
    const envelope = signEnvelope(
      {
        bnp: '1',
        kind: 'wake',
        message_id: 'message-0000000001',
        from: sender.peer.nodeId,
        to: 'node-target-01',
        issued_at: '2026-09-07T03:00:00.000Z',
        expires_at: '2026-09-07T03:00:00.000Z',
        key_fingerprint: sender.fingerprint,
        body: { event_code: 'N18-01' },
      },
      sender.privateKey,
    );

    expect(() => validateEnvelopeTime(envelope, ISSUED_AT, TIME_POLICY)).toThrow(
      'expires_at must be later than issued_at',
    );
  });

  it('suppresses duplicate WAKE throughout the accepted late-skew window', async () => {
    const sender = identity('node-sender-01');
    const local = identity('node-local-0001');
    let nowMs = ISSUED_AT;
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
      now: () => nowMs,
    });

    const request = signEnvelope(
      {
        bnp: '1',
        kind: 'wake',
        message_id: 'message-0000000001',
        from: sender.peer.nodeId,
        to: local.peer.nodeId,
        issued_at: new Date(ISSUED_AT).toISOString(),
        expires_at: new Date(EXPIRES_AT).toISOString(),
        key_fingerprint: sender.fingerprint,
        body: { event_code: 'N18-01' },
      },
      sender.privateKey,
    );

    const first = await core.process(request);
    expect(first.body['status']).toBe('accepted');
    expect(wakeCount).toBe(1);

    nowMs = EXPIRES_AT + 10_000;
    const duplicate = await core.process(request);
    expect(duplicate.body['status']).toBe('duplicate');
    expect(wakeCount).toBe(1);
  });
});
