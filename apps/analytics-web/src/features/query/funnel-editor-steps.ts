import { MAX_FUNNEL_STEPS } from '../../types/dsl.types';
import type { FilterGroup } from '../../types/dsl.types';
import { t as i18nT } from '../../i18n';

export type FunnelEditorStep = {
  event: string;
  alias?: string;
  filters?: FilterGroup;
};

export function blankFunnelStep(position: number): FunnelEditorStep {
  return { event: '', alias: i18nT('analysis:funnel.stepIndex', { index: position }) };
}

export function insertFunnelStepBefore(
  steps: FunnelEditorStep[],
  index: number,
): FunnelEditorStep[] {
  if (steps.length >= MAX_FUNNEL_STEPS) return steps;
  if (index < 0 || index > steps.length) return steps;
  const next = [...steps];
  next.splice(index, 0, blankFunnelStep(index + 1));
  return next;
}

export function insertFunnelStepAfter(
  steps: FunnelEditorStep[],
  index: number,
): FunnelEditorStep[] {
  if (steps.length >= MAX_FUNNEL_STEPS) return steps;
  if (index < 0 || index >= steps.length) return steps;
  const next = [...steps];
  next.splice(index + 1, 0, blankFunnelStep(index + 2));
  return next;
}

export function moveFunnelStep(
  steps: FunnelEditorStep[],
  index: number,
  delta: -1 | 1,
): FunnelEditorStep[] {
  const target = index + delta;
  if (index < 0 || index >= steps.length || target < 0 || target >= steps.length) {
    return steps;
  }
  const next = [...steps];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}
