// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EventMetricEditor } from './EventMetricEditor';
import type { MetricItem } from '../../../types/dsl.types';

vi.mock('../../metrics/ApplySavedMetricButton', () => ({
  ApplySavedMetricButton: () => null,
}));

const metrics: MetricItem[] = [
  { id: 'm1', kind: 'event', analysis: 'trig_user_num', alias: 'DAU' },
  { id: 'm2', kind: 'event', analysis: 'trig_user_num', alias: 'DNU' },
  {
    id: 'f1',
    kind: 'formula',
    alias: 'DOU',
    expression: {
      type: 'op',
      op: '-',
      left: { type: 'metric', id: 'm1' },
      right: { type: 'metric', id: 'm2' },
    },
  },
  { id: 'm3', kind: 'event', analysis: 'sum', alias: '充值金额', event: 'order_pay_success', prop: 'pay_amount' },
];

describe('EventMetricEditor numbering', () => {
  it('numbers event and formula steps in one sequence after adding a formula', () => {
    render(<EventMetricEditor value={metrics} hideAddActions />);
    const badges = [...document.querySelectorAll('.analysis-peer__num')].map((el) => el.textContent);
    expect(badges).toEqual(['1', '2', '3', '4']);
  });
});
