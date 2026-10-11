import { FUNNEL_MAX_STEPS, FUNNEL_MIN_STEPS } from './chart.constants';
import { createIssue } from './chart-issues';
import type { ChartConfigV1, ChartIssue, FunnelStepBinding } from './chart.types';
import { parseStrictNumber } from './column-profiler';
import { t as translate } from '../../i18n';

export function materializeLongFunnel(
  config: ChartConfigV1,
  rows: Record<string, unknown>[],
): { steps: FunnelStepBinding[]; selectedRow: Record<string, unknown>; issues: ChartIssue[] } | { issues: ChartIssue[] } {
  const long = config.bindings.funnel?.long_shape;
  if (!long) return { issues: [createIssue('MISSING_METRIC')] };
  const byOrder = new Map<number, { label: string; value: number | null; column: string }>();
  for (const row of rows) {
    const orderRaw = parseStrictNumber(row[long.order_column]);
    if (orderRaw === 'unsafe' || orderRaw === null || !Number.isInteger(orderRaw)) {
      return { issues: [createIssue('STALE_CONFIG', 'error', { columns: [long.order_column] })] };
    }
    if (byOrder.has(orderRaw)) {
      return { issues: [createIssue('DUPLICATE_KEY', 'error', { columns: [long.order_column] })] };
    }
    const value = parseStrictNumber(row[long.value_column]);
    byOrder.set(orderRaw, {
      label: String(row[long.label_column] ?? translate('sql:chart.stepFallback', { order: orderRaw })),
      value: value === 'unsafe' ? null : value,
      column: `${long.value_column}:${orderRaw}`,
    });
  }
  const orders = [...byOrder.keys()].sort((a, b) => a - b);
  if (orders.length < FUNNEL_MIN_STEPS || orders.length > FUNNEL_MAX_STEPS) {
    return { issues: [createIssue('MISSING_METRIC')] };
  }
  if (orders[orders.length - 1] - orders[0] + 1 !== orders.length) {
    return { issues: [createIssue('STALE_CONFIG', 'error', { columns: [long.order_column] })] };
  }
  const steps = orders.map((order) => ({
    order,
    column: byOrder.get(order)!.column,
    label: byOrder.get(order)!.label,
  }));
  const selectedRow: Record<string, unknown> = {};
  for (const step of steps) {
    selectedRow[step.column] = byOrder.get(step.order)!.value;
  }
  return { steps, selectedRow, issues: [] };
}
