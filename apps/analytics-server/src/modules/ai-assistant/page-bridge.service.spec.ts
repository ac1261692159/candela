import { ConflictException } from '@nestjs/common';
import { AuthUser } from '../auth/auth.service';
import { AiContextSanitizerService } from './ai-context-sanitizer.service';
import { PageBridgeService } from './page-bridge.service';

const user: AuthUser = {
  id: 'user-a',
  username: 'analyst',
  display_name: 'Analyst',
  platform_role: 'none',
};

const identity = {
  user_id: user.id,
  project_name: 'project-a',
  tab_id: 'tab_1234567890123456',
};

describe('PageBridgeService', () => {
  let service: PageBridgeService;

  beforeEach(() => {
    service = new PageBridgeService(new AiContextSanitizerService());
    service.updateSnapshot(user, 'project-a', {
      tab_id: identity.tab_id,
      page: 'sql',
      revision: 3,
      state: {
        page: 'sql',
        analysis: { mode: 'sql', sql: 'SELECT count() FROM clklog_sa.sa_events' },
      },
    });
  });

  afterEach(() => service.onModuleDestroy());

  it('routes an edit proposal only to its bound tab and resolves after confirmation', async () => {
    const pending = service.propose(identity, 'sql_edit', {
      sql: 'SELECT event, count() FROM clklog_sa.sa_events GROUP BY event',
      expected_revision: 3,
      reason: '查看事件分布',
    });
    const polled = await service.events(user, 'project-a', identity.tab_id, 0);
    expect(polled.events).toHaveLength(1);
    service.decide(user, 'project-a', polled.events[0].proposal_id, {
      accepted: true,
      current_revision: 4,
      applied_revision: 4,
    });
    await expect(pending).resolves.toMatchObject({ status: 'applied' });
    const internals = service as unknown as {
      bridges: Map<string, { events: unknown[] }>;
    };
    expect([...internals.bridges.values()][0].events).toHaveLength(0);
  });

  it('requires execution SQL to equal the current controlled editor value', () => {
    expect(() =>
      service.propose(identity, 'sql_execute', {
        sql: 'SELECT 1',
        expected_revision: 3,
        reason: '执行',
      }),
    ).toThrow(ConflictException);
  });

  it('supersedes the pending proposal when a new one arrives on the same bridge', async () => {
    const first = service.propose(identity, 'sql_edit', {
      sql: 'SELECT 1',
      expected_revision: 3,
      reason: 'first',
    });
    const second = service.propose(identity, 'sql_edit', {
      sql: 'SELECT 2',
      expected_revision: 3,
      reason: 'second',
    });
    await expect(first).resolves.toMatchObject({ status: 'superseded' });
    const { events } = await service.events(user, 'project-a', identity.tab_id, 0);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('second');
    service.decide(user, 'project-a', events[0].proposal_id, {
      accepted: true,
      current_revision: 4,
      applied_revision: 4,
    });
    await expect(second).resolves.toMatchObject({ status: 'applied' });
  });

  it.each(['event', 'funnel', 'retention'] as const)('fills %s through an owned proposal and preserves its DSL', async (page) => {
    service.updateSnapshot(user, 'project-a', { tab_id: identity.tab_id, page, revision: 4, state: { analysis: { form: {} } } });
    const dsl = { time_range: { start: '2026-08-01', end: '2026-08-07' } };
    const pending = service.propose(identity, 'analysis_edit', { page, dsl, sql: '', expected_revision: 4, reason: 'fixture' });
    const { events } = await service.events(user, 'project-a', identity.tab_id, 0);
    expect(events[0]).toMatchObject({ page, dsl });
    service.decide(user, 'project-a', events[0].proposal_id, { accepted: true, current_revision: 5, applied_revision: 5 });
    await expect(pending).resolves.toMatchObject({ status: 'applied' });
  });

  it('retains a proposal across result updates but rejects real draft edits', async () => {
    const pending = service.propose(identity, 'sql_edit', { sql: 'SELECT 2', expected_revision: 3, reason: 'test' });
    const { events } = await service.events(user, 'project-a', identity.tab_id, 0);
    service.updateSnapshot(user, 'project-a', { tab_id: identity.tab_id, page: 'sql', revision: 3, state: { result: { rows: [1] } } });
    service.updateSnapshot(user, 'project-a', { tab_id: identity.tab_id, page: 'sql', revision: 5, state: { analysis: { sql: 'SELECT 9' } } });
    expect(() => service.decide(user, 'project-a', events[0].proposal_id, { accepted: true, current_revision: 4, applied_revision: 4 })).toThrow('revision_conflict');
    await expect(pending).resolves.toMatchObject({ status: 'revision_conflict' });
  });

  it('ends an unanswered proposal before the tool request deadline', async () => {
    jest.useFakeTimers();
    try {
      const pending = service.propose(identity, 'sql_edit', { sql: 'SELECT 2', expected_revision: 3, reason: 'test' });
      jest.advanceTimersByTime(295_000);
      await expect(pending).resolves.toMatchObject({ status: 'timeout' });
    } finally { jest.useRealTimers(); }
  });

  it('rejects stale page snapshots and reports the current revision', () => {
    try {
      service.updateSnapshot(user, 'project-a', {
        tab_id: identity.tab_id,
        page: 'sql',
        revision: 1,
        state: { page: 'sql', analysis: { sql: 'SELECT 1' } },
      });
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        message: '页面 revision 已过期',
        current_revision: 3,
      });
    }
  });

  it('rejects stale revisions before creating a proposal', () => {
    expect(() =>
      service.propose(identity, 'sql_edit', {
        sql: 'SELECT 1',
        expected_revision: 2,
        reason: '过期',
      }),
    ).toThrow('sql_revision_conflict');
  });

  it('does not let another user decide a proposal', async () => {
    const pending = service.propose(identity, 'sql_edit', {
      sql: 'SELECT 1',
      expected_revision: 3,
      reason: '测试所有权',
    });
    const polled = await service.events(user, 'project-a', identity.tab_id, 0);
    expect(() =>
      service.decide({ ...user, id: 'user-b' }, 'project-a', polled.events[0].proposal_id, {
        accepted: false,
        current_revision: 3,
      }),
    ).toThrow('页面提案不存在');
    service.onModuleDestroy();
    await expect(pending).resolves.toMatchObject({ status: 'page_unavailable' });
  });

  it('cancels outstanding SQL proposals when the bound tab navigates away', async () => {
    const pending = service.propose(identity, 'sql_edit', {
      sql: 'SELECT 1',
      expected_revision: 3,
      reason: '测试页面切换',
    });
    service.updateSnapshot(user, 'project-a', {
      tab_id: identity.tab_id,
      page: 'event',
      revision: 4,
      state: { page: 'event', analysis: {} },
    });
    await expect(pending).resolves.toMatchObject({ status: 'page_unavailable' });
  });

  it('sql_load_card 携带 card_id 并在确认后 applied', async () => {
    const pending = service.propose(identity, 'sql_load_card', {
      sql: 'SELECT 2',
      expected_revision: 3,
      reason: '切卡',
      card_id: 'card_abc',
      card_name: '场景 PV',
    });
    const polled = await service.events(user, 'project-a', identity.tab_id, 0);
    expect(polled.events[0]).toMatchObject({
      action: 'sql_load_card',
      card_id: 'card_abc',
      card_name: '场景 PV',
    });
    service.decide(user, 'project-a', polled.events[0].proposal_id, {
      accepted: true,
      current_revision: 4,
      applied_revision: 4,
    });
    await expect(pending).resolves.toMatchObject({ status: 'applied' });
  });

  it('proposes sql chart bindings only when the snapshot has result columns', async () => {
    expect(() =>
      service.propose(identity, 'sql_chart_edit', {
        sql: '',
        expected_revision: 3,
        reason: '出图',
        chart_config: { chart_type: 'line', bindings: { x: 'd', metrics: ['收入金额'] } },
      }),
    ).toThrow('sql_chart_requires_result');

    service.updateSnapshot(user, 'project-a', {
      tab_id: identity.tab_id,
      page: 'sql',
      revision: 3,
      state: {
        analysis: { result_columns: [{ name: 'd', type: 'Date' }, { name: '收入金额', type: 'Float64' }] },
      },
    });
    const pending = service.propose(identity, 'sql_chart_edit', {
      sql: '',
      expected_revision: 3,
      reason: '收入趋势',
      chart_config: { chart_type: 'line', bindings: { x: 'd', metrics: ['收入金额'] } },
    });
    const { events } = await service.events(user, 'project-a', identity.tab_id, 0);
    expect(events[0]).toMatchObject({
      action: 'sql_chart_edit',
      chart_config: { chart_type: 'line', bindings: { x: 'd', metrics: ['收入金额'] } },
    });
    service.decide(user, 'project-a', events[0].proposal_id, {
      accepted: true,
      current_revision: 4,
      applied_revision: 4,
    });
    await expect(pending).resolves.toMatchObject({ status: 'applied' });
  });

  /**
   * 图表配置提案按绑定页面分派域（phase: clklog-ai-event-chart-v1）。
   * 一个 action 服务两域：SQL 走 SQL 白名单，事件走事件白名单，其余页面明确拒绝。
   */
  describe('图表提案按页面分派域', () => {
    const connect = (page: 'event' | 'funnel' | 'retention' | 'sql', state: Record<string, unknown>) =>
      service.updateSnapshot(user, 'project-a', {
        tab_id: identity.tab_id,
        page,
        revision: 3,
        state: { page, ...state },
      });

    const eventState = {
      analysis: {
        result_columns: [
          { name: 'g_0', role: 'time' },
          { name: 'm_0', role: 'metric' },
          { name: 'm_1', role: 'metric' },
        ],
        chart_config: { mode: 'auto', chart_type: 'line', bindings: { x: 'g_0', metrics: ['m_0', 'm_1'] } },
      },
    };

    it('事件页接受事件域图型与分轴选项', async () => {
      connect('event', eventState);
      const pending = service.propose(identity, 'analysis_chart_edit', {
        sql: '',
        expected_revision: 3,
        reason: '量级差太大，拆右轴',
        chart_config: {
          chart_type: 'line',
          bindings: { x: 'g_0', metrics: ['m_0', 'm_1'] },
          options: { metric_axis: { m_1: 'right' } },
        },
      });
      const { events } = await service.events(user, 'project-a', identity.tab_id, 0);
      expect(events[0]).toMatchObject({ action: 'analysis_chart_edit' });
      // 图表事件也必须带 page：客户端按 page 分发，缺了会被监听器当成别页的事件丢掉。
      // 2026-09-23 线上：事件送达了但页面不渲染，只能等 5 分钟超时。
      expect(events[0].page).toBe('event');
      expect(events[0].chart_config).toMatchObject({
        chart_type: 'line',
        options: { metric_axis: { m_1: 'right' } },
      });
      service.decide(user, 'project-a', events[0].proposal_id, {
        accepted: true,
        current_revision: 4,
        applied_revision: 4,
      });
      await expect(pending).resolves.toMatchObject({ status: 'applied' });
    });

    it('事件页拒绝 SQL 独有图型与 category 键', () => {
      connect('event', eventState);
      expect(() =>
        service.propose(identity, 'analysis_chart_edit', {
          sql: '',
          expected_revision: 3,
          reason: '漏斗',
          chart_config: { chart_type: 'funnel', bindings: { metrics: ['m_0'] } },
        }),
      ).toThrow(/chart_type 无效/);
      expect(() =>
        service.propose(identity, 'analysis_chart_edit', {
          sql: '',
          expected_revision: 3,
          reason: '柱状',
          chart_config: { chart_type: 'bar', bindings: { category: 'g_0', metrics: ['m_0'] } },
        }),
      ).toThrow(/category/);
    });

    it('SQL 页仍走 SQL 域，且旧名 sql_chart_edit 与等价', async () => {
      connect('sql', {
        analysis: { result_columns: [{ name: 'd', type: 'Date' }, { name: '收入金额', type: 'Float64' }] },
      });
      // SQL 域有 funnel，没有 stack
      expect(() =>
        service.propose(identity, 'analysis_chart_edit', {
          sql: '',
          expected_revision: 3,
          reason: 'x',
          chart_config: { chart_type: 'stack', bindings: { x: 'd', metrics: ['收入金额'] } },
        }),
      ).toThrow(/chart_type 无效/);
      const legacy = service.propose(identity, 'sql_chart_edit', {
        sql: '',
        expected_revision: 3,
        reason: '旧名仍然可用',
        chart_config: { chart_type: 'line', bindings: { x: 'd', metrics: ['收入金额'] } },
      });
      const { events } = await service.events(user, 'project-a', identity.tab_id, 0);
      expect(events[0].action).toBe('sql_chart_edit');
      service.decide(user, 'project-a', events[0].proposal_id, {
        accepted: true,
        current_revision: 4,
        applied_revision: 4,
      });
      await expect(legacy).resolves.toMatchObject({ status: 'applied' });
    });

    it('漏斗 / 留存页明确拒绝图表提案，不静默忽略', () => {
      for (const page of ['funnel', 'retention'] as const) {
        connect(page, { analysis: { result_columns: [{ name: 'g_0' }] } });
        expect(() =>
          service.propose(identity, 'analysis_chart_edit', {
            sql: '',
            expected_revision: 3,
            reason: 'x',
            chart_config: { chart_type: 'line', bindings: { x: 'g_0', metrics: [] } },
          }),
        ).toThrow(/不支持 AI 调整图表配置/);
      }
    });

    it('过期 revision 的图表提案被拒', () => {
      connect('event', eventState);
      expect(() =>
        service.propose(identity, 'analysis_chart_edit', {
          sql: '',
          expected_revision: 2,
          reason: 'x',
          chart_config: { chart_type: 'line', bindings: { x: 'g_0', metrics: ['m_0'] } },
        }),
      ).toThrow(/revision/);
    });
  });
});

