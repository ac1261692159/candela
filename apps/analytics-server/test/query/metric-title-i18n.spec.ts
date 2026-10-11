/**
 * 复合指标列名的 i18n 契约（phase: clklog-analytics-i18n-v1 收口）。
 *
 * 服务端只下发 `title_key` + `title_params`（固定文案走 `<slot>_key` 子键，如 `method_key` /
 * `event_key`），结果进缓存也不固化语言。本用例直接读 zh-CN 资源渲染一遍：
 * **中文界面逐字等于 `metricTitle()` 的拼装结果**（含分隔点与空格形态）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { metricTitle, metricTitleDescriptor } from '../../src/modules/query/metric-normalize';
import type { Metric } from '../../src/types/dsl.types';

function loadAnalysisBundle(locale: string): Record<string, string> {
  const path = join(__dirname, '../../../analytics-web/src/i18n/locales', locale, 'analysis.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const flat: Record<string, string> = {};
  const walk = (value: unknown, prefix: string): void => {
    if (typeof value === 'string') {
      flat[prefix] = value;
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, prefix ? `${prefix}.${key}` : key);
      }
    }
  };
  walk(raw, '');
  return flat;
}

const zh = loadAnalysisBundle('zh-CN');
const en = loadAnalysisBundle('en-US');

/** 与前端 `resolveTitleParams` + `t()` 同口径的最小渲染器（只解析一层 `<slot>_key`） */
function render(template: string, params: Record<string, unknown>, bundle: Record<string, string>): string {
  const resolved: Record<string, unknown> = { ...params };
  for (const [name, value] of Object.entries(params)) {
    if (!name.endsWith('_key') || typeof value !== 'string' || !value.includes(':')) continue;
    const slot = name.slice(0, -'_key'.length);
    resolved[slot] = bundle[value.slice(value.indexOf(':') + 1)];
  }
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, name: string) =>
    String(resolved[name] ?? ''),
  );
}

const SHAPES: Array<[string, Metric]> = [
  ['event.prop.method', { id: 'm', kind: 'event', event: 'pv', prop: 'amount', analysis: 'avg' }],
  ['event.method', { id: 'm', kind: 'event', event: 'pv', analysis: 'total_times' }],
  ['prop.method', { id: 'm', kind: 'event', prop: 'amount', analysis: 'avg' }],
  ['method', { id: 'm', kind: 'event', analysis: 'total_times' }],
  ['event.prop.method（分位数中位数）', {
    id: 'm',
    kind: 'event',
    event: 'pv',
    prop: 'amount',
    analysis: 'percentile',
    percentile: 50,
  }],
  ['event.prop.method（分位数 P75，语言无关）', {
    id: 'm',
    kind: 'event',
    event: 'pv',
    prop: 'amount',
    analysis: 'percentile',
    percentile: 75,
  }],
  ['任意事件.method', { id: 'm', kind: 'event', event: '*', analysis: 'trig_user_num' }],
  ['任意事件.prop.method', {
    id: 'm',
    kind: 'event',
    event: '*',
    prop: 'amount',
    analysis: 'avg',
  }],
];

describe('metricTitleDescriptor（复合指标列名）', () => {
  it('每种拼装形态都下发 title_key（形态 ↔ 键一一对应）', () => {
    expect(SHAPES.map(([, metric]) => metricTitleDescriptor(metric).title_key)).toEqual([
      'analysis:column.metricEventPropMethod',
      'analysis:column.metricEventMethod',
      'analysis:column.metricPropMethod',
      'analysis:column.metricMethod',
      'analysis:column.metricEventPropMethod',
      'analysis:column.metricEventPropMethod',
      'analysis:column.metricEventMethod',
      'analysis:column.metricEventPropMethod',
    ]);
  });

  it('每种拼装形态的 zh 渲染逐字等于 metricTitle() 与服务端 title', () => {
    const rendered = SHAPES.map(([label, metric]) => {
      const descriptor = metricTitleDescriptor(metric);
      const template = zh[descriptor.title_key!.slice(descriptor.title_key!.indexOf(':') + 1)] ?? '(缺资源)';
      // 格式：形态 · key 模板渲染结果 · 服务端 title · metricTitle 原值
      return `${label} | ${render(template, descriptor.title_params ?? {}, zh)} | ${descriptor.title} | ${metricTitle(metric)}`;
    });
    expect(rendered).toEqual(
      SHAPES.map(([label, metric]) => `${label} | ${metricTitle(metric)} | ${metricTitle(metric)} | ${metricTitle(metric)}`),
    );
  });

  it('固定文案走子键：方法名 method_key / 任意事件 event_key', () => {
    const triple = metricTitleDescriptor({
      id: 'm',
      kind: 'event',
      event: 'pv',
      prop: 'amount',
      analysis: 'avg',
    });
    expect(triple.title_params).toMatchObject({
      event: 'pv',
      prop: 'amount',
      method: '均值',
      method_key: 'analysis:analysisMethod.avg',
    });

    const anyEvent = metricTitleDescriptor({ id: 'm', kind: 'event', event: '*', analysis: 'total_times' });
    expect(anyEvent.title_params).toMatchObject({
      event: '任意事件',
      event_key: 'analysis:column.anyEvent',
      method: '总次数',
      method_key: 'analysis:analysisMethod.totalTimes',
    });
    // 子键与整串键在中英文资源里都存在（缺一个 en 就会显示键名）
    for (const descriptor of [triple, anyEvent]) {
      const paths = [
        descriptor.title_key!,
        ...Object.values(descriptor.title_params ?? {}).filter(
          (value): value is string => typeof value === 'string' && value.includes(':'),
        ),
      ].map((key) => key.slice(key.indexOf(':') + 1));
      expect(paths.map((path) => `${path}=${zh[path] ?? '(缺)'}/${en[path] ?? '(缺)'}`)).toEqual(
        paths.map((path) => `${path}=${zh[path]}/${en[path]}`),
      );
    }
  });

  it('英文渲染无中文，且方法名/任意事件本地化', () => {
    const triple = metricTitleDescriptor({
      id: 'm',
      kind: 'event',
      event: 'pv',
      prop: 'amount',
      analysis: 'avg',
    });
    const template = en[triple.title_key!.slice(triple.title_key!.indexOf(':') + 1)];
    expect(render(template, triple.title_params ?? {}, en)).toBe('pv.amount.Average');

    const anyEvent = metricTitleDescriptor({ id: 'm', kind: 'event', event: '*', analysis: 'total_times' });
    const anyEventTemplate = en[anyEvent.title_key!.slice(anyEvent.title_key!.indexOf(':') + 1)];
    expect(render(anyEventTemplate, anyEvent.title_params ?? {}, en)).toBe('Any event.Total count');
  });

  it('别名 / 指标名是用户数据，公式保持纯固定文案键', () => {
    expect(metricTitleDescriptor({ id: 'm', kind: 'event', event: 'pv', alias: '订单量' })).toEqual({
      title: '订单量',
    });
    expect(metricTitleDescriptor({ id: 'm', kind: 'event', event: 'pv', name: 'order_cnt' })).toEqual({
      title: 'order_cnt',
    });
    expect(metricTitleDescriptor({ id: 'm', kind: 'formula' })).toEqual({
      title: '公式',
      title_key: 'analysis:column.formula',
    });
  });
});
