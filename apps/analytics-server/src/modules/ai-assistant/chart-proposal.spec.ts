import { BadRequestException } from '@nestjs/common';
import {
  parseChartProposal,
  snapshotResultColumns,
  EVENT_CHART_CAPABILITY,
  SQL_CHART_CAPABILITY,
} from './chart-proposal';

describe('chart proposal', () => {
  const columns = ['d', '付费人数', '支付成功次数', '收入金额', '客单价', '首充金额', '复充金额'];

  it('accepts a line binding that ignores extra metrics', () => {
    const parsed = parseChartProposal(
      {
        chart_type: 'line',
        bindings: {
          x: 'd',
          metrics: ['收入金额', '付费人数', '客单价', '首充金额', '复充金额'],
          ignored: ['支付成功次数'],
        },
      },
      columns,
    );
    expect(parsed.bindings.metrics).toHaveLength(5);
    expect(parsed.bindings.x).toBe('d');
  });

  it('rejects more than five line metrics and unknown columns', () => {
    expect(() =>
      parseChartProposal(
        {
          chart_type: 'line',
          bindings: { x: 'd', metrics: ['付费人数', '支付成功次数', '收入金额', '客单价', '首充金额', '复充金额'] },
        },
        columns,
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      parseChartProposal({ chart_type: 'line', bindings: { x: 'd', metrics: ['收入金额'] } }, columns),
    ).not.toThrow();
    expect(() =>
      parseChartProposal({ chart_type: 'bar', bindings: { category: 'nope', metrics: ['收入金额'] } }, columns),
    ).toThrow(/列不存在/);
  });

  it('reads column names from analysis.result_columns first', () => {
    expect(
      snapshotResultColumns({
        analysis: { result_columns: [{ name: 'd', type: 'Date' }, { name: '收入金额', type: 'Float64' }] },
        result: { _truncated: true },
      }),
    ).toEqual(['d', '收入金额']);
    expect(
      snapshotResultColumns({
        analysis: { result_columns: [{ name: 'g_0', role: 'time' }, { name: 'm_0', role: 'metric' }] },
      }),
    ).toEqual(['g_0', 'm_0']);
    expect(SQL_CHART_CAPABILITY.limits.line).toBe(5);
  });

  it('报错自带可用列 / 上限 / 正确键名（AI 一次改对，不靠反复试探）', () => {
    const messageOf = (input: unknown, domain: 'sql' | 'event' = 'sql'): string => {
      try {
        parseChartProposal(input, columns, domain);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('预期抛错但通过了');
    };

    // ① 错键名 dimension：必须点明正确键（以前被静默丢掉，只报「需要 category」）
    const wrongKey = messageOf({ chart_type: 'bar', bindings: { dimension: '付费人数', metrics: ['收入金额'] } });
    expect(wrongKey).toContain('dimension');
    expect(wrongKey).toContain('category');

    // ② 列名写错：必须回列可用列，并指向 result_columns
    const badColumn = messageOf({ chart_type: 'bar', bindings: { category: '不存在的列', metrics: ['收入金额'] } });
    expect(badColumn).toContain('收入金额');
    expect(badColumn).toContain('result_columns');

    // ③ bar 指标超限：说明收到几个、并给出改法
    const tooMany = messageOf({
      chart_type: 'bar',
      bindings: { category: '付费人数', metrics: ['付费人数', '支付成功次数', '收入金额', '客单价', '首充金额'] },
    });
    expect(tooMany).toMatch(/最多 4/);
    expect(tooMany).toContain('ignored');

    // ④ 顶层未知字段（如 schema_version）：列出允许的键
    const extraField = messageOf({ chart_type: 'table', schema_version: 1, bindings: { metrics: ['收入金额'] } });
    expect(extraField).toContain('chart_type / preferred_view / roles / bindings / options');

    // ⑤ capability 里带全契约（供网关下发给模型）
    expect(SQL_CHART_CAPABILITY.required_bindings).toMatchObject({ bar: 'category', line: 'x' });
    expect(SQL_CHART_CAPABILITY.bindings_keys).toContain('category');
    expect(SQL_CHART_CAPABILITY.notes).toContain('不是 dimension');
  });

  /**
   * 事件域（phase: clklog-ai-event-chart-v1）：图型集合、绑定键、指标上限与 SQL 域不同，
   * 共用同一套物化逻辑但白名单按域收窄。列名是结果列 key（g_0 / m_0）。
   */
  describe('事件域', () => {
    const eventColumns = ['g_0', 'm_0', 'm_1', 'm_2'];
    const parse = (input: unknown) => parseChartProposal(input, eventColumns, 'event');
    const messageOf = (input: unknown): string => {
      try {
        parse(input);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('预期抛错但通过了');
    };

    it('接受事件独有图型并保留 metric_axis / units', () => {
      for (const chartType of ['stack', 'cumulative', 'distribution']) {
        const parsed = parse({
          chart_type: chartType,
          bindings: { x: 'g_0', metrics: ['m_0', 'm_1'] },
          options: { metric_axis: { m_1: 'right' }, units: { m_0: 'number' } },
        });
        expect(parsed.chart_type).toBe(chartType);
        expect(parsed.options).toMatchObject({ metric_axis: { m_1: 'right' } });
      }
    });

    it('拒绝 SQL 独有的 funnel 图型与 category 键', () => {
      expect(() => parse({ chart_type: 'funnel', bindings: { metrics: ['m_0'] } })).toThrow(/chart_type 无效/);
      const message = messageOf({ chart_type: 'bar', bindings: { category: 'g_0', metrics: ['m_0'] } });
      expect(message).toContain('category');
      // 事件侧的 bar 也要 x，缺了要说清用哪个键
      expect(messageOf({ chart_type: 'bar', bindings: { metrics: ['m_0'] } })).toContain('bindings.x');
    });

    it('接受 series 拆分系列，且不必与 x 相同', () => {
      const parsed = parse({
        chart_type: 'line',
        bindings: { x: 'g_0', series: 'm_2', metrics: ['m_0', 'm_1'] },
      });
      expect(parsed.bindings.series).toBe('m_2');
    });

    it('拒绝 AI 传 roles 与 SQL 专属 options', () => {
      // roles 由 chart_json 键白名单拒绝，错误里直接列出可用的键
      const rolesMessage = messageOf({ chart_type: 'line', bindings: { x: 'g_0', metrics: ['m_0'] }, roles: { g_0: 'time' } });
      expect(rolesMessage).toContain('不支持的字段: roles');
      expect(rolesMessage).not.toContain('roles /');
      expect(messageOf({ chart_type: 'bar', bindings: { x: 'g_0', metrics: ['m_0'] }, options: { donut: true } }))
        .toContain('不支持的 options');
    });

    it('指标上限按图型分档，超限报出改法', () => {
      const five = ['m_0', 'm_1', 'm_2', 'm_0'];
      expect(parse({ chart_type: 'line', bindings: { x: 'g_0', metrics: ['m_0', 'm_1', 'm_2'] } })).toBeTruthy();
      const tooMany = messageOf({
        chart_type: 'stack',
        bindings: { x: 'g_0', metrics: ['m_0', 'm_1', 'm_2', 'm_0', 'm_1'] },
      });
      expect(tooMany).toMatch(/最多 4/);
      expect(five.length).toBe(4);
    });

    it('列名写错时回可用列（事件侧是 g_0 / m_0 这类 key）', () => {
      const message = messageOf({ chart_type: 'line', bindings: { x: 'day', metrics: ['m_0'] } });
      expect(message).toContain('g_0');
      expect(message).toContain('result_columns');
    });

    it('capability 自述与两域白名单的差异', () => {
      expect(EVENT_CHART_CAPABILITY.bindings_keys).toContain('series');
      expect(EVENT_CHART_CAPABILITY.bindings_keys).not.toContain('category');
      expect(EVENT_CHART_CAPABILITY.bindings_keys).not.toContain('funnel');
      expect(EVENT_CHART_CAPABILITY.chart_types).toContain('distribution');
      expect(EVENT_CHART_CAPABILITY.chart_types).not.toContain('funnel');
      expect(EVENT_CHART_CAPABILITY.notes).toContain('没有 category');
      // SQL 域的 capability 不受影响
      expect(SQL_CHART_CAPABILITY.chart_types).toContain('funnel');
      expect(SQL_CHART_CAPABILITY.chart_types).not.toContain('stack');
    });

    it('SQL 域行为不被事件域改动带偏：sql 拒 stack、event 拒 funnel', () => {
      expect(() => parseChartProposal({ chart_type: 'stack', bindings: { x: 'd', metrics: ['收入金额'] } }, columns, 'sql'))
        .toThrow(/chart_type 无效/);
      expect(() => parse({ chart_type: 'funnel', bindings: { metrics: ['m_0'] } })).toThrow(/chart_type 无效/);
      // 缺省域仍是 sql
      expect(() => parseChartProposal({ chart_type: 'stack', bindings: { x: 'd', metrics: ['收入金额'] } }, columns))
        .toThrow(/chart_type 无效/);
    });
  });

  /**
   * SQL 侧编排可写（phase: clklog-ai-sql-chart-axis-v1）：
   * 页面已支持左右双轴（clklog-analytics-sql-dual-axis-v1），提案白名单原本漏了 metric_axis，
   * 模型想拆轴会撞上「不支持的 options」400。这里锁住 SQL 域的 options 白名单与能力自述。
   */
  describe('SQL 侧分轴与单位', () => {
    const messageOf = (input: unknown): string => {
      try {
        parseChartProposal(input, columns, 'sql');
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('预期抛错但通过了');
    };

    it('接受 options.metric_axis 与 options.units 并原样保留', () => {
      const parsed = parseChartProposal(
        {
          chart_type: 'line',
          bindings: { x: 'd', metrics: ['收入金额', '付费人数'] },
          options: { metric_axis: { 付费人数: 'right' }, units: { 付费人数: 'number' } },
        },
        columns,
        'sql',
      );
      expect(parsed.options).toMatchObject({
        metric_axis: { 付费人数: 'right' },
        units: { 付费人数: 'number' },
      });
    });

    it('轴取值不在本层判：left/right 之外的字符串照样透传给页面校验', () => {
      // 分层：服务端只管「键在白名单里」，key 是否为结果列、值是否为 left/right
      // 由页面 parseChartConfigV1 统一判（避免两处规则漂移）。
      const parsed = parseChartProposal(
        {
          chart_type: 'line',
          bindings: { x: 'd', metrics: ['收入金额'] },
          options: { metric_axis: { 收入金额: 'middle' } },
        },
        columns,
        'sql',
      );
      expect(parsed.options).toMatchObject({ metric_axis: { 收入金额: 'middle' } });
    });

    it('白名单外的 options 键仍拒绝，并在报错里回可用键', () => {
      const message = messageOf({
        chart_type: 'line',
        bindings: { x: 'd', metrics: ['收入金额'] },
        options: { x_label: { rotate: 30 } },
      });
      expect(message).toContain('不支持的 options: x_label');
      expect(message).toContain('metric_axis');
    });

    it('能力自述下发合法单位值（模型不必猜；猜错就是 400）', () => {
      expect(SQL_CHART_CAPABILITY.units).toContain('percent_0_100');
      expect(SQL_CHART_CAPABILITY.units).toContain('ratio_0_1');
      expect(EVENT_CHART_CAPABILITY.units).toEqual(SQL_CHART_CAPABILITY.units);
      // 同轴必须同单位这条规则要写在能力说明里，否则模型会配出混单位状态
      expect(SQL_CHART_CAPABILITY.notes).toContain('同一根轴');
      expect(EVENT_CHART_CAPABILITY.notes).toContain('同一根轴');
      // ratio_0_1 会 ×100 渲染，选错会得到「0.5%」这种结果，必须提前告知
      expect(SQL_CHART_CAPABILITY.notes).toContain('ratio_0_1');
    });

    it('能力自述下发 options_keys，两域对称', () => {
      expect(SQL_CHART_CAPABILITY.options_keys).toContain('metric_axis');
      expect(SQL_CHART_CAPABILITY.options_keys).toContain('units');
      expect(EVENT_CHART_CAPABILITY.options_keys).toContain('metric_axis');
      // SQL 侧独有的漏斗选项不接受轴分派以外的域差异：SQL 不认事件图型，反之亦然
      expect(SQL_CHART_CAPABILITY.options_keys).not.toContain('x_label');
      expect(SQL_CHART_CAPABILITY.notes).toContain('metric_axis');
    });
  });
});
