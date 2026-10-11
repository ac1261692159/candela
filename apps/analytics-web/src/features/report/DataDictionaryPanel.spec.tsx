// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataDictionaryPanel } from './DataDictionaryPanel';
import type { SqlSchema } from '../../types/report.types';

const schema: SqlSchema = {
  events: [],
  event_properties: [],
  user_properties: [],
  system_columns: [],
  cohorts: [
    {
      cohort_id: 'cohort_abc123xxxx',
      name: 'high_vip',
      display_name: '高活',
      batch_id: 'b1',
      member_count: 12,
    },
  ],
};

describe('DataDictionaryPanel cohorts', () => {
  it('inserts sa_in_cohort fragment without rewriting WHERE', async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<DataDictionaryPanel schema={schema} loading={false} onInsert={onInsert} />);

    await user.click(screen.getByText(/用户分群/));
    await user.click(screen.getByText('高活'));

    expect(onInsert).toHaveBeenCalledTimes(1);
    const fragment = onInsert.mock.calls[0][0] as string;
    expect(fragment).toContain('-- cohort: 高活 (cohort_abc123xxxx)');
    expect(fragment).toContain("sa_in_cohort('cohort_abc123xxxx')");
    expect(fragment).not.toMatch(/\bWHERE\b/i);
    expect(fragment).not.toContain('batch_id');
  });
});
