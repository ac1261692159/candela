import { describe, expect, it } from 'vitest';
import {
  autoEventChartConfig,
  bindingColumns,
  columnRole,
  defaultUnitForColumn,
  readEventChartConfig,
  unboundAxisColumns,
} from './event-chart-config';
import type { ChartConfigV1 } from '../visualization/chart.types';
import type { QueryColumn } from '../../types/dsl.types';
import { defaultOptions } from '../visualization/chart-compatibility';

const col = (key: string, over: Partial<QueryColumn> = {}): QueryColumn => ({
  key,
  title: key,
  ...over,
});

const eventColumns: QueryColumn[] = [
  col('g_0', { role: 'time', title: '日期' }),
  col('g_1', { role: 'dimension', title: '渠道' }),
  col('m_0', { role: 'metric', title: '消耗总量' }),
  col('m_1', { role: 'metric', title: '消耗用户数' }),
];

const config = (over: Partial<ChartConfigV1> = {}): ChartConfigV1 => ({
  schema_version: 1,
  recommendation_version: 1,
  mode: 'manual',
  preferred_view: 'chart',
  chart_type: 'line',
  roles: { g_0: 'time', g_1: 'dimension', m_0: 'metric', m_1: 'metric' },
  bindings: { x: 'g_0', metrics: ['m_0', 'm_1'], ignored: [] },
  options: defaultOptions({ units: { m_0: 'number', m_1: 'number' } }),
  ...over,
});

