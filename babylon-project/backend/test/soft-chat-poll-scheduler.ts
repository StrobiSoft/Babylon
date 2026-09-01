export type SoftChatPendingSchedule = 'completion-relative' | 'fixed-grid';

export function nextFixedGridPoll(input: {
  anchorMs: number;
  lastTickIndex: number;
  completedAtMs: number;
  cadenceMs: number;
}) {
  if (!Number.isFinite(input.cadenceMs) || input.cadenceMs <= 0) {
    throw new Error('Fixed-grid cadence must be a positive finite number.');
  }
  const elapsedMs = Math.max(0, input.completedAtMs - input.anchorMs);
  const nextTickIndex = Math.max(
    input.lastTickIndex + 1,
    Math.floor(elapsedMs / input.cadenceMs) + 1,
  );
  return {
    tickIndex: nextTickIndex,
    delayMs: Math.max(0, input.anchorMs + nextTickIndex * input.cadenceMs - input.completedAtMs),
    skippedTicks: Math.max(0, nextTickIndex - input.lastTickIndex - 1),
  };
}
