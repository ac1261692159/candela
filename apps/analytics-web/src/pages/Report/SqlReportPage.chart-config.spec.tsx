// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal } from 'antd';
import { useAiContextStore } from '../../stores/ai-context.store';
import { PAGE_BRIDGE_EVENT } from '../../features/ai/usePageBridge';
import { decidePageBridgeProposal } from '../../services/ai.service';
import { SqlReportPage } from './SqlReportPage';
import { fxDayEventCount } from '../../features/visualization/chart.fixtures';

const executeSql = vi.fn();
const getCard = vi.fn();
const getSqlSchema = vi.fn();
const saveSqlReport = vi.fn();
const updateSqlReport = vi.fn();

vi.mock('../../services/report.service', () => ({
  executeSql: (...args: unknown[]) => executeSql(...args),
  getCard: (...args: unknown[]) => getCard(...args),
  getSqlSchema: (...args: unknown[]) => getSqlSchema(...args),
  saveSqlReport: (...args: unknown[]) => saveSqlReport(...args),
  updateSqlReport: (...args: unknown[]) => updateSqlReport(...args),
  deleteCard: vi.fn(),
}));

vi.mock('../../services/ai.service', () => ({
  decidePageBridgeProposal: vi.fn(),
}));

vi.mock('../../features/report/SqlReportEditor', () => ({
  SqlReportEditor: ({ value }: { value: string }) => <textarea aria-label="SQL 编辑器" readOnly value={value} />,
}));

vi.mock('../../features/report/DataDictionaryPanel', () => ({
  DataDictionaryPanel: () => <div>dict</div>,
}));

vi.mock('../../features/report/GroupByPanel', () => ({
  GroupByPanel: () => <div>builder</div>,
}));

vi.mock('../../features/visualization/ChartWorkbench', () => ({
  ChartWorkbench: ({ config }: { config: { chart_type?: string } | null }) => (
    <div>chart-workbench:{config?.chart_type ?? 'none'}</div>
  ),
}));

function sqlResult() {
  return {
    query_id: 'q-day',
    columns: fxDayEventCount.columns,
    rows: fxDayEventCount.rows,
    row_count: fxDayEventCount.rows.length,
    truncated: false,
    elapsed_ms: 5,
    read_rows: 3,
    read_bytes: 20,
  };
}

