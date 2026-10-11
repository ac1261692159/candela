import { BadRequestException } from '@nestjs/common';
import { METRIC_UNITS } from '../report/chart-config.validator';
import { badRequest } from '../../i18n/domain-error';

const MAX_BYTES = 8 * 1024;
const ROLES = new Set(['time', 'dimension', 'metric', 'ignored']);
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);

/** 提案所属域：SQL 与事件共用一套物化逻辑，差异集中在 DOMAINS 表 */
export type ChartProposalDomain = 'sql' | 'event';

interface DomainSpec {
  chartTypes: Set<string>;
  metricLimit: Record<string, number>;
  chartJsonKeys: string[];
  /** bindings 允许的键；未知键显式拒绝（静默丢弃会让模型看不出真正原因） */
  bindingKeys: string[];
  /** options 允许的键 */
  optionKeys: string[];
  /** 哪些图型可以没有指标（结果本身就是明细/步骤） */
  metricOptional: string[];
  /** 图型 → 必填的维度键 */
  requiredAxis: Record<string, 'x' | 'category'>;
  /** 必填维度缺失时的可读原因（调用方会拼上可用列提示） */
  axisMessage: (chartType: string, key: 'x' | 'category') => string;
  /** 该域特有的绑定块 */
  allowFunnel: boolean;
  allowRowSelector: boolean;
  notes: string;
}

const SQL_DOMAIN: DomainSpec = {
  chartTypes: new Set(['table', 'number', 'line', 'bar', 'pie', 'funnel', 'trend']),
  metricLimit: { table: 8, number: 8, line: 5, trend: 5, bar: 4, pie: 1, funnel: 8 },
  chartJsonKeys: ['chart_type', 'preferred_view', 'roles', 'bindings', 'options'],
  bindingKeys: ['x', 'category', 'series', 'metrics', 'ignored', 'row_selector', 'funnel'],
  optionKeys: [
    'orientation',
    'donut',
    'sort',
    'top_n',
    'include_other',
    'units',
    'metric_axis',
    'aggregation',
    'trend',
    'stat_calcs',
  ],
  metricOptional: ['table', 'funnel'],
  requiredAxis: { line: 'x', trend: 'x', bar: 'category', pie: 'category' },
  axisMessage: (_chartType, key) =>
    key === 'category'
      ? '柱状/饼图需要 bindings.category（键名是 category，不是 dimension）。'
      : '折线/趋势图需要 bindings.x 时间轴。',
  allowFunnel: true,
  allowRowSelector: true,
  notes:
    '先 page_read 取 analysis.result_columns 与 analysis.chart_config（当前绑定、分轴与单位）：' +
    'metrics/ignored/x/category 只能用结果列里的精确列名（写错会 400 并回列可用列）；' +
    '指标上限 bar 4、pie 1、line/trend 5、table 8，多余列一律放 ignored；' +
    '维度的键名是 x（折线/趋势的时间轴）或 category（柱/饼），不是 dimension；' +
    '量级差太多时把小的指标拆到右轴：options.metric_axis（{"列名":"right"}），单位用 options.units；' +
    '同一根轴上的指标必须同单位（不同单位的指标放同一轴会被判 MIXED_UNITS：一颗轴只能有一种量纲，' +
    '套错就是把计数标成百分号）——单位不同的指标用 metric_axis 拆到另一根轴；' +
    'ratio_0_1 渲染时会 ×100，percent_0_100 不换算，按数据本身选；' +
    '未知字段会被拒绝（chart_json 只接受 chart_json_keys，bindings 只接受 bindings_keys）。' +
    '写入字段设置，不执行 SQL、不保存卡片。',
};

