import { describe, expect, it } from 'vitest';
import { createRefreshGate } from './dashboard-refresh-gate';

describe('createRefreshGate', () => {
  it('never runs more than the limit at once', async () => {
    const run = createRefreshGate(2);
    let peak = 0;
    let inflight = 0;
    const tasks = Array.from({ length: 5 }, () =>
      run(async () => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inflight -= 1;
      }),
    );
    await Promise.all(tasks);
    expect(peak).toBe(2);
  });
});