describe('SqlReportPage chart config', () => {
  afterEach(() => { Modal.destroyAll(); vi.restoreAllMocks(); });
  beforeEach(() => {
    executeSql.mockReset();
    getCard.mockReset();
    getSqlSchema.mockResolvedValue({ events: [], event_properties: [], user_properties: [], system_columns: [] });
    saveSqlReport.mockResolvedValue({ id: 'card_new', name: '日趋势' });
    updateSqlReport.mockResolvedValue({});
    executeSql.mockResolvedValue(sqlResult());
    vi.mocked(decidePageBridgeProposal).mockReset().mockResolvedValue({ ok: true });
  });

  it('defaults a new query into the recommended chart and saves the config', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SqlReportPage />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: /执行/ }));
    expect(await screen.findByText(/chart-workbench:line/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /保存为卡片/ }));
    await user.type(screen.getByPlaceholderText('卡片名称'), '日趋势');
    await user.click(screen.getByRole('button', { name: (name) => name.replace(/\s/g, '') === '保存' }));
    await waitFor(() => expect(saveSqlReport).toHaveBeenCalled());
    const payload = saveSqlReport.mock.calls[0][0];
    expect(payload.chart_config.chart_type).toBe('line');
    expect(payload.chart_config.schema_version).toBe(1);
  });

  it('keeps an opened legacy card on the table until the user opts in', async () => {
    const user = userEvent.setup();
    getCard.mockResolvedValue({
      card_id: 'card_old',
      name: '旧卡',
      type: 'sql',
      dsl: { sql_text: 'select 1', mode: 'sql' },
      chart_type: 'table',
    });
    render(
      <MemoryRouter initialEntries={['/report/sql?card=card_old']}>
        <SqlReportPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/当前卡片：/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /执行/ }));
    expect((await screen.findAllByText('event_count')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/chart-workbench/)).toBeNull();
  });

  it('marks the chart dirty after a local switch and overwrites the saved config', async () => {
    const user = userEvent.setup();
    const config = {
      schema_version: 1,
      recommendation_version: 1,
      chart_type: 'line',
      mode: 'auto',
      preferred_view: 'chart',
      roles: { day: 'time', event_count: 'metric' },
      bindings: { metrics: ['event_count'], x: 'day' },
      options: { orientation: 'vertical', donut: false },
    };
    getCard.mockResolvedValue({
      card_id: 'card_saved',
      name: '已存图',
      type: 'sql',
      dsl: { sql_text: 'select 1', mode: 'sql', chart_config: config },
      chart_type: 'line',
    });
    render(
      <MemoryRouter initialEntries={['/report/sql?card=card_saved']}>
        <SqlReportPage />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: /执行/ }));
    expect(await screen.findByText(/chart-workbench:line/)).toBeTruthy();
    expect(screen.queryByRole('radio', { name: '图表+表格' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '结果设置' }));
    expect(screen.getByRole('radio', { name: '图表+表格' })).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: '表格' }).closest('label') as HTMLElement);
    expect(await screen.findByText('图表未保存')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /覆盖保存/ }));
    await waitFor(() => expect(updateSqlReport).toHaveBeenCalled());
    expect(updateSqlReport.mock.calls[0][1].chart_config.preferred_view).toBe('table');
  });

  it('hydrates a saved SQL card from cache without executing', async () => {
    const config = {
      schema_version: 1,
      recommendation_version: 1,
      chart_type: 'line',
      mode: 'manual',
      preferred_view: 'chart',
      roles: { day: 'time', event_count: 'metric' },
      bindings: { metrics: ['event_count'], x: 'day', ignored: [] },
      options: { orientation: 'vertical', donut: false, include_other: false, units: {}, aggregation: {} },
    };
    getCard.mockResolvedValue({
      card_id: 'card_cached',
      name: '缓存图',
      type: 'sql',
      dsl: { sql_text: 'select 1', mode: 'sql', chart_config: config },
      chart_type: 'line',
      cache: {
        result: sqlResult(),
        error: null,
        row_count: fxDayEventCount.rows.length,
        refreshed_at: '2026-09-11T00:00:00.000Z',
        stale: false,
      },
    });
    render(
      <MemoryRouter initialEntries={['/report/sql?card=card_cached']}>
        <SqlReportPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/chart-workbench:line/)).toBeTruthy();
    expect(screen.getAllByText(/缓存结果/).length).toBeGreaterThan(0);
    expect(executeSql).not.toHaveBeenCalled();
  });

  it('offers 另存为卡片 when a card is already open', async () => {
    const user = userEvent.setup();
    getCard.mockResolvedValue({
      card_id: 'card_saved',
      name: '已存图',
      type: 'sql',
      dsl: { sql_text: 'select 1', mode: 'sql' },
      chart_type: 'table',
    });
    render(
      <MemoryRouter initialEntries={['/report/sql?card=card_saved']}>
        <SqlReportPage />
      </MemoryRouter>,
    );
    saveSqlReport.mockClear();
    await user.click(await screen.findByRole('button', { name: '另存为卡片' }));
    expect((screen.getByPlaceholderText('卡片名称') as HTMLInputElement).value).toBe('已存图 副本');
    await user.click(screen.getByRole('button', { name: (name) => name.replace(/\s/g, '') === '保存' }));
    await waitFor(() => expect(saveSqlReport).toHaveBeenCalled());
    const last = saveSqlReport.mock.calls[saveSqlReport.mock.calls.length - 1][0] as { name: string };
    expect(last.name).toBe('已存图 副本');
  });

  it('accepts an SQL edit after a result-only refresh', async () => {
    render(<MemoryRouter><SqlReportPage /></MemoryRouter>);
    const revision = useAiContextStore.getState().context!.revision!;
    await userEvent.click(screen.getByRole('button', { name: /执行/ }));
    await screen.findByText(/chart-workbench:line/);
    expect(useAiContextStore.getState().context!.revision).toBe(revision);
    act(() => window.dispatchEvent(new CustomEvent(PAGE_BRIDGE_EVENT, { detail: {
      action: 'sql_edit', proposal_id: 'p-refresh', expected_revision: revision, sql: 'SELECT 2', reason: '新查询',
    } })));
    await waitFor(() => expect((screen.getByLabelText('SQL 编辑器') as HTMLTextAreaElement).value).toBe('SELECT 2'));
    await waitFor(() => expect(decidePageBridgeProposal).toHaveBeenCalledWith('p-refresh', expect.objectContaining({ accepted: true })));
    expect(executeSql).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired execute proposal without running it', async () => {
    render(<MemoryRouter><SqlReportPage /></MemoryRouter>);
    const context = useAiContextStore.getState().context!;
    act(() => window.dispatchEvent(new CustomEvent(PAGE_BRIDGE_EVENT, { detail: {
      action: 'sql_execute', proposal_id: 'p-expired', expected_revision: context.revision,
      sql: context.analysis!.sql, expires_at: new Date(Date.now() - 1000).toISOString(),
    } })));
    await waitFor(() => expect(decidePageBridgeProposal).toHaveBeenCalledWith('p-expired', expect.objectContaining({ accepted: false })));
    expect(executeSql).not.toHaveBeenCalled();
  });
  it('keeps a successful SQL result when its acknowledgement fails', async () => {
    render(<MemoryRouter><SqlReportPage /></MemoryRouter>);
    const context = useAiContextStore.getState().context!;
    vi.mocked(decidePageBridgeProposal).mockRejectedValue(new Error('network lost'));
    act(() => window.dispatchEvent(new CustomEvent(PAGE_BRIDGE_EVENT, { detail: {
      action: 'sql_execute', proposal_id: 'p-ack', expected_revision: context.revision, sql: context.analysis!.sql,
    } })));
    await screen.findByText(/chart-workbench:line/);
    await screen.findByText(/查询已经完成，结果保留在本页/);
    expect(executeSql).toHaveBeenCalledTimes(1);
    expect(decidePageBridgeProposal).toHaveBeenCalledTimes(1);
    expect(useAiContextStore.getState().context!.analysis!.error).toBeNull();
  });

  /**
   * 回归（2026-09-24 线上验收）：服务端图表提案早已改发正式名 `analysis_chart_edit`，
   * 本页却只认旧名 `sql_chart_edit`，于是提案掉进执行分支被回「执行请求不是编辑器中的当前 SQL」。
   * 这条用例故意用**服务端真实产生的载荷形状**（analysis_chart_edit），
   * 不再用前端自己造得出来的旧名把红灯盖住。
   */
  it('applies an AI chart binding after a table-only result', async () => {
    executeSql.mockResolvedValue({
      query_id: 'q-rev',
      columns: [
        { name: 'd', type: 'Date' },
        { name: '付费人数', type: 'UInt64' },
        { name: '支付成功次数', type: 'UInt64' },
        { name: '收入金额', type: 'Float64' },
        { name: '客单价', type: 'Float64' },
        { name: '首充金额', type: 'Float64' },
        { name: '复充金额', type: 'Float64' },
      ],
      rows: [{
        d: '2026-09-01',
        付费人数: 2,
        支付成功次数: 3,
        收入金额: 10,
        客单价: 5,
        首充金额: 4,
        复充金额: 6,
      }],
      row_count: 1,
      truncated: false,
      elapsed_ms: 4,
      read_rows: 10,
      read_bytes: 20,
    });
    render(<MemoryRouter><SqlReportPage /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: /执行/ }));
    expect((await screen.findAllByText('付费人数')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/chart-workbench/)).toBeNull();
    const revision = useAiContextStore.getState().context!.revision!;
    act(() => window.dispatchEvent(new CustomEvent(PAGE_BRIDGE_EVENT, { detail: {
      action: 'analysis_chart_edit',
      page: 'sql',
      proposal_id: 'p-chart',
      expected_revision: revision,
      sql: '',
      reason: '收入趋势',
      chart_config: {
        chart_type: 'line',
        bindings: {
          x: 'd',
          metrics: ['收入金额', '付费人数', '客单价', '首充金额', '复充金额'],
          ignored: ['支付成功次数'],
        },
      },
    } })));
    expect(await screen.findByText(/chart-workbench:line/)).toBeTruthy();
    await waitFor(() => expect(decidePageBridgeProposal).toHaveBeenCalledWith(
      'p-chart',
      expect.objectContaining({ accepted: true }),
    ));
    expect(executeSql).toHaveBeenCalledTimes(1);
  });

  it('still accepts the legacy sql_chart_edit name', async () => {
    render(<MemoryRouter><SqlReportPage /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: /执行/ }));
    await screen.findByText(/chart-workbench:line/);
    const revision = useAiContextStore.getState().context!.revision!;
    act(() => window.dispatchEvent(new CustomEvent(PAGE_BRIDGE_EVENT, { detail: {
      action: 'sql_chart_edit',
      proposal_id: 'p-legacy',
      expected_revision: revision,
      sql: '',
      chart_config: { chart_type: 'bar', bindings: { category: 'day', metrics: ['event_count'] } },
    } })));
    expect(await screen.findByText(/chart-workbench:bar/)).toBeTruthy();
    await waitFor(() => expect(decidePageBridgeProposal).toHaveBeenCalledWith(
      'p-legacy',
      expect.objectContaining({ accepted: true }),
    ));
  });

  it('ignores an action this page does not own instead of running it as SQL', async () => {
    render(<MemoryRouter><SqlReportPage /></MemoryRouter>);
    const revision = useAiContextStore.getState().context!.revision!;
    executeSql.mockClear();
    act(() => window.dispatchEvent(new CustomEvent(PAGE_BRIDGE_EVENT, { detail: {
      action: 'analysis_edit', proposal_id: 'p-other', expected_revision: revision, sql: '',
    } })));
    act(() => window.dispatchEvent(new CustomEvent(PAGE_BRIDGE_EVENT, { detail: {
      action: 'some_future_action', proposal_id: 'p-future', expected_revision: revision, sql: '',
    } })));
    await waitFor(() => expect(decidePageBridgeProposal).not.toHaveBeenCalled());
    expect(executeSql).not.toHaveBeenCalled();
  });

  it('rejects chart binding when there is no result', async () => {
    render(<MemoryRouter><SqlReportPage /></MemoryRouter>);
    const revision = useAiContextStore.getState().context!.revision!;
    act(() => window.dispatchEvent(new CustomEvent(PAGE_BRIDGE_EVENT, { detail: {
      action: 'analysis_chart_edit',
      proposal_id: 'p-empty',
      expected_revision: revision,
      sql: '',
      chart_config: { chart_type: 'line', bindings: { x: 'd', metrics: ['收入金额'] } },
    } })));
    await waitFor(() => expect(decidePageBridgeProposal).toHaveBeenCalledWith(
      'p-empty',
      expect.objectContaining({ accepted: false }),
    ));
  });
});
