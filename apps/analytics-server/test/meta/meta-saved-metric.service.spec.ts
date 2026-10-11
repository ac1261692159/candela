/**
 * 指标定义规范化校验（phase: clklog-analytics-metric-detail-v1）。
 *
 * 关注点：**能被保存的指标必须是能用的指标**。
 * 2026-09-15 生产验收实测：`PUT /sa/api/meta/metrics/:id` 传空 event 会被接受，
 * 而事件为空的事件指标在告警侧被判「不可告警」、分析里也查不出数据——属于静默坏资产。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { MetaSavedMetricService } from '../../src/modules/meta/meta-saved-metric.service';
import type { MetaSavedMetricRepository } from '../../src/modules/meta/meta-saved-metric.repository';

function service() {
  const repository = {
    findById: jest.fn(),
    findByName: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    list: jest.fn(),
  } as unknown as MetaSavedMetricRepository;
  const prisma = { opsActionLog: { create: jest.fn(async () => ({})) } };
  return {
    service: new MetaSavedMetricService(repository, prisma as never),
    repository: repository as any,
    prisma: prisma as any,
  };
}

describe('事件指标校验', () => {
  it('缺少计算方法 → 400', () => {
    const { service: svc } = service();
    expect(() => svc.normalizeDefinition('event', { metric: { event: 'Purchase' } })).toThrow(
      '事件指标缺少计算方法',
    );
  });

  it('缺少事件（空串/空白）→ 400', () => {
    const { service: svc } = service();
    expect(() => svc.normalizeDefinition('event', { metric: { analysis: 'sum', event: '', prop: 'amount' } })).toThrow(
      '事件指标缺少事件',
    );
    expect(() => svc.normalizeDefinition('event', { metric: { analysis: 'sum', event: '  ' } })).toThrow(
      '事件指标缺少事件',
    );
  });

  it('合法事件指标：事件去空白后入库，其余口径字段保留', () => {
    const { service: svc } = service();
    const normalized = svc.normalizeDefinition('event', {
      metric: {
        analysis: 'sum',
        event: ' Purchase ',
        prop: 'amount',
        alias: '订单金额',
        filters: { logic: 'and', items: [] },
      },
    }) as { metric: Record<string, unknown> };
    expect(normalized.metric.event).toBe('Purchase');
    expect(normalized.metric.alias).toBe('订单金额');
    expect(normalized.metric.filters).toEqual({ logic: 'and', items: [] });
  });

  it('公式型事件指标仍被拒绝', () => {
    const { service: svc } = service();
    expect(() => svc.normalizeDefinition('event', { metric: { kind: 'formula' } })).toThrow('事件指标不能是公式');
  });
});

describe('留存指标校验', () => {
  it('缺初始/回访事件 → 400', () => {
    const { service: svc } = service();
    expect(() => svc.normalizeDefinition('retention', { start_event: { event: 'A' } })).toThrow(
      '留存指标须包含初始和回访事件',
    );
  });

  it('周期越界 → 400', () => {
    const { service: svc } = service();
    expect(() =>
      svc.normalizeDefinition('retention', {
        start_event: { event: 'A' },
        retain_event: { event: 'B' },
        n: 0,
      }),
    ).toThrow('留存周期 n 须为 1~90 的整数');
  });

  it('合法留存指标：保留两侧事件自带的筛选条件', () => {
    const { service: svc } = service();
    const normalized = svc.normalizeDefinition('retention', {
      start_event: { event: 'A', filters: { logic: 'and', items: [{ scope: 'event', prop: 'x', op: '=', value: 1 }] } },
      retain_event: { event: 'B' },
      n: 7,
      measure: 'count',
      cohort: 'first_day',
      granularity: 'week',
    }) as Record<string, any>;
    expect(normalized.n).toBe(7);
    expect(normalized.measure).toBe('count');
    expect(normalized.granularity).toBe('week');
    expect(normalized.start_event.filters.items[0].prop).toBe('x');
  });
});
