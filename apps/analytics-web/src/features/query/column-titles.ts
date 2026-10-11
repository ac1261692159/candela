import type { TFunction } from '../../i18n';

/**
 * 结果列名 / 阶段行行值的**单点**本地化（phase: clklog-analytics-i18n-v1）。
 *
 * 背景：事件 / 漏斗 / 留存的结果列名由服务端生成（`队列日期`、`人数`、`D7 留存率`、
 * `登录 转化率`…）。看板卡片结果是**带缓存的**（`CardCache`），所以服务端不能按请求语言
 * 渲染标题——那会把某一种语言固化进缓存，之后其他语言的用户看到错的语言。
 * 契约：服务端固定文案列名附 `title_key` + `title_params`（数据值），中文 `title` 原值保留；
 * 前端在**渲染/导出边界**按查看者语言渲染。
 *
 * 用户数据列（事件名 / 属性名 / 指标别名 / 维表显示名）与老接口响应没有 `title_key`，
 * 一律回落 `title`（服务端中文原值）。
 *
 * 注意：`components/DataTable.tsx` 的时间列启发式（`col.title.includes('时间')`）
 * 依赖**服务端中文原值**，那里必须继续读 `column.title`，不要传本地化标题过去。
 */
export interface LocalizableColumn {
  title: string;
  title_key?: string;
  title_params?: Record<string, unknown>;
}

/** 参数里的**可再解析子键**后缀：`<slot>_key` 指向文案键，渲染后覆盖同名 `{{slot}}` 插值 */
const SUB_KEY_SUFFIX = '_key';

/**
 * 文案键参数：数据原样，`<slot>_key` 指向的**固定文案**先按当前语言渲染。
 *
 * 复合指标列名（`pv.amount.均值`）＝「用户数据 + 固定方法名」拼成，服务端不能按请求语言
 * 渲染（结果进缓存），于是下发
 * `{ event: 'pv', prop: 'amount', method: '均值', method_key: 'analysis:analysisMethod.avg' }`：
 * 本函数把 `method_key` 渲染成当前语言后覆盖 `method` 插槽；事件名 / 属性名 / 天数等
 * 纯数据参数原样保留。事件为 `任意事件` 时同理走 `event_key`（`analysis:column.anyEvent`）。
 *
 * 只解析一层（`<slot>_key` 的值必须是 `ns:key` 形态），不递归、不猜键：
 * 解析出来的文案不再带自己的参数，避免把用户数据当成键。
 */
export function resolveTitleParams(
  params: Record<string, unknown> | undefined,
  t: TFunction,
): Record<string, unknown> {
  if (!params) return {};
  const resolved: Record<string, unknown> = { ...params };
  for (const [name, value] of Object.entries(params)) {
    if (!name.endsWith(SUB_KEY_SUFFIX) || typeof value !== 'string') continue;
    if (!value.includes(':')) continue;
    const slot = name.slice(0, -SUB_KEY_SUFFIX.length);
    if (slot) resolved[slot] = t(value);
  }
  return resolved;
}

/** 有 `title_key`（服务端固定文案）按当前语言渲染，否则回落服务端原文（数据列/老响应） */
export function localizedColumnTitle(column: LocalizableColumn | undefined, t: TFunction): string {
  if (!column) return '';
  if (!column.title_key) return column.title;
  return t(column.title_key, resolveTitleParams(column.title_params, t));
}

/**
 * 「结果 → 视图」边界：按当前语言映射整批列名，再交给表格 / 图表 / 导出。
 * 传本地化后的列时，图表系列名、图例、表头、CSV 表头一次到位，不用逐格判断。
 */
export function localizedColumns<T extends LocalizableColumn>(columns: T[], t: TFunction): T[] {
  return columns.map((column) =>
    column.title_key ? { ...column, title: localizedColumnTitle(column, t) } : column,
  );
}

/**
 * 阶段汇总行的**行值**本地化（i18n 收口）：引擎插入的阶段行（`__stage === true`）在服务端
 * 把分组单元格写成中文「阶段汇总」，这里在渲染该单元格时按查看者语言覆盖。
 *
 * 只覆盖**非空**的分组单元格（`g_*`）：阶段行的其他分组列在服务端是空串（保持空白，
 * 不能整行刷成「阶段汇总」）；非阶段行、非分组列一律返回 `null`（用默认渲染）。
 * 返回 `null` 表示「不改写」。
 */
export function localizedStageCellValue(
  columnKey: string,
  value: unknown,
  row: Record<string, unknown> | undefined,
  t: TFunction,
): string | null {
  if (row?.__stage !== true) return null;
  if (!columnKey.startsWith('g_')) return null;
  if (typeof value !== 'string' || value === '') return null;
  return t('analysis:row.stageTotal');
}
