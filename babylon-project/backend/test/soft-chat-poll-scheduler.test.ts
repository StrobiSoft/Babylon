import { describe, expect, it } from 'vitest';
import { nextFixedGridPoll } from './soft-chat-poll-scheduler.js';

describe('Soft Chat fixed-grid poll scheduler', () => {
  it('waits for the next cadence tick after an early completion', () => {
    expect(
      nextFixedGridPoll({ anchorMs: 1000, lastTickIndex: 0, completedAtMs: 1120, cadenceMs: 500 }),
    ).toEqual({ tickIndex: 1, delayMs: 380, skippedTicks: 0 });
  });

  it('skips elapsed ticks instead of overlapping a slow request', () => {
    expect(
      nextFixedGridPoll({ anchorMs: 1000, lastTickIndex: 0, completedAtMs: 2210, cadenceMs: 500 }),
    ).toEqual({ tickIndex: 3, delayMs: 290, skippedTicks: 2 });
  });

  it('never schedules a second request on the just-completed tick', () => {
    expect(
      nextFixedGridPoll({ anchorMs: 1000, lastTickIndex: 1, completedAtMs: 2000, cadenceMs: 500 }),
    ).toEqual({ tickIndex: 3, delayMs: 500, skippedTicks: 1 });
  });
});
