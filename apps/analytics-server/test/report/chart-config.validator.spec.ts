import { DomainError } from '../../src/i18n/domain-error';
import { parseChartConfigV1, sanitizeStoredChartConfig } from '../../src/modules/report/chart-config.validator';

/** i18n v1：同步抛错断言统一为「DomainError + HTTP 状态 + 机器码」，比单看异常类更严 */
function expectDomainError(fn: () => unknown, errorCode: string, status = 400) {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DomainError);
  expect(thrown).toMatchObject({ status, errorCode });
}

const valid = {
  schema_version: 1,
  recommendation_version: 1,
  mode: 'manual',
  preferred_view: 'chart',
  chart_type: 'bar',
  roles: { country: 'dimension', event_count: 'metric' },
  bindings: { category: 'country', metrics: ['event_count'], ignored: [] },
  options: {
    orientation: 'vertical',
    donut: false,
    include_other: false,
    units: { event_count: 'number' },
    aggregation: { event_count: 'additive' },
  },
};

describe('chart-config.validator', () => {
  it('accepts complete line/bar/pie/number/funnel/table configs', () => {
    expect(parseChartConfigV1({ ...valid, options: { ...valid.options, stat_calcs: ['last', 'avg'] } }).options).toMatchObject({
      stat_calcs: ['last', 'avg'],
    });
    expect(parseChartConfigV1({ ...valid, chart_type: 'line', bindings: { x: 'day', metrics: ['event_count'], ignored: [] } }).chart_type).toBe('line');
    expect(
      parseChartConfigV1({
        ...valid,
        chart_type: 'funnel',
        bindings: {
          metrics: ['a', 'b', 'c'],
          ignored: [],
          funnel: {
            shape: 'wide',
            metric_family: 'uv',
            steps: [
              { order: 1, column: 'a', label: 'a' },
              { order: 2, column: 'b', label: 'b' },
              { order: 3, column: 'c', label: 'c' },
            ],
          },
        },
      }).chart_type,
    ).toBe('funnel');
  });

  it('rejects non-whitelist fields, scripts, oversize steps/top_n and dangerous keys', () => {
    expectDomainError(() => parseChartConfigV1({ ...valid, option: {} }), 'report.chart.fieldUnsupported');
    expectDomainError(
      () => parseChartConfigV1({ ...valid, options: { ...valid.options, formatter: 'alert(1)' } }),
      'report.chart.optionsUnsupported',
    );
    expectDomainError(
      () => parseChartConfigV1({ ...valid, options: { ...valid.options, stat_calcs: ['nope'] } }),
      'report.chart.statCalcsInvalid',
    );
    expectDomainError(
      () => parseChartConfigV1({ ...valid, options: { ...valid.options, top_n: 99 } }),
      'report.chart.topNInvalid',
    );
    expectDomainError(
      () => parseChartConfigV1({ ...valid, roles: { constructor: 'metric' } }),
      'report.chart.keyInvalid',
    );
    expectDomainError(
      () => parseChartConfigV1({ ...valid, schema_version: 2 }),
      'report.chart.schemaVersionUnsupported',
    );
    expect(
      parseChartConfigV1({ ...valid, options: { ...valid.options, units: { event_count: 'currency_cny' } } }).options.units,
    ).toEqual({ event_count: 'currency_cny' });
    expectDomainError(
      () => parseChartConfigV1({ ...valid, options: { ...valid.options, units: { event_count: 'watt' } } }),
      'report.chart.unitInvalid',
    );
  });

  it('returns null for legacy or corrupt stored JSON without throwing', () => {
    const logs: string[] = [];
    expect(sanitizeStoredChartConfig({ chart_type: 'line' }, (message) => logs.push(message))).toBeNull();
    expect(sanitizeStoredChartConfig({ nope: true }, (message) => logs.push(message))).toBeNull();
    expect(logs.length).toBeGreaterThan(0);
  });

  /**
   * 图型白名单按域收窄（phase: clklog-analytics-event-chart-binding-v1）。
   * `chart_config` 是事件分析与自定义 SQL 共用的同一份契约，但两侧图型集合不同：
   * 事件侧有 stack/cumulative/distribution，SQL 侧有 funnel。
   */
  describe('域白名单', () => {
    const SQL_TYPES = ['table', 'number', 'line', 'bar', 'pie', 'funnel', 'trend'];
    const EVENT_ONLY = ['stack', 'cumulative', 'distribution'];

    const withChartType = (chartType: string) => ({ ...valid, chart_type: chartType });

    it('缺省域为 sql：接受 SQL 图型，拒绝事件独有图型', () => {
      for (const chartType of SQL_TYPES) {
        expect(parseChartConfigV1(withChartType(chartType)).chart_type).toBe(chartType);
      }
      for (const chartType of EVENT_ONLY) {
        expectDomainError(() => parseChartConfigV1(withChartType(chartType)), 'report.chart.enumInvalid');
      }
    });

    it('显式传 sql 与缺省逐项一致', () => {
      for (const chartType of [...SQL_TYPES, ...EVENT_ONLY]) {
        const absent = captureError(() => parseChartConfigV1(withChartType(chartType)));
        const explicit = captureError(() => parseChartConfigV1(withChartType(chartType), 'sql'));
        expect(explicit).toEqual(absent);
      }
    });

    it('事件域接受事件独有图型，拒绝 SQL 独有的 funnel', () => {
      for (const chartType of [...EVENT_ONLY, ...SQL_TYPES.filter((item) => item !== 'funnel')]) {
        expect(parseChartConfigV1(withChartType(chartType), 'event').chart_type).toBe(chartType);
      }
      expectDomainError(() => parseChartConfigV1(withChartType('funnel'), 'event'), 'report.chart.enumInvalid');
    });

    it('sanitizeStoredChartConfig 按域取舍', () => {
      const log = () => undefined;
      expect(sanitizeStoredChartConfig(withChartType('stack'), log, 'event')?.chart_type).toBe('stack');
      expect(sanitizeStoredChartConfig(withChartType('stack'), log)).toBeNull();
    });
  });

  /** 指标轴归属（双轴）与 X 轴标签策略 */
  describe('metric_axis / x_label', () => {
    const withOptions = (options: Record<string, unknown>) =>
      parseChartConfigV1({ ...valid, options: { ...valid.options, ...options } });

    it('接受 left/right 映射', () => {
      expect(withOptions({ metric_axis: { m_0: 'left', m_1: 'right' } }).options.metric_axis).toEqual({
        m_0: 'left',
        m_1: 'right',
      });
    });

    it('拒绝非对象、非法轴值与危险键', () => {
      expectDomainError(() => withOptions({ metric_axis: 'right' }), 'report.chart.axisInvalid');
      expectDomainError(() => withOptions({ metric_axis: { m_0: 'top' } }), 'report.chart.axisValueInvalid');
      expectDomainError(() => withOptions({ metric_axis: { constructor: 'right' } }), 'report.chart.keyInvalid');
    });

    it('x_label 允许 null、缺省与合法边界', () => {
      expect(withOptions({ x_label: null }).options.x_label).toBeNull();
      expect(withOptions({ x_label: { rotate: 0, max_width: 24 } }).options.x_label).toEqual({ rotate: 0, max_width: 24 });
      expect(withOptions({ x_label: { rotate: 90, max_width: 400 } }).options.x_label).toEqual({ rotate: 90, max_width: 400 });
      expect(withOptions({ x_label: { rotate: null, max_width: null } }).options.x_label).toEqual({
        rotate: null,
        max_width: null,
      });
    });

    it('x_label 拒绝越界、非数值与未知键', () => {
      expectDomainError(() => withOptions({ x_label: { rotate: 91 } }), 'report.chart.xLabelInvalid');
      expectDomainError(() => withOptions({ x_label: { rotate: -1 } }), 'report.chart.xLabelInvalid');
      expectDomainError(() => withOptions({ x_label: { max_width: 23 } }), 'report.chart.xLabelInvalid');
      expectDomainError(() => withOptions({ x_label: { max_width: 401 } }), 'report.chart.xLabelInvalid');
      expectDomainError(() => withOptions({ x_label: { rotate: '30' } }), 'report.chart.xLabelInvalid');
      expectDomainError(() => withOptions({ x_label: { rotate: 30, width: 10 } }), 'report.chart.xLabelInvalid');
      expectDomainError(() => withOptions({ x_label: [] }), 'report.chart.xLabelInvalid');
    });
  });
});

/** 捕获校验器的错误码，用于逐项对比两个域的行为是否等价 */
function captureError(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { errorCode?: string }).errorCode ?? 'unknown';
  }
}