const EVENT_DOMAIN: DomainSpec = {
  chartTypes: new Set([
    'table',
    'number',
    'line',
    'bar',
    'pie',
    'trend',
    'stack',
    'cumulative',
    'distribution',
  ]),
  metricLimit: {
    table: 8,
    number: 8,
    line: 5,
    trend: 5,
    cumulative: 5,
    bar: 4,
    stack: 4,
    distribution: 4,
    pie: 1,
  },
  chartJsonKeys: ['chart_type', 'preferred_view', 'bindings', 'options'],
  bindingKeys: ['x', 'series', 'metrics', 'ignored'],
  optionKeys: ['units', 'metric_axis'],
  metricOptional: ['table'],
  requiredAxis: {
    line: 'x',
    trend: 'x',
    cumulative: 'x',
    bar: 'x',
    stack: 'x',
    distribution: 'x',
    pie: 'x',
  },
  axisMessage: (_chartType, key) =>
    key === 'x'
      ? '该图型需要 bindings.x（X 轴）：事件侧 X 轴可以是时间列或维度列，键名是 x。'
      : '事件侧没有 category 键，维度一律用 bindings.x。',
  allowFunnel: false,
  allowRowSelector: false,
  notes:
    '先 page_read 取 analysis.result_columns 与 analysis.chart_config：' +
    '列名是结果列 key（形如 g_0 / m_0），不是列标题；' +
    'X 轴用 bindings.x（事件侧可为时间列或维度列），拆分系列用 bindings.series，没有 category；' +
    '指标上限 bar/stack/distribution 4、line/trend/cumulative 5、pie 1、table 8，多余列一律放 ignored；' +
    '分轴用 options.metric_axis（{"m_1":"right"}），单位用 options.units；不接受 roles。' +
    '同一根轴上的指标必须同单位：单位不同的指标放同一轴会被判 MIXED_UNITS，用 metric_axis 拆到另一根轴；' +
    'ratio_0_1 渲染时会 ×100，percent_0_100 不换算。' +
    '写入字段设置，不执行查询、不保存卡片；用户在页面上确认后才生效。',
};

const DOMAINS: Record<ChartProposalDomain, DomainSpec> = { sql: SQL_DOMAIN, event: EVENT_DOMAIN };

export interface ChartProposal {
  chart_type: string;
  preferred_view?: 'table' | 'pivot' | 'chart';
  roles?: Record<string, string>;
  bindings: {
    x?: string;
    category?: string;
    series?: string;
    metrics: string[];
    ignored: string[];
    row_selector?: { column: string; value: string | number | boolean | null };
    funnel?: {
      shape: 'wide' | 'long';
      metric_family: 'uv' | 'pv' | 'custom';
      steps: Array<{ order: number; column: string; label: string }>;
    };
  };
  options?: Record<string, unknown>;
}

export const SQL_CHART_CAPABILITY = {
  chart_types: [...SQL_DOMAIN.chartTypes],
  limits: { line: 5, trend: 5, bar: 4, pie: 1, number: 8, funnel: 8 },
  chart_json_keys: SQL_DOMAIN.chartJsonKeys,
  bindings_keys: SQL_DOMAIN.bindingKeys,
  required_bindings: { line: 'x', trend: 'x', bar: 'category', pie: 'category' },
  options_keys: SQL_DOMAIN.optionKeys,
  units: [...METRIC_UNITS],
  notes: SQL_DOMAIN.notes,
};

export const EVENT_CHART_CAPABILITY = {
  chart_types: [...EVENT_DOMAIN.chartTypes],
  limits: EVENT_DOMAIN.metricLimit,
  chart_json_keys: EVENT_DOMAIN.chartJsonKeys,
  bindings_keys: EVENT_DOMAIN.bindingKeys,
  required_bindings: EVENT_DOMAIN.requiredAxis,
  options_keys: EVENT_DOMAIN.optionKeys,
  units: [...METRIC_UNITS],
  notes: EVENT_DOMAIN.notes,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 报错时把可用列回给调用方（AI 据此一次改对，不再反复猜列名） */
function columnHint(columns: Set<string> | string[]): string {
  const names = columns instanceof Set ? [...columns] : columns;
  return names.length ? `可用列：${names.join(' / ')}` : '当前结果没有可用列';
}

function assertSafeKey(key: string): void {
  if (DANGEROUS.has(key) || key.includes('__')) {
    throw badRequest({
      code: 'ai.chart.keyForbidden',
      messageKey: 'ai:error.chart.keyForbidden',
      params: { key },
      message: `非法配置键: ${key}`,
    });
  }
}

function asColumn(value: unknown, field: string, columns: Set<string>): string {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw badRequest({
      code: 'ai.chart.fieldInvalid',
      messageKey: 'ai:error.chart.fieldInvalid',
      params: { field },
      message: `${field} 无效（必须是列名字符串）`,
    });
  }
  assertSafeKey(value);
  if (!columns.has(value)) {
    throw badRequest({
      code: 'ai.chart.columnNotFound',
      messageKey: 'ai:error.chart.columnNotFound',
      params: { name: value },
      message: `列不存在: ${value}。${columnHint(columns)}。请用 clklog_page_read 返回的 result_columns 精确列名`,
    });
  }
  return value;
}

