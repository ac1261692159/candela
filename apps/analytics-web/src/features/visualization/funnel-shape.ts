import { FUNNEL_MAX_STEPS, FUNNEL_MIN_STEPS } from './chart.constants';
import type { ColumnProfile, FunnelShape, FunnelStepBinding } from './chart.types';
import { parseStrictNumber } from './column-profiler';

interface ParsedFunnelColumn {
  column: string;
  order: number;
  label: string;
  family: 'uv' | 'pv' | 'custom';
}

export function parseFunnelColumnName(name: string): ParsedFunnelColumn | null {
  const match = name.match(/^([1-9][0-9]*)[.、_\-\s]+(.+)$/);
  if (!match) return null;
  const order = Number(match[1]);
  let label = match[2].trim();
  let family: ParsedFunnelColumn['family'] = 'custom';
  if (/UV$/i.test(label)) {
    family = 'uv';
    label = label.slice(0, -2).trim();
  } else if (/PV$/i.test(label)) {
    family = 'pv';
    label = label.slice(0, -2).trim();
  }
  if (!label) label = name;
  return { column: name, order, label, family };
}

function familyGroup(parsed: ParsedFunnelColumn[]): FunnelStepBinding[] | null {
  const byOrder = new Map<number, ParsedFunnelColumn>();
  for (const item of parsed) {
    if (byOrder.has(item.order)) return null;
    byOrder.set(item.order, item);
  }
  const orders = [...byOrder.keys()].sort((a, b) => a - b);
  if (orders.length < FUNNEL_MIN_STEPS || orders.length > FUNNEL_MAX_STEPS) return null;
  if (orders[orders.length - 1] - orders[0] + 1 !== orders.length) return null;
  return orders.map((order) => {
    const item = byOrder.get(order)!;
    return { order, column: item.column, label: item.label };
  });
}

export function detectFunnelShape(
  profiles: ColumnProfile[],
  rows: Record<string, unknown>[],
): FunnelShape | null {
  const parsed = profiles
    .map((profile) => parseFunnelColumnName(profile.key))
    .filter((item): item is ParsedFunnelColumn => item !== null);
  if (parsed.length < FUNNEL_MIN_STEPS) return null;

  const uv = familyGroup(parsed.filter((item) => item.family === 'uv'));
  const pv = familyGroup(parsed.filter((item) => item.family === 'pv'));
  const custom = familyGroup(parsed.filter((item) => item.family === 'custom'));
  const steps = uv ?? pv ?? custom;
  const family: FunnelShape['family'] = uv ? 'uv' : pv ? 'pv' : 'custom';
  if (!steps) return null;

  const stepKeys = new Set(steps.map((step) => step.column));
  for (const step of steps) {
    const profile = profiles.find((item) => item.key === step.column);
    if (!profile || (profile.baseType !== 'number' && profile.role !== 'metric')) return null;
    if (profile.metric && !profile.metric.safeNumber) return null;
    for (const row of rows) {
      const parsedValue = parseStrictNumber(row[step.column]);
      if (parsedValue === 'unsafe') return null;
    }
  }

  const dimensionColumns = profiles
    .filter((profile) => !stepKeys.has(profile.key) && (profile.role === 'dimension' || profile.role === 'time' || (profile.role === 'pending' && profile.baseType === 'string')))
    .filter((profile) => profile.role !== 'metric')
    .map((profile) => profile.key);

  return { family, steps, dimensionColumns };
}

export function cleanStepLabel(column: string): string {
  return parseFunnelColumnName(column)?.label ?? column;
}