/**
 * 送达回执（2026-09-23）：没有它时「用户看到提案但没点」与「提案根本没送到页面」
 * 在工具侧都只是 timeout，线上连续三次超时无法定位。由 Harness 侧提出补此信号。
 */
describe('PageBridgeService 提案送达回执', () => {
  let service: PageBridgeService;
  const identity = { user_id: user.id, project_name: 'project-a', tab_id: 'tab_1234567890123456' };

  beforeEach(() => {
    service = new PageBridgeService(new AiContextSanitizerService());
    service.updateSnapshot(user, 'project-a', {
      tab_id: identity.tab_id,
      page: 'event',
      revision: 3,
      state: {
        page: 'event',
        analysis: { result_columns: [{ name: 'g_0', role: 'time' }, { name: 'm_0', role: 'metric' }] },
      },
    });
  });

  afterEach(() => service.onModuleDestroy());

  const propose = () =>
    service.propose(identity, 'analysis_chart_edit', {
      sql: '',
      expected_revision: 3,
      reason: '拆右轴',
      chart_config: { chart_type: 'line', bindings: { x: 'g_0', metrics: ['m_0'] } },
    });
  /** 不轮询就能拿到提案 id（轮询会顺带把 delivered 置真，第二条用例要避开） */
  const pendingId = () =>
    [...(service as unknown as { proposals: Map<string, unknown> }).proposals.keys()][0];

  it('页面取走过提案 → delivered=true', async () => {
    const pending = propose();
    const { events } = await service.events(user, 'project-a', identity.tab_id, 0);
    expect(events).toHaveLength(1);
    service.decide(user, 'project-a', events[0].proposal_id, {
      accepted: true, current_revision: 4, applied_revision: 4,
    });
    await expect(pending).resolves.toMatchObject({ status: 'applied', delivered: true });
  });

  it('页面从未取走 → delivered=false，与「取走了但没点」可区分', async () => {
    const pending = propose();
    service.decide(user, 'project-a', pendingId(), {
      accepted: false, current_revision: 3, reason: '用户忽略了',
    });
    await expect(pending).resolves.toMatchObject({ status: 'rejected', delivered: false });
  });

  it('非图表提案同样带 delivered（形状统一，不破坏既有调用方）', async () => {
    const pending = service.propose(identity, 'analysis_edit', {
      page: 'event', sql: '', expected_revision: 3, reason: 'x', dsl: { event: '$pageview' },
    });
    const { events } = await service.events(user, 'project-a', identity.tab_id, 0);
    service.decide(user, 'project-a', events[0].proposal_id, {
      accepted: true, current_revision: 4, applied_revision: 4,
    });
    await expect(pending).resolves.toMatchObject({ status: 'applied', delivered: true });
  });
});
