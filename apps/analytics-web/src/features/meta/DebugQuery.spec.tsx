// @vitest-environment jsdom
/**
 * Debug 实时查询页（phase: clklog-analytics-debug-query-v1）。
 *
 * 三个生产实测过的坑在这里兜住：
 * ① 时间列：`log_time` 是平台时区墙钟串，补 'Z' 会当 UTC 而偏 8 小时（AC-1）；
 * ② 计数：显示的是「命中总数」，不是本次返回行数（AC-2）；
 * ③ 留档状态：关闭 / 失败 / 截断都要如实提示，不静默（AC-5/8、F2）。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugQuery } from './DebugQuery';
import * as metaService from '../../services/meta.service';

vi.mock('../../services/meta.service', () => ({
  debugQuery: vi.fn(),
  debugRecordDetail: vi.fn(),
  debugRecords: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 10 })),
  debugRecordDelete: vi.fn(),
  debugArchiveSetting: vi.fn(async () => ({ enabled: true })),
  setDebugArchiveSetting: vi.fn(),
}));

const mockService = vi.mocked(metaService);

const ROW = {
  log_time: '2026-10-01 12:13:51.790',
  event: 'pet_name_change',
  distinct_id: '1_13543144',
  user_key: '1_13543144',
  properties: '{"pet_id":"101"}',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockService.debugRecords.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
  mockService.debugArchiveSetting.mockResolvedValue({ enabled: true });
});

async function submitQuery(values = { event: 'pet_name_change' }, pollIntervalMs?: number) {
  const user = userEvent.setup();
  render(<DebugQuery pollIntervalMs={pollIntervalMs} />);
  await user.type(screen.getByPlaceholderText('如 $AppStart'), values.event);
  await user.click(screen.getByRole('button', { name: /查询/ }));
}

describe('Debug 查询结果口径', () => {
  it('时间列按平台时区墙钟渲染（不偏 8 小时）', async () => {
    mockService.debugQuery.mockResolvedValue({
      items: [ROW],
      matched_total: 1,
      window: '24h',
      limit: 20,
      archived: true,
      record_id: 'rec-1',
    });

    await submitQuery();

    expect(await screen.findByText('2026/10/01 12:13:51')).toBeTruthy();
    // 旧实现的 +8 小时结果不许再出现
    expect(screen.queryByText('2026/10/01 20:13:51')).toBeNull();
  });

  it('显示命中总数与「已显示最近 N 条」两个口径', async () => {
    mockService.debugQuery.mockResolvedValue({
      items: [ROW],
      matched_total: 27492,
      window: '24h',
      limit: 20,
      archived: true,
      record_id: 'rec-1',
    });

    await submitQuery();

    expect(await screen.findByText('命中 27,492 条 · 已显示最近 1 条')).toBeTruthy();
  });

  it.each([
    ['成功留档', { archived: true, record_id: 'r' }, '本次结果已留档，可在下方「历史记录」中回看'],
    ['留档失败', { archived: false }, '本次结果未留档（保存失败，不影响查询结果）'],
    ['项目已关闭留档', { archived: false, archive_disabled: true }, '本项目已关闭留档，本次结果不会保存'],
    ['记录被截断', { archived: true, truncated: true }, '本次记录不完整（内容超限已截断）'],
  ])('%s 的状态如实提示', async (_label, extra, text) => {
    mockService.debugQuery.mockResolvedValue({
      items: [ROW],
      matched_total: 1,
      window: '24h',
      limit: 20,
      ...extra,
    });

    await submitQuery();

    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('三条件全空时不打接口，只提示必填', async () => {
    const user = userEvent.setup();
    render(<DebugQuery />);

    await user.click(screen.getByRole('button', { name: /查询/ }));

    expect(await screen.findByText('至少填写一个查询条件（distinct_id / user_key / 事件名）')).toBeTruthy();
    expect(mockService.debugQuery).not.toHaveBeenCalled();
  });

  it('窗口默认近 24 小时，请求带上所选窗口与条数', async () => {
    mockService.debugQuery.mockResolvedValue({
      items: [],
      matched_total: 0,
      window: '24h',
      limit: 20,
      archived: true,
    });

    await submitQuery();

    await waitFor(() =>
      expect(mockService.debugQuery).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'pet_name_change', window: '24h', limit: 20 }),
      ),
    );
  });
});

describe('Debug 重查询异步化（两段式）', () => {
  it('转后台：先提示，轮询到 done 后就地渲染结果', async () => {
    mockService.debugQuery.mockResolvedValue({ status: 'running', record_id: 'rec-job', window: '7d', limit: 20 });
    mockService.debugRecordDetail.mockResolvedValue({
      id: 'rec-job',
      created_at: '2026-10-08T04:20:00.000Z',
      created_by: 'u-1',
      created_by_name: '平台超管',
      window: '7d',
      cond_distinct_id: '1_13543144',
      cond_user_key: null,
      cond_event: null,
      cond_limit: 20,
      matched_total: 18489,
      row_count: 1,
      truncated: false,
      duration_ms: 9000,
      status: 'done',
      rows: [{ ...ROW, id: 'row-1', seq: 0, properties_truncated: false }],
    });

    await submitQuery({ event: 'pet_name_change' }, 20);

    expect(await screen.findByText(/已转后台执行/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('命中 18,489 条 · 已显示最近 1 条')).toBeTruthy());
    // 完成后转到「已留档」并渲染出快照行
    expect(await screen.findByText('本次结果已留档，可在下方「历史记录」中回看')).toBeTruthy();
    expect(screen.getByText('2026/10/01 12:13:51')).toBeTruthy();
  });

  it('后台失败：按错误码渲染（超时）', async () => {
    mockService.debugQuery.mockResolvedValue({ status: 'running', record_id: 'rec-job', window: '7d', limit: 20 });
    mockService.debugRecordDetail.mockResolvedValue({
      id: 'rec-job',
      created_at: '2026-10-08T04:20:00.000Z',
      created_by: 'u-1',
      created_by_name: '平台超管',
      window: '7d',
      cond_distinct_id: null,
      cond_user_key: null,
      cond_event: 'pet_name_change',
      cond_limit: 20,
      matched_total: 0,
      row_count: 0,
      truncated: false,
      duration_ms: null,
      status: 'failed',
      error_code: 'timeout',
      rows: [],
    });

    await submitQuery({ event: 'pet_name_change' }, 20);

    expect(await screen.findByText('后台查询超时（预算用尽），请缩小时间范围后再试')).toBeTruthy();
  });
});
