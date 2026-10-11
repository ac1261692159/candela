// @vitest-environment jsdom
/**
 * 指标列表与详情操作（phase: clklog-analytics-metric-v3，PRD §3.3 / AC-6 / AC-7）。
 *
 * 用户反馈：列表右侧「查看 / 编辑 / 删除」三连按钮把表格挤到横向滚动，删除还紧贴查看容易误点。
 * 现在的约定是：列表只有显示名（可点开详情），编辑与删除（二次确认）都收进详情抽屉。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SavedMetricsPage } from './SavedMetricsPage';
import * as metaService from '../../services/meta.service';

// 整页渲染用例（antd 表单/表格 + 数据装配）单文件就要 18–35 秒；套件变大后 20s 上限会在整轮
// 并行时被挤爆（表现为「单跑必过、整轮超时」）。这里放到 60s 作为**卡死检测**上限，不是预期耗时。
vi.mock('../../services/subject.service', () => ({
  getSubjects: vi.fn(async () => ({ items: [{ subject_id: 'subj_1', display_name: '用户', is_preset: true }] })),
}));
vi.mock('../../services/cohort.service', () => ({ getCohorts: vi.fn(async () => ({ items: [] })) }));
vi.mock('../../services/tag.service', () => ({ getTags: vi.fn(async () => ({ items: [] })) }));
vi.mock('../../services/report.service', () => ({
  createCard: vi.fn(async () => ({ card_id: 'card_1', name: '订单量（指标卡）' })),
}));

vi.mock('../../services/meta.service', () => ({
  getSavedMetrics: vi.fn(),
  getEvents: vi.fn(async () => ({ items: [] })),
  getEventProperties: vi.fn(async () => []),
  getVirtualProperties: vi.fn(async () => []),
  getUserProperties: vi.fn(async () => ({ items: [] })),
  getEventAttributes: vi.fn(async () => ({ items: [] })),
  deleteSavedMetric: vi.fn(),
  updateSavedMetric: vi.fn(),
  createSavedMetric: vi.fn(),
  previewSavedMetric: vi.fn(),
}));

const mockService = vi.mocked(metaService);

const METRIC = {
  metric_id: 'metric_1',
  project_name: 'clklogapp',
  owner: 'admin',
  name: 'http_report_count',
  display_name: '今日 HTTP 上报事件数',
  remark: '自检用',
  kind: 'event' as const,
  definition_json: {
    metric: { kind: 'event', event: 'base_performance_httprequest_report', analysis: 'total_times' },
  },
  format: 'number' as const,
  created_at: '2026-09-16T10:00:00.000Z',
  updated_at: '2026-09-16T11:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockService.getSavedMetrics.mockResolvedValue({ items: [METRIC] } as never);
  mockService.deleteSavedMetric.mockResolvedValue({ success: true } as never);
});

describe('指标列表', () => {
  it('没有「操作」列：查看走显示名，编辑/删除在详情抽屉里（AC-6）', async () => {
    render(<SavedMetricsPage />);

    expect(await screen.findByText('今日 HTTP 上报事件数')).toBeTruthy();
    // 表头不再有「操作」列
    expect(screen.queryByRole('columnheader', { name: '操作' })).toBeNull();
    // 行内也没有三连按钮
    expect(screen.queryByRole('button', { name: /查看 今日/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /删除 今日/ })).toBeNull();
    // 第二行摘要显示查询时间 · 取值
    expect(screen.getByText('跟随告警窗口 · 自动取值')).toBeTruthy();
  });

  it('点显示名打开详情抽屉，抽屉里有编辑与删除（AC-7）', async () => {
    render(<SavedMetricsPage />);

    await userEvent.click(await screen.findByText('今日 HTTP 上报事件数'));

    expect(await screen.findByRole('button', { name: /编\s*辑/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /删\s*除/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /创建看板卡片/ })).toBeTruthy();
  });

  it('删除要二次确认，确认后调用删除接口并刷新列表', async () => {
    render(<SavedMetricsPage />);
    await userEvent.click(await screen.findByText('今日 HTTP 上报事件数'));
    await userEvent.click(await screen.findByRole('button', { name: /删\s*除/ }));

    // 确认弹窗：抽屉本身也是 role=dialog，按 antd 的 Modal.confirm 容器定位
    await waitFor(() => expect(document.querySelector('.ant-modal-confirm')).toBeTruthy());
    const confirmBox = document.querySelector('.ant-modal-confirm') as HTMLElement;
    expect(confirmBox.textContent).toContain('删除指标「今日 HTTP 上报事件数」？');
    await userEvent.click(within(confirmBox).getByRole('button', { name: /删\s*除/ }));

    await waitFor(() => expect(mockService.deleteSavedMetric).toHaveBeenCalledWith('metric_1'));
    await waitFor(() => expect(mockService.getSavedMetrics).toHaveBeenCalledTimes(2));
  }, 60_000);
});
