import { describe, expect, it } from 'vitest';
import { AI_DRAG_THRESHOLD_PX } from './ai-panel-layout';

describe('ai panel drag', () => {
  it('ignores pointer jitter below four pixels', () => {
    expect(AI_DRAG_THRESHOLD_PX).toBe(4);
  });
});
