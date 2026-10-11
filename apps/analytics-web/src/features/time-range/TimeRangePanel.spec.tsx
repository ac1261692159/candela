// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TimeRangePanel } from './TimeRangePanel';
import { defaultPastNDays } from './resolve';
import { useState } from 'react';
import type { TimeRange } from '../../types/dsl.types';

const TODAY = '2026-09-11';

function Harness({ initial, onApply }: { initial: TimeRange; onApply: (value: TimeRange) => void }) {
  const [draft, setDraft] = useState(initial);
  return (
    <TimeRangePanel
      draft={draft}
      todayYmd={TODAY}
      onDraftChange={setDraft}
      onCancel={() => undefined}
      onApply={() => onApply(draft)}
    />
  );
}

describe('TimeRangePanel', () => {
  it('applies 最近7天 as a rolling window including today', async () => {
    const user = userEvent.setup();
    let applied: TimeRange | undefined;
    render(<Harness initial={defaultPastNDays(7, TODAY)} onApply={(value) => { applied = value; }} />);
    await user.click(screen.getByRole('button', { name: '最近7天' }));
    await user.click(screen.getByLabelText('应用'));
    expect(applied?.relative).toEqual({ kind: 'recent_n', n: 7 });
    expect(applied?.start).toBe('2026-09-05');
    expect(applied?.end).toBe('2026-09-11');
  });

  it('drops relative when applying 自定义时间', async () => {
    const user = userEvent.setup();
    let applied: TimeRange | undefined;
    render(<Harness initial={defaultPastNDays(7, TODAY)} onApply={(value) => { applied = value; }} />);
    await user.click(screen.getByRole('button', { name: '自定义时间' }));
    await user.click(screen.getByLabelText('应用'));
    expect(applied?.relative).toBeUndefined();
    expect(applied?.start).toBe('2026-09-04');
    expect(applied?.end).toBe('2026-09-10');
  });
});