describe('event-chart-config', () => {
  describe('columnRole', () => {
    it('服务端 role 优先', () => {
      expect(columnRole(col('g_0', { role: 'time' }))).toBe('time');
      expect(columnRole(col('m_0', { role: 'metric' }))).toBe('metric');
      // role 说是维度，即便 key 像指标列
      expect(columnRole(col('m_9', { role: 'dimension' }))).toBe('dimension');
    });

    it('缺 role 时回退前缀（旧缓存结果 / 漏斗留存结果）', () => {
      expect(columnRole(col('g_0'))).toBe('dimension');
      expect(columnRole(col('m_0'))).toBe('metric');
      expect(columnRole(col('cohort_date'))).toBe('dimension');
      expect(columnRole(col('n_1_rate'))).toBe('metric');
    });
  });

  describe('defaultUnitForColumn', () => {
    it('按列自己的口径推导', () => {
      expect(defaultUnitForColumn(col('m_0', { unit: 'percent' }))).toBe('ratio_0_1');
      expect(defaultUnitForColumn(col('m_0', { unit: 'duration_sec' }))).toBe('duration_sec');
      expect(defaultUnitForColumn(col('m_0', { unit: 'number' }))).toBe('number');
      expect(defaultUnitForColumn(col('m_0'))).toBe('number');
      expect(defaultUnitForColumn(col('n_1_rate'))).toBe('ratio_0_1');
    });
  });

  describe('autoEventChartConfig', () => {
    it('X 轴取第一个时间列，指标全选，不自动拆分系列', () => {
      const auto = autoEventChartConfig(eventColumns, 'line');
      expect(auto.mode).toBe('auto');
      expect(auto.chart_type).toBe('line');
      expect(auto.bindings.x).toBe('g_0');
      expect(auto.bindings.series).toBeUndefined();
      expect(auto.bindings.metrics).toEqual(['m_0', 'm_1']);
      expect(auto.roles).toEqual({ g_0: 'time', g_1: 'dimension', m_0: 'metric', m_1: 'metric' });
    });

    it('没有时间列时退到第一个维度列', () => {
      const auto = autoEventChartConfig(
        [col('g_0', { role: 'dimension' }), col('m_0', { role: 'metric' })],
        'bar',
      );
      expect(auto.bindings.x).toBe('g_0');
    });

    it('既无时间列也无维度列时回退第一列（无分组的数值卡不能变成空态）', () => {
      // 线上形状：事件卡 chart_type='number' + groups=[] → 结果只有指标列。
      // 改造前的回退是 columns[0]；少了它，ExploreChart 会因 categories 为空渲染「暂无数据」。
      const auto = autoEventChartConfig(
        [col('m_0', { role: 'metric' }), col('m_1', { role: 'metric' })],
        'number',
      );
      expect(auto.bindings.x).toBe('m_0');
      expect(auto.bindings.metrics).toEqual(['m_0', 'm_1']);
    });

    it('单位按列推导；非缺省的 _view.y_unit 覆盖全部指标（旧卡兼容）', () => {
      const columns = [
        col('g_0', { role: 'time' }),
        col('m_0', { role: 'metric', title: '次数' }),
        col('m_1', { role: 'metric', title: '时长', unit: 'duration_sec' }),
      ];
      const derived = autoEventChartConfig(columns, 'line');
      expect(derived.options.units).toEqual({ m_0: 'number', m_1: 'duration_sec' });

      const inherited = autoEventChartConfig(columns, 'line', 'duration_sec');
      expect(inherited.options.units).toEqual({ m_0: 'duration_sec', m_1: 'duration_sec' });

      // 缺省 'number' 不携带用户意图，仍按列推导
      const asDefault = autoEventChartConfig(columns, 'line', 'number');
      expect(asDefault.options.units).toEqual({ m_0: 'number', m_1: 'duration_sec' });
    });
  });

  describe('readEventChartConfig', () => {
    it('没有 chart_config 时合成自动绑定，且不报问题', () => {
      const read = readEventChartConfig({ raw: null, columns: eventColumns, chartType: 'line' });
      expect(read.saved).toBe(false);
      expect(read.config.mode).toBe('auto');
      expect(read.issues).toEqual([]);
    });

    it('合法配置按原样复现', () => {
      const saved = config({ mode: 'manual', options: defaultOptions({ metric_axis: { m_1: 'right' } }) });
      const read = readEventChartConfig({ raw: saved, columns: eventColumns, chartType: 'line' });
      expect(read.saved).toBe(true);
      expect(read.config.options.metric_axis).toEqual({ m_1: 'right' });
      expect(read.issues).toEqual([]);
    });

    it('列引用失效时回退自动绑定，报 STALE_BINDING 且不覆盖原配置', () => {
      const stale = config({ bindings: { x: 'gone', metrics: ['m_0'], ignored: [] } });
      const read = readEventChartConfig({ raw: stale, columns: eventColumns, chartType: 'line' });
      expect(read.saved).toBe(false);
      expect(read.config.bindings.x).toBe('g_0');
      expect(read.issues.map((issue) => issue.code)).toEqual(['STALE_BINDING']);
      expect(read.issues[0].columns).toContain('gone');
    });

    it('未来版本回退自动绑定并保留版本问题码', () => {
      const read = readEventChartConfig({
        raw: { ...config(), schema_version: 2 },
        columns: eventColumns,
        chartType: 'line',
      });
      expect(read.saved).toBe(false);
      expect(read.issues.map((issue) => issue.code)).toEqual(['UNSUPPORTED_CONFIG_VERSION']);
    });

    it('旧格式（只有 chart_type）按没有配置处理', () => {
      const read = readEventChartConfig({
        raw: { chart_type: 'bar' },
        columns: eventColumns,
        chartType: 'line',
      });
      expect(read.saved).toBe(false);
      expect(read.issues).toEqual([]);
    });
  });

  describe('列解释辅助', () => {
    it('bindingColumns 用已保存 roles，缺失时回退', () => {
      const items = bindingColumns(eventColumns, { g_0: 'ignored', m_0: 'metric' });
      expect(items.map((item) => [item.key, item.role])).toEqual([
        ['g_0', 'ignored'],
        ['g_1', 'dimension'],
        ['m_0', 'metric'],
        ['m_1', 'metric'],
      ]);
      expect(items[0].typeLabel).toBeUndefined();
    });

    it('unboundAxisColumns 排除已绑定与被忽略的维度列', () => {
      expect(unboundAxisColumns(config(), eventColumns).map((item) => item.key)).toEqual(['g_1']);
      expect(
        unboundAxisColumns(config({ bindings: { x: 'g_0', series: 'g_1', metrics: [], ignored: [] } }), eventColumns),
      ).toEqual([]);
      expect(
        unboundAxisColumns(config({ bindings: { x: 'g_0', metrics: [], ignored: ['g_1'] } }), eventColumns),
      ).toEqual([]);
    });
  });
});
