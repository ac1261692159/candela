// 顶层加载 YAML 配置的模块（clickhouse/redis/query-cache 都在 event-query.service 的依赖链上）
// 在单测里隔离，CI 无密钥也能跑。见 scripts/build.sh 的后端单测说明。
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { EventQueryService, eventGroupRole } from '../../src/modules/query/event-query.service';
import type { EventAnalysisQuery } from '../../src/types/dsl.types';

/**
 * 结果列 role 是事件侧图表字段绑定（phase: clklog-analytics-event-chart-binding-v1）的输入：
 * 前端据此列出 X 轴 / 拆分系列 / 指标的候选列，不再靠 `g_` / `m_` 前缀或中文标题猜。
 * 这里覆盖 §6.1 判定表的全部分支。
 */
describe('event column role', () => {
  describe('eventGroupRole', () => {
    it('把构成时间轴的时间分组判为 time', () => {
      expect(eventGroupRole({ scope: 'time', granularity: 'day' })).toBe('time');
      expect(eventGroupRole({ scope: 'time', granularity: 'hour' })).toBe('time');
      expect(eventGroupRole({ scope: 'time', granularity: 'week' })).toBe('time');
      expect(eventGroupRole({ scope: 'time', granularity: 'month' })).toBe('time');
      expect(eventGroupRole({ scope: 'time', granularity: 'minute' })).toBe('time');
    });

    it('缺 granularity 的时间分组按 day 处理，仍是 time', () => {
      expect(eventGroupRole({ scope: 'time' })).toBe('time');
    });

    it('granularity=total 的取值是汇总值而非时间点，判为 dimension', () => {
      expect(eventGroupRole({ scope: 'time', granularity: 'total' })).toBe('dimension');
    });

    it('属性 / 分群 / 标签分组一律判为 dimension', () => {
      expect(eventGroupRole({ scope: 'event', prop: 'channel_name' })).toBe('dimension');
      expect(eventGroupRole({ scope: 'user', prop: 'country' })).toBe('dimension');
      expect(eventGroupRole({ scope: 'cohort' })).toBe('dimension');
      expect(eventGroupRole({ scope: 'tag' })).toBe('dimension');
    });

    it('时间提取（时段 / 日 / 分）挂在属性分组上，判为 dimension', () => {
      // extract 只在非 time scope 上生效（SQL 生成器对 scope==='time' 提前返回做时间桶）
      expect(eventGroupRole({ scope: 'event', prop: 'log_time', extract: 'hour_of_day' })).toBe(
        'dimension',
      );
      expect(eventGroupRole({ scope: 'event', prop: 'log_time', extract: 'day_of_month' })).toBe(
        'dimension',
      );
      expect(eventGroupRole({ scope: 'event', prop: 'log_time', extract: 'minute_of_hour' })).toBe(
        'dimension',
      );
    });
  });

  describe('formatResult 装配的列 role', () => {
    function serviceWith(prisma: unknown, datatables: unknown = {}): EventQueryService {
      // formatResult / resolveGroupTitles 只用得到 prisma 与 datatables，其余依赖传空壳
      return new EventQueryService(
        null as never,
        null as never,
        null as never,
        null as never,
        null as never,
        null as never,
        datatables as never,
        prisma as never,
      );
    }

    function format(query: EventAnalysisQuery) {
      const service = serviceWith({
        metaEventAttribute: { findMany: async () => [] },
        metaUserProperty: { findMany: async () => [] },
      });
      return (
        service as unknown as {
          formatResult: (rows: Record<string, unknown>[], q: EventAnalysisQuery) => {
            columns: { key: string; role: string; hidden?: boolean }[];
          };
        }
      ).formatResult([], query);
    }

    it('分组列按下标对应 groups 的 scope 判定，指标列恒为 metric', () => {
      const { columns } = format({
        event: '$pageview',
        groups: [
          { scope: 'time', granularity: 'day' },
          { scope: 'event', prop: 'channel_name' },
        ],
        metrics: [{ id: 'a' }, { id: 'b' }],
      } as unknown as EventAnalysisQuery);

      expect(columns.map((c) => [c.key, c.role])).toEqual([
        ['g_0', 'time'],
        ['g_1', 'dimension'],
        ['m_0', 'metric'],
        ['m_1', 'metric'],
      ]);
    });

    it('granularity=total 的分组不产生列', () => {
      const { columns } = format({
        event: '$pageview',
        groups: [{ scope: 'time', granularity: 'total' }, { scope: 'event', prop: 'city' }],
        metrics: [{ id: 'a' }],
      } as unknown as EventAnalysisQuery);

      // total 分组被跳过，剩下的属性分组沿用原下标 g_1
      expect(columns.map((c) => [c.key, c.role])).toEqual([
        ['g_1', 'dimension'],
        ['m_0', 'metric'],
      ]);
    });

    it('hidden 指标不产生列，索引仍按原下标', () => {
      const { columns } = format({
        event: '$pageview',
        groups: [],
        metrics: [{ id: 'a', hidden: true }, { id: 'b' }],
      } as unknown as EventAnalysisQuery);

      expect(columns.map((c) => [c.key, c.role])).toEqual([['m_1', 'metric']]);
    });

    it('公式指标也是 metric', () => {
      const { columns } = format({
        event: '$pageview',
        groups: [],
        metrics: [
          { id: 'a' },
          { id: 'f', kind: 'formula', expression: { type: 'metric', id: 'a' } },
        ],
      } as unknown as EventAnalysisQuery);

      expect(columns.map((c) => [c.key, c.role])).toEqual([
        ['m_0', 'metric'],
        ['m_1', 'metric'],
      ]);
    });
  });

  describe('role 在列增强链路上不丢', () => {
    it('属性显示名覆盖 title 时保留 role', async () => {
      const service = new EventQueryService(
        null as never,
        null as never,
        null as never,
        null as never,
        null as never,
        null as never,
        { dimensionDisplayNames: async () => new Map() } as never,
        {
          metaEventAttribute: {
            findMany: async () => [{ prop_key: 'channel_name', display_name: '渠道' }],
          },
          metaUserProperty: { findMany: async () => [] },
        } as never,
      );

      const columns = [
        { key: 'g_0', role: 'dimension', title: 'channel_name', title_key: 'analysis:column.foo' },
        { key: 'm_0', role: 'metric', title: '消耗总量' },
      ];
      const resolved = await (
        service as unknown as {
          resolveGroupTitles: <T>(cols: T[], q: EventAnalysisQuery) => Promise<T[]>;
        }
      ).resolveGroupTitles(columns, {
        event: '$pageview',
        project: 'p1',
        groups: [{ scope: 'event', prop: 'channel_name' }],
        metrics: [],
      } as unknown as EventAnalysisQuery);

      expect(resolved[0]).toMatchObject({ key: 'g_0', role: 'dimension', title: '渠道' });
      expect(resolved[0].title_key).toBeUndefined();
      expect(resolved[1]).toMatchObject({ key: 'm_0', role: 'metric', title: '消耗总量' });
    });
  });
});
