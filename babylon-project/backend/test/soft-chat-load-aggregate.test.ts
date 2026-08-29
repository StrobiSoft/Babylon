import { describe, expect, it } from 'vitest';
import {
  evaluateSoftChatSeries,
  summarizeSeriesValues,
  type SoftChatRunMeasurement,
} from './soft-chat-load-aggregate.js';

const run = (
  index: number,
  sendToAckP99Ms: number,
  overrides: Partial<SoftChatRunMeasurement> = {},
): SoftChatRunMeasurement => ({
  run: index,
  reportPath: `run-${index}.json`,
  sendToAckP99Ms,
  throughputMessagesPerSecond: 150,
  pendingFetchRequests: 5000,
  pendingAcquisitions: 2500,
  authenticationAcquisitions: 4000,
  poolMaxWaiting: 300,
  serverCpuPercent: 110,
  serverEventLoopUtilizationPercent: 85,
  driverCpuPercent: 70,
  driverEventLoopUtilizationPercent: 45,
  correctness: {
    requestedClients: 500,
    authenticatedClients: 500,
    messagesSucceeded: 500,
    acknowledgementsSucceeded: 500,
    duplicateDeliveries: 0,
    exactlyOnceViolations: 0,
    maxLockWaitingQueries: 0,
    errors: [],
  },
  ...overrides,
});

describe('Soft Chat aggregate evaluation', () => {
  it('calculates stable summaries including an even-series median', () => {
    expect(summarizeSeriesValues([4, 1, 3, 2])).toEqual({
      mean: 2.5,
      median: 2.5,
      min: 1,
      max: 4,
    });
  });

  it('keeps exploratory latency above the reference target usable', () => {
    const aggregate = evaluateSoftChatSeries(
      [run(1, 3200), run(2, 3400), run(3, 3300)],
      { kind: 'exploratory', latencyTargetMs: 2000 },
    );

    expect(aggregate.latency).toMatchObject({
      mean: 3300,
      median: 3300,
      min: 3200,
      max: 3400,
      atOrBelowTarget: 0,
    });
    expect(aggregate.decision.passed).toBe(true);
  });

  it('passes a ten-run release candidate only when both latency rules pass', () => {
    const aggregate = evaluateSoftChatSeries(
      Array.from({ length: 10 }, (_, index) => run(index + 1, index < 5 ? 1900 : 2100)),
      { kind: 'release-candidate', latencyTargetMs: 2000 },
    );

    expect(aggregate.latency.mean).toBe(2000);
    expect(aggregate.latency.atOrBelowTarget).toBe(5);
    expect(aggregate.decision.passed).toBe(true);
  });

  it('rejects a release candidate whose mean exceeds the target', () => {
    const aggregate = evaluateSoftChatSeries(
      Array.from({ length: 10 }, (_, index) => run(index + 1, index < 5 ? 1900 : 2200)),
      { kind: 'release-candidate', latencyTargetMs: 2000 },
    );

    expect(aggregate.latency.atOrBelowTarget).toBe(5);
    expect(aggregate.latency.mean).toBe(2050);
    expect(aggregate.decision.passed).toBe(false);
    expect(aggregate.decision.reasons.join(' ')).toContain('mean p99');
  });

  it('rejects a release candidate with fewer than five target-meeting runs', () => {
    const aggregate = evaluateSoftChatSeries(
      Array.from({ length: 10 }, (_, index) => run(index + 1, index < 4 ? 1000 : 2100)),
      { kind: 'release-candidate', latencyTargetMs: 2000 },
    );

    expect(aggregate.latency.mean).toBeLessThan(2000);
    expect(aggregate.latency.atOrBelowTarget).toBe(4);
    expect(aggregate.decision.passed).toBe(false);
    expect(aggregate.decision.reasons.join(' ')).toContain('at least 5');
  });

  it('keeps correctness as a hard gate in exploratory mode', () => {
    const failed = run(2, 1900, {
      correctness: {
        ...run(2, 1900).correctness,
        acknowledgementsSucceeded: 499,
      },
    });
    const aggregate = evaluateSoftChatSeries(
      [run(1, 1900), failed, run(3, 1900)],
      { kind: 'exploratory', latencyTargetMs: 2000 },
    );

    expect(aggregate.correctnessFailureRuns).toEqual([2]);
    expect(aggregate.decision.passed).toBe(false);
  });
});
