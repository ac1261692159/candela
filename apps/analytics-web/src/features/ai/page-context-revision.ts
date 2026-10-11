import type { AiPageContext } from '../../types/ai.types';

type ChartShape = {
  mode?: string;
  chart_type?: unknown;
  preferred_view?: unknown;
  roles?: unknown;
  bindings?: unknown;
  options?: { metric_axis?: unknown; units?: unknown };
};

/** Only editable query state changes a proposal revision; loading/results do not. */
export function editableContext(context: AiPageContext): string {
  const analysis = context.analysis ?? {};
  const chart = analysis.chart_config && typeof analysis.chart_config === 'object'
    ? (analysis.chart_config as ChartShape)
    : null;
  const manualChart = chart?.mode === 'manual'
    ? { chart_type: chart.chart_type, preferred_view: chart.preferred_view, roles: chart.roles, bindings: chart.bindings }
    : null;
  const state = context.page === 'sql'
    ? { mode: analysis.mode, sql: analysis.sql, dsl: analysis.dsl, time_range: analysis.time_range, card_id: analysis.card_id, chart: manualChart }
    : {
        form: analysis.form,
        ...(analysis.form ? {} : { dsl: analysis.dsl }),
        // 事件侧的图表配置无条件进版本（不分 auto/manual）：AI 会基于当前绑定提案，
        // 绑定一变，基于旧绑定的提案就该被拦下。与 SQL 分支的差异是有意为之——
        // SQL 只在 manual 时纳入，动它会改变既有 SQL 提案流程（本 phase 非目标）。
        chart: chart && {
          chart_type: chart.chart_type,
          roles: chart.roles,
          bindings: chart.bindings,
          metric_axis: chart.options?.metric_axis,
          units: chart.options?.units,
        },
        // 展示方式变化也要换版本：AI 看到的「用户在看的图」变了
        view: analysis.view,
      };
  return JSON.stringify([context.page, context.route, state]);
}

const KEY = 'clklog-ai-content-revision';
let fallback = 0;
export function allocatePageRevision(minimum = 0): number {
  try { fallback = Math.max(fallback, Number(sessionStorage.getItem(KEY)) || 0); } catch { /* memory fallback */ }
  fallback = Math.max(fallback, minimum) + 1;
  try { sessionStorage.setItem(KEY, String(fallback)); } catch { /* private browser */ }
  return fallback;
}
