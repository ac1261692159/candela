// @vitest-environment jsdom
/**
 * Debug 留档历史（phase: clklog-analytics-debug-query-v1 的 F1/F2）。
 *
 * 守：列表口径与查询页一致；删除走二次确认并刷新；项目级开关只对有权者显示。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugHistory } from './DebugHistory';
import * as metaService from '../../services/meta.service';

let canToggleArchive = true;
vi.mock('../../stores/iam.store', () => ({
  useIamStore: (selector: (state: { has: (code: string) => boolean }) => unknown) =>
    selector({ has: () => canToggleArchive }),
}));

vi.mock('../../services/meta.service', () => ({
  debugRecords: vi.fn(),
  debugRecordDetail: vi.fn(),
  debugRecordDelete: vi.fn(),
  debugArchiveSetting: vi.fn(),
  setDebugArchiveSetting: vi.fn(),
}));

const mockService = vi.mocked(metaService);

const RECORD = {
  id: 'rec-1',
  created_at: '2026-10-08T02:00:00.000Z',
  created_by: 'u-1',
  created_by_name: '分析员',
  window: '24h' as const,
  cond_distinct_id: null,
  cond_user_key: null,
  cond_event: 'fish_open',
  cond_limit: 20,
  matched_total: 27492,
  row_count: 20,
  truncated: false,
  duration_ms: 1200,
};

beforeEach(() => {
  vi.clearAllMocks();
  canToggleArchive = true;
  mockService.debugRecords.mockResolvedValue({ items: [RECORD], total: 1, page: 1, pageSize: 10 });
  mockService.debugArchiveSetting.mockResolvedValue({ enabled: true });
});

describe('Debug 留档历史', () => {
  it('列出条件摘要、命中数与操作人', async () => {
    render(<DebugHistory />);

    expect(await screen.findByText('事件名=fish_open · 近 24 小时')).toBeTruthy();
    expect(screen.getByText('命中 27492 条')).toBeTruthy();
    expect(screen.getByText('分析员')).toBeTruthy();
  });

  it('无记录时给出空态', async () => {
    mockService.debugRecords.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });

    render(<DebugHistory />);

    expect(await screen.findByText('暂无留档记录')).toBeTruthy();
  });

  it('删除需二次确认，确认后调接口并刷新列表', async () => {
    const user = userEvent.setup();
    mockService.debugRecordDelete.mockResolvedValue({ deleted: true, record_id: 'rec-1' });
    render(<DebugHistory />);

    await user.click(await screen.findByRole('button', { name: '删除' }));
    // 二次确认弹层里的确认按钮
    await user.click(await screen.findByRole('button', { name: '删 除' }));

    await waitFor(() => expect(mockService.debugRecordDelete).toHaveBeenCalledWith('rec-1'));
    await waitFor(() => expect(mockService.debugRecords).toHaveBeenCalledTimes(2));
  });

  it('有权限时显示留档开关，切换会写回项目设置', async () => {
    const user = userEvent.setup();
    mockService.setDebugArchiveSetting.mockResolvedValue({ enabled: false });
    render(<DebugHistory />);

    const toggle = await screen.findByRole('switch');
    await user.click(toggle);

    await waitFor(() => expect(mockService.setDebugArchiveSetting).toHaveBeenCalledWith(false));
  });

  it('无权限时不显示开关', async () => {
    canToggleArchive = false;
    render(<DebugHistory />);

    await screen.findByText('历史记录');
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('项目关闭留档时给出明示', async () => {
    mockService.debugArchiveSetting.mockResolvedValue({ enabled: false });

    render(<DebugHistory />);

    expect(await screen.findByText('本项目已关闭留档，本次结果不会保存')).toBeTruthy();
  });
});

describe('Debug 留档状态列（异步两段式）', () => {
  it('运行中的记录显示「运行中」，命中列不显示数字', async () => {
    mockService.debugRecords.mockResolvedValue({
      items: [{ ...RECORD, status: 'running', matched_total: 0, row_count: 0 }],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    render(<DebugHistory />);

    expect(await screen.findByText('运行中')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('命中 27492 条')).toBeNull();
  });

  it('失败的记录显示「失败」并可看到原因', async () => {
    mockService.debugRecords.mockResolvedValue({
      items: [{ ...RECORD, status: 'failed', error_code: 'timeout', matched_total: 0, row_count: 0 }],
      total: 1,
      page: 1,
      pageSize: 10,
    });

    render(<DebugHistory />);

    const tag = await screen.findByText('失败');
    expect(tag.getAttribute('title')).toContain('超时');
  });

  it('完成的记录显示「完成」', async () => {
    render(<DebugHistory />); // 默认 RECORD 无 status → 视为 done

    expect(await screen.findByText('完成')).toBeTruthy();
  });

  it('有未完成任务时按注入间隔轮询列表，全部完成后停止', async () => {
    mockService.debugRecords
      .mockResolvedValueOnce({
        items: [{ ...RECORD, status: 'running', matched_total: 0, row_count: 0 }],
        total: 1,
        page: 1,
        pageSize: 10,
      })
      .mockResolvedValue({ items: [RECORD], total: 1, page: 1, pageSize: 10 });

    render(<DebugHistory activePollMs={20} />);

    await waitFor(() => expect(mockService.debugRecords).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('完成')).toBeTruthy();
    // 全部完成后不再轮询
    const callsAfterDone = mockService.debugRecords.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(mockService.debugRecords.mock.calls.length).toBe(callsAfterDone);
  });
});