function namesFromColumns(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item) names.push(item);
    else if (isRecord(item) && typeof item.name === 'string' && item.name) names.push(item.name);
  }
  return names;
}

export function snapshotResultColumns(state: Record<string, unknown>): string[] {
  const analysis = state.analysis;
  if (isRecord(analysis)) {
    const fromAnalysis = namesFromColumns(analysis.result_columns);
    if (fromAnalysis.length) return fromAnalysis;
  }
  const result = state.result;
  if (isRecord(result)) return namesFromColumns(result.columns);
  return [];
}

export function parseChartProposal(
  input: unknown,
  columnNames: string[],
  domain: ChartProposalDomain = 'sql',
): ChartProposal {
  const spec = DOMAINS[domain];
  if (input == null) {
    throw badRequest({
      code: 'ai.chart.jsonRequired',
      messageKey: 'ai:error.chart.jsonRequired',
      message: 'chart_json 不能为空',
    });
  }
  const json = JSON.stringify(input);
  if (json.length > MAX_BYTES) {
    throw badRequest({
      code: 'ai.chart.jsonTooLarge',
      messageKey: 'ai:error.chart.jsonTooLarge',
      message: 'chart_json 超过 8KiB',
    });
  }
  if (!isRecord(input)) {
    throw badRequest({
      code: 'ai.chart.jsonNotObject',
      messageKey: 'ai:error.chart.jsonNotObject',
      message: 'chart_json 必须是对象',
    });
  }
  for (const key of Object.keys(input)) {
    assertSafeKey(key);
    if (!spec.chartJsonKeys.includes(key)) {
      throw badRequest({
        code: 'ai.chart.unsupportedField',
        messageKey: 'ai:error.chart.unsupportedField',
        params: { field: key },
        message: `不支持的字段: ${key}（chart_json 只接受：${spec.chartJsonKeys.join(' / ')}）`,
      });
    }
  }
  const chartType = String(input.chart_type ?? '');
  if (!spec.chartTypes.has(chartType)) {
    throw badRequest({
      code: 'ai.chart.typeInvalid',
      messageKey: 'ai:error.chart.typeInvalid',
      message: `chart_type 无效（可选：${[...spec.chartTypes].join(' / ')}）`,
    });
  }
  const columns = new Set(columnNames);
  if (!columns.size) {
    throw badRequest({
      code: 'ai.chart.noColumns',
      messageKey: 'ai:error.chart.noColumns',
      message: '当前结果没有列',
    });
  }

  const bindingsRaw = input.bindings;
  if (isRecord(bindingsRaw)) {
    // 未知键必须显式拒绝：dimension 这类错键名以前被静默丢掉，最后只报「需要 category」，看不出真正原因
    for (const key of Object.keys(bindingsRaw)) {
      assertSafeKey(key);
      if (!spec.bindingKeys.includes(key)) {
        throw badRequest({
          code: 'ai.chart.unsupportedBinding',
          messageKey: 'ai:error.chart.unsupportedBinding',
          params: { field: key },
          message:
            `bindings 里无法识别的键: ${key}（可用：${spec.bindingKeys.join(' / ')}）。` +
            (domain === 'sql'
              ? '柱状/饼图的维度键是 category，折线/趋势的时间轴键是 x（dimension 只在事件分析 DSL 里用）'
              : '事件侧的 X 轴键是 x，拆分系列的键是 series（没有 category 与 dimension）'),
        });
      }
    }
  }
  if (!isRecord(bindingsRaw)) {
    throw badRequest({
      code: 'ai.chart.bindingsNotObject',
      messageKey: 'ai:error.chart.bindingsNotObject',
      message: `bindings 必须是对象（只接受：${spec.bindingKeys.join(' / ')}）`,
    });
  }
  if (!Array.isArray(bindingsRaw.metrics)) {
    throw badRequest({
      code: 'ai.chart.metricsNotArray',
      messageKey: 'ai:error.chart.metricsNotArray',
      message: 'metrics 必须是列名数组',
    });
  }
  const limit = spec.metricLimit[chartType] ?? 8;
  if (bindingsRaw.metrics.length > limit) {
    throw new BadRequestException({
      code: 'ai.chart.tooManyMetrics',
      errorCode: 'ai.chart.tooManyMetrics',
      messageKey: 'ai:error.chart.tooManyMetrics',
      params: { chartType, limit },
      message: `${chartType} 最多 ${limit} 个指标（收到 ${bindingsRaw.metrics.length} 个）：把多余列放进 bindings.ignored，或改用 table（最多 8 个）`,
    });
  }
  const metrics = bindingsRaw.metrics.map((item, index) => asColumn(item, `metrics[${index}]`, columns));
  const ignored = Array.isArray(bindingsRaw.ignored)
    ? bindingsRaw.ignored.map((item, index) => asColumn(item, `ignored[${index}]`, columns))
    : [];
  const x = bindingsRaw.x === undefined ? undefined : asColumn(bindingsRaw.x, 'x', columns);
  const category = bindingsRaw.category === undefined ? undefined : asColumn(bindingsRaw.category, 'category', columns);
  const series = bindingsRaw.series === undefined ? undefined : asColumn(bindingsRaw.series, 'series', columns);

  const requiredAxis = spec.requiredAxis[chartType];
  if (requiredAxis) {
    const provided = requiredAxis === 'x' ? x : category;
    if (!provided) {
      throw badRequest({
        code: requiredAxis === 'x' ? 'ai.chart.xRequired' : 'ai.chart.categoryRequired',
        messageKey: requiredAxis === 'x' ? 'ai:error.chart.xRequired' : 'ai:error.chart.categoryRequired',
        message: `${spec.axisMessage(chartType, requiredAxis)}${columnHint(columns)}`,
      });
    }
  }
  if (!spec.metricOptional.includes(chartType) && metrics.length < 1) {
    throw badRequest({
      code: 'ai.chart.metricRequired',
      messageKey: 'ai:error.chart.metricRequired',
      message: '请至少选择一个指标（bindings.metrics 不能为空）',
    });
  }

  let rowSelector: ChartProposal['bindings']['row_selector'];
  if (spec.allowRowSelector && bindingsRaw.row_selector !== undefined) {
    if (!isRecord(bindingsRaw.row_selector)) {
      throw badRequest({
        code: 'ai.chart.rowSelectorInvalid',
        messageKey: 'ai:error.chart.rowSelectorInvalid',
        message: 'row_selector 无效',
      });
    }
    const value = bindingsRaw.row_selector.value;
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw badRequest({
        code: 'ai.chart.rowSelectorValueInvalid',
        messageKey: 'ai:error.chart.rowSelectorValueInvalid',
        message: 'row_selector.value 无效',
      });
    }
    rowSelector = {
      column: asColumn(bindingsRaw.row_selector.column, 'row_selector.column', columns),
      value: value as string | number | boolean | null,
    };
  }

  let funnel: ChartProposal['bindings']['funnel'];
  if (spec.allowFunnel && bindingsRaw.funnel !== undefined) {
    if (!isRecord(bindingsRaw.funnel)) {
      throw badRequest({
        code: 'ai.chart.funnelInvalid',
        messageKey: 'ai:error.chart.funnelInvalid',
        message: 'funnel 无效',
      });
    }
    const shape = bindingsRaw.funnel.shape === 'long' ? 'long' : bindingsRaw.funnel.shape === 'wide' ? 'wide' : null;
    const family =
      bindingsRaw.funnel.metric_family === 'uv' ||
      bindingsRaw.funnel.metric_family === 'pv' ||
      bindingsRaw.funnel.metric_family === 'custom'
        ? bindingsRaw.funnel.metric_family
        : null;
    if (!shape || !family) {
      throw badRequest({
        code: 'ai.chart.funnelShapeInvalid',
        messageKey: 'ai:error.chart.funnelShapeInvalid',
        message: 'funnel shape/metric_family 无效',
      });
    }
    if (!Array.isArray(bindingsRaw.funnel.steps) || bindingsRaw.funnel.steps.length < 3 || bindingsRaw.funnel.steps.length > 8) {
      throw badRequest({
        code: 'ai.chart.funnelStepsRange',
        messageKey: 'ai:error.chart.funnelStepsRange',
        message: '漏斗步骤必须为 3 到 8 项',
      });
    }
    funnel = {
      shape,
      metric_family: family,
      steps: bindingsRaw.funnel.steps.map((step, index) => {
        if (!isRecord(step)) {
          throw badRequest({
            code: 'ai.chart.funnelStepInvalid',
            messageKey: 'ai:error.chart.funnelStepInvalid',
            message: '漏斗步骤无效',
          });
        }
        const label = typeof step.label === 'string' ? step.label : String(step.column ?? '');
        if (label.length > 100) {
          throw badRequest({
            code: 'ai.chart.funnelLabelTooLong',
            messageKey: 'ai:error.chart.funnelLabelTooLong',
            message: '漏斗步骤标签过长',
          });
        }
        return {
          order: index + 1,
          column: asColumn(step.column, `funnel.steps[${index}].column`, columns),
          label,
        };
      }),
    };
  } else if (chartType === 'funnel') {
    throw badRequest({
      code: 'ai.chart.funnelRequired',
      messageKey: 'ai:error.chart.funnelRequired',
      message: '漏斗图需要 bindings.funnel',
    });
  }

  let roles: Record<string, string> | undefined;
  if (input.roles !== undefined) {
    if (!isRecord(input.roles)) {
      throw badRequest({
        code: 'ai.chart.rolesNotObject',
        messageKey: 'ai:error.chart.rolesNotObject',
        message: 'roles 必须是对象',
      });
    }
    roles = {};
    for (const [key, value] of Object.entries(input.roles)) {
      asColumn(key, `roles.${key}`, columns);
      if (!ROLES.has(String(value))) {
        throw badRequest({
          code: 'ai.chart.roleInvalid',
          messageKey: 'ai:error.chart.roleInvalid',
          params: { role: key },
          message: `非法角色: ${key}`,
        });
      }
      roles[key] = String(value);
    }
  }

  let options: Record<string, unknown> | undefined;
  if (input.options !== undefined) {
    if (!isRecord(input.options)) {
      throw badRequest({
        code: 'ai.chart.optionsNotObject',
        messageKey: 'ai:error.chart.optionsNotObject',
        message: 'options 必须是对象',
      });
    }
    for (const key of Object.keys(input.options)) {
      assertSafeKey(key);
      if (!spec.optionKeys.includes(key)) {
        throw badRequest({
          code: 'ai.chart.optionUnsupported',
          messageKey: 'ai:error.chart.optionUnsupported',
          params: { option: key },
          message: `不支持的 options: ${key}（可用：${spec.optionKeys.join(' / ')}）`,
        });
      }
    }
    options = input.options;
  }

  const preferred =
    input.preferred_view === 'table' || input.preferred_view === 'pivot' || input.preferred_view === 'chart'
      ? input.preferred_view
      : undefined;

  return {
    chart_type: chartType,
    ...(preferred ? { preferred_view: preferred } : {}),
    ...(roles ? { roles } : {}),
    bindings: {
      ...(x ? { x } : {}),
      ...(category ? { category } : {}),
      ...(series ? { series } : {}),
      metrics,
      ignored,
      ...(rowSelector ? { row_selector: rowSelector } : {}),
      ...(funnel ? { funnel } : {}),
    },
    ...(options ? { options } : {}),
  };
}
