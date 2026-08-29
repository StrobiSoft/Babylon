export type SoftChatSeriesKind = 'exploratory' | 'release-candidate';

export interface NumericSummary {
  mean: number;
  median: number;
  min: number;
  max: number;
}

export interface SoftChatCorrectness {
  requestedClients: number;
  authenticatedClients: number;
  messagesSucceeded: number;
  acknowledgementsSucceeded: number;
  duplicateDeliveries: number;
  exactlyOnceViolations: number;
  maxLockWaitingQueries: number;
  errors: string[];
}

export interface SoftChatRunMeasurement {
  run: number;
  reportPath: string;
  sendToAckP99Ms: number;
  throughputMessagesPerSecond: number;
  pendingFetchRequests: number;
  pendingAcquisitions: number;
  authenticationAcquisitions: number;
  poolMaxWaiting: number;
  serverCpuPercent: number;
  serverEventLoopUtilizationPercent: number;
  driverCpuPercent: number;
  driverEventLoopUtilizationPercent: number;
  correctness: SoftChatCorrectness;
}

export interface SoftChatSeriesAggregate {
  kind: SoftChatSeriesKind;
  repetitions: number;
  latencyTargetMs: number;
  latency: NumericSummary & { atOrBelowTarget: number };
  throughputMessagesPerSecond: NumericSummary;
  pendingFetchRequests: NumericSummary;
  pendingAcquisitions: NumericSummary;
  authenticationAcquisitions: NumericSummary;
  poolMaxWaiting: NumericSummary;
  serverCpuPercent: NumericSummary;
  serverEventLoopUtilizationPercent: NumericSummary;
  driverCpuPercent: NumericSummary;
  driverEventLoopUtilizationPercent: NumericSummary;
  correctnessFailureRuns: number[];
  decision: {
    passed: boolean;
    reasons: string[];
  };
}

const rounded = (value: number) => Number(value.toFixed(3));

export function summarizeSeriesValues(values: number[]): NumericSummary {
  if (values.length === 0) throw new Error('Cannot summarize an empty measurement series.');
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error('Measurement series contains a non-finite value.');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return {
    mean: rounded(sorted.reduce((total, value) => total + value, 0) / sorted.length),
    median: rounded(median),
    min: rounded(sorted[0]!),
    max: rounded(sorted.at(-1)!),
  };
}

export function hasCorrectnessFailure(run: SoftChatRunMeasurement): boolean {
  const correctness = run.correctness;
  return (
    correctness.authenticatedClients !== correctness.requestedClients ||
    correctness.messagesSucceeded !== correctness.requestedClients ||
    correctness.acknowledgementsSucceeded !== correctness.requestedClients ||
    correctness.duplicateDeliveries !== 0 ||
    correctness.exactlyOnceViolations !== 0 ||
    correctness.maxLockWaitingQueries !== 0 ||
    correctness.errors.length !== 0
  );
}

export function evaluateSoftChatSeries(
  runs: SoftChatRunMeasurement[],
  input: { kind: SoftChatSeriesKind; latencyTargetMs: number },
): SoftChatSeriesAggregate {
  if (runs.length === 0) throw new Error('At least one Soft Chat run is required.');
  if (!Number.isFinite(input.latencyTargetMs) || input.latencyTargetMs <= 0) {
    throw new Error('latencyTargetMs must be a positive finite number.');
  }

  const correctnessFailureRuns = runs
    .filter((run) => hasCorrectnessFailure(run))
    .map((run) => run.run);
  const p99Values = runs.map((run) => run.sendToAckP99Ms);
  const latency = {
    ...summarizeSeriesValues(p99Values),
    atOrBelowTarget: p99Values.filter((value) => value <= input.latencyTargetMs).length,
  };
  const reasons: string[] = [];

  if (correctnessFailureRuns.length > 0) {
    reasons.push(`hard correctness gates failed in run(s): ${correctnessFailureRuns.join(', ')}`);
  }

  if (input.kind === 'release-candidate') {
    if (runs.length !== 10) {
      reasons.push(
        `release-candidate evaluation requires exactly 10 runs; received ${runs.length}`,
      );
    }
    if (latency.mean > input.latencyTargetMs) {
      reasons.push(
        `mean p99 ${latency.mean}ms exceeded the ${input.latencyTargetMs}ms reference target`,
      );
    }
    if (latency.atOrBelowTarget < 5) {
      reasons.push(
        `${latency.atOrBelowTarget}/${runs.length} runs were at or below ${input.latencyTargetMs}ms; at least 5 are required`,
      );
    }
  }

  return {
    kind: input.kind,
    repetitions: runs.length,
    latencyTargetMs: input.latencyTargetMs,
    latency,
    throughputMessagesPerSecond: summarizeSeriesValues(
      runs.map((run) => run.throughputMessagesPerSecond),
    ),
    pendingFetchRequests: summarizeSeriesValues(runs.map((run) => run.pendingFetchRequests)),
    pendingAcquisitions: summarizeSeriesValues(runs.map((run) => run.pendingAcquisitions)),
    authenticationAcquisitions: summarizeSeriesValues(
      runs.map((run) => run.authenticationAcquisitions),
    ),
    poolMaxWaiting: summarizeSeriesValues(runs.map((run) => run.poolMaxWaiting)),
    serverCpuPercent: summarizeSeriesValues(runs.map((run) => run.serverCpuPercent)),
    serverEventLoopUtilizationPercent: summarizeSeriesValues(
      runs.map((run) => run.serverEventLoopUtilizationPercent),
    ),
    driverCpuPercent: summarizeSeriesValues(runs.map((run) => run.driverCpuPercent)),
    driverEventLoopUtilizationPercent: summarizeSeriesValues(
      runs.map((run) => run.driverEventLoopUtilizationPercent),
    ),
    correctnessFailureRuns,
    decision: {
      passed: reasons.length === 0,
      reasons:
        reasons.length === 0
          ? [
              input.kind === 'release-candidate'
                ? 'all hard correctness gates and both prospective latency rules passed'
                : 'all hard correctness gates passed; latency remains a recorded reference metric',
            ]
          : reasons,
    },
  };
}
