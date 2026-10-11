import type { TFunction } from '../../i18n';

export const CHART_CONFIG_SCHEMA_VERSION = 1 as const;
export const CHART_RECOMMENDATION_VERSION = 1 as const;
export const PROFILE_SAMPLE_LIMIT = 100;
export const CHART_MAX_INPUT_ROWS = 10_000;
export const TABLE_VIRTUALIZE_ROWS = 200;
export const LINE_MAX_SERIES = 5;
export const LINE_MAX_POINTS_PER_SERIES = 1000;
export const LINE_MAX_TOTAL_POINTS = 5000;
export const BAR_MAX_METRICS = 4;
export const BAR_HORIZONTAL_CATEGORY_THRESHOLD = 15;
export const BAR_TOP_N_THRESHOLD = 20;
export const BAR_DEFAULT_TOP_N = 20;
export const PIE_DIRECT_MAX = 6;
export const PIE_OTHER_MAX_CATEGORIES = 50;
export const PIE_TOP_N = 5;
export const NUMBER_MAX_METRICS = 8;
export const FUNNEL_MIN_STEPS = 3;
export const FUNNEL_MAX_STEPS = 8;
export const CHART_CONFIG_MAX_BYTES = 32 * 1024;
export const LABEL_MAX_LENGTH = 100;
export const ROW_SELECTOR_STRING_MAX = 256;
export const TOP_N_MIN = 1;
export const TOP_N_MAX = 20;
export const LINE_MAX_METRICS = 5;
export const ANIMATION_MS = 200;

/**
 * 图表类型白名单按域收窄（phase: clklog-analytics-event-chart-binding-v1）。
 * `chart_config` 是两个域共用的同一份契约，但图型集合不同，合并会放进没有渲染器的类型。
 */
export const CHART_TYPES_SQL: readonly string[] = [
  'table',
  'number',
  'line',
  'bar',
  'pie',
  'funnel',
  'trend',
];
export const CHART_TYPES_EVENT: readonly string[] = [
  'table',
  'number',
  'line',
  'bar',
  'pie',
  'trend',
  'stack',
  'cumulative',
  'distribution',
];

export const X_LABEL_ROTATE_MIN = 0;
export const X_LABEL_ROTATE_MAX = 90;
export const X_LABEL_WIDTH_MIN = 24;
export const X_LABEL_WIDTH_MAX = 400;

/**
 * 双轴建议阈值：指标最大绝对值的相邻比值达到该倍数时提示可拆到右轴。
 *
 * 50 倍（约 1.7 个数量级）来自实测：单轴上两个指标相差不到 50 倍时小指标虽被压矮但仍可辨，
 * 超过 50 倍就基本贴着基线。事件侧默认折线最多 5 条，`LINE_MAX_SERIES` 是透视线数上限。
 */
export const AXIS_SPLIT_RATIO = 50;

/** X 轴标签自动策略的分档阈值（见 `resolveXLabel`） */
export const X_LABEL_SHORT_LENGTH = 10;
export const X_LABEL_FLAT_MAX_CATEGORIES = 6;
export const X_LABEL_NARROW_MAX_CATEGORIES = 10;
export const X_LABEL_ROTATE_MAX_CATEGORIES = 20;
export const X_LABEL_WIDE_WIDTH = 96;
export const X_LABEL_NARROW_WIDTH = 88;

export const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const TIME_NAME_EXACT = /^(day|date|hour|week|month|time|日期|时间|小时|周|月)$/i;
export const ID_NAME = /(^|_)(id|key|code|rank|order)$|ID|编号|编码|序号/i;
export const CATEGORY_NAME =
  /name|type|category|channel|platform|os|country|scene|room|名称|类型|渠道|平台|场景|房间|国家/i;
export const METRIC_NAME =
  /count|sum|avg|min|max|total|pv|uv|users|revenue|amount|duration|数量|次数|人数|用户数|收入|金额|时长|均值|事件量|浏览量|访问量|点击量/i;
export const RATIO_NAME = /rate|ratio|percent|_pct|_%$|率|占比|转化率/i;
export const PERCENT_NAME = /percent|_pct|_%$|百分比/i;
export const NON_ADDITIVE_NAME =
  /uv|uniq|distinct|avg|rate|ratio|percent|quantile|用户数|人数|均值|率|占比|分位/i;
export const ADDITIVE_NAME = /count|sum|total|pv|次数|数量|收入|金额|事件量|浏览量|访问量|点击量/i;
export const BOOLEAN_NAME = /^(is_|has_|bool)/i;
export const COUNT_UNIT_NAME =
  /uv|pv|uniq|count|次数|人数|用户数|数量|事件量|浏览量|访问量|点击量/i;
export const CURRENCY_NAME = /revenue|amount|income|收入|金额|充值额/i;
export const DURATION_MS_NAME = /duration_ms|_ms$|毫秒/i;
export const DURATION_SEC_NAME = /duration_sec|_sec$|秒|时长/i;

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const DATETIME_LOCAL = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
export const DATETIME_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export const STRICT_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * 图表类型展示名（i18n `sql` 命名空间）。
 *
 * 文案随当前语言，取文案必须由调用方把 `t` 传进来——模块作用域取不到当前语言。
 * 用 switch 而不是动态拼键：键在源码里保持字面量，`scripts/i18n_check.py` 才能静态校验。
 */
export function chartTypeLabel(chartType: string, t: TFunction): string {
  switch (chartType) {
    case 'table':
      return t('sql:chart.type.table');
    case 'number':
      return t('sql:chart.type.number');
    case 'line':
      return t('sql:chart.type.line');
    case 'bar':
      return t('sql:chart.type.bar');
    case 'pie':
      return t('sql:chart.type.pie');
    case 'funnel':
      return t('sql:chart.type.funnel');
    case 'trend':
      return t('sql:chart.type.trend');
    default:
      return chartType;
  }
}
