// @vitest-environment jsdom
/**
 * 指标详情抽屉（phase: clklog-analytics-metric-detail-v1，PRD M-1~M-8）。
 *
 * 断言用户可见行为：查看态给口径、能进编辑态、保存调用 PUT 且**载荷保留未暴露字段**、
 * 失败就地显示原因；指标名/类型在编辑态只读。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricDetailDrawer } from './MetricDetailDrawer';
import * as metaService from '../../services/meta.service';
import type { SavedMetric } from '../../types/meta.types';

vi.mock('../../services/meta.service', () => ({
  getEvents: vi.fn(),
  updateSavedMetric: vi.fn(),
  // v2：口径表单会加载属性/主体/预演数据，缺一个 mock 整块表单就渲染不出来
  getEventProperties: vi.fn(async () => []),
  getVirtualProperties: vi.fn(async () => []),
  getUserProperties: vi.fn(async () => ({ items: [] })),
  previewSavedMetric: vi.fn(),
  getEventAttributes: vi.fn(async () => ({ items: [] })),
  getDatatableLabels: vi.fn(async () => ({ bound: false, items: [] })),
}));

const mockService = vi.mocked(metaService);

const EVENT_METRIC: SavedMetric = {
  metric_id: 'metric_1',
  project_name: 'clklogapp',
  owner: 'admin',
  name: 'order_count',
  display_name: '订单量',
  remark: '下单口径',
  kind: 'event',
  definition_json: {
    metric: {
      kind: 'event',
      analysis: 'total_times',
      event: 'Purchase',
      alias: '订单量',
      filters: { logic: 'and', items: [{ scope: 'event', prop: 'pay_type', op: '=', value: 'alipay' }] },
    },
  },
  format: 'number',
  created_at: '2026-09-15T10:00:00.000Z',
  updated_at: '2026-09-15T11:00:00.000Z',
};

function setup(metric: SavedMetric | null = EVENT_METRIC) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  mockService.getEvents.mockResolvedValue({
    items: [
      { event_key: 'Purchase', display_name: '下单' },
      { event_key: 'SignUp', display_name: '注册' },
    ],
  } as never);
  mockService.updateSavedMetric.mockResolvedValue(EVENT_METRIC);
  render(<MetricDetailDrawer metric={metric} onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('指标详情 · 查看', () => {
  it('展示元信息与口径摘要', async () => {
    setup();

    expect(await screen.findByText('订单量')).toBeTruthy();
    expect(screen.getByText('order_count')).toBeTruthy();
    expect(screen.getByText('事件指标')).toBeTruthy();
    expect(screen.getByText('Purchase')).toBeTruthy();
    expect(screen.getByText('总次数')).toBeTruthy();
    expect(screen.getByText('下单口径')).toBeTruthy();
    // v2：查询时间与取值选择都是口径的一部分，未设置时明确写「跟随告警窗口 / 自动」
    expect(screen.getByText('跟随告警窗口')).toBeTruthy();
    expect(screen.getByText('自动（按计算方法）')).toBeTruthy();
    expect(screen.getByText(/指标自带查询时间与取值选择/)).toBeTruthy();
    expect(screen.getByText(/改口径会同时改变告警判定条件/)).toBeTruthy();
  });
});

describe('指标详情 · 编辑', () => {
  it('进入编辑态：指标名与类型只读，且能看到 v2 的九区口径', async () => {
    setup();

    // antd 会在两个汉字的按钮文案中插入空格（“编 辑”），故用正则匹配
    await userEvent.click(await screen.findByRole('button', { name: /编\s*辑/ }));

    expect(await screen.findByText('指标名（不可改）')).toBeTruthy();
    expect(screen.getByText('类型（不可改）')).toBeTruthy();
    // v2 新增区块（与事件分析同深度）
    expect(screen.getByText('取值选择')).toBeTruthy();
    expect(screen.getByText('查询时间')).toBeTruthy();
    expect(screen.getByText('条件组')).toBeTruthy();
    expect(screen.getByText('数值变换')).toBeTruthy();
    expect(screen.getByRole('button', { name: /试\s*算/ })).toBeTruthy();
    // 指标名作为只读文本出现，而不是可编辑输入框
    const nameInput = screen.queryByRole('textbox', { name: '指标名' });
    expect(nameInput).toBeNull();
  });

  it('改显示名后保存 → 载荷保留 filters/alias，且不凭空写入 v2 字段（AC-8）', async () => {
    const { onSaved } = setup();
    // antd 会在两个汉字的按钮文案中插入空格（“编 辑”），故用正则匹配
    await userEvent.click(await screen.findByRole('button', { name: /编\s*辑/ }));

    const displayName = screen.getByLabelText('显示名');
    await userEvent.clear(displayName);
    await userEvent.type(displayName, '订单量（新）');

    // 保存/取消沿用仓库抽屉惯例（Typography.Link），不是 Button
    await userEvent.click(screen.getAllByText(/保\s*存/)[0]);

    await waitFor(() => expect(mockService.updateSavedMetric).toHaveBeenCalledTimes(1));
    const [metricId, patch] = mockService.updateSavedMetric.mock.calls[0];
    expect(metricId).toBe('metric_1');
    expect(patch.display_name).toBe('订单量（新）');
    const metric = (patch.definition_json as { metric: Record<string, unknown> }).metric;
    expect(metric.event).toBe('Purchase');
    expect(metric.alias).toBe('订单量');
    const original = EVENT_METRIC.definition_json.metric as { filters: unknown };
    expect(metric.filters).toEqual(original.filters);
    // 没动过的可选项不写键（清空 = 删键，避免定义里残留 null/空对象）
    expect('transform' in metric).toBe(false);
    expect('value_pick' in metric).toBe(false);
    expect('time_range' in metric).toBe(false);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('保存失败（后端 400）就地显示原因', async () => {
    setup();
    mockService.updateSavedMetric.mockRejectedValue(new Error('事件指标缺少计算方法'));
    // antd 会在两个汉字的按钮文案中插入空格（“编 辑”），故用正则匹配
    await userEvent.click(await screen.findByRole('button', { name: /编\s*辑/ }));

    // 保存/取消沿用仓库抽屉惯例（Typography.Link），不是 Button
    await userEvent.click(screen.getAllByText(/保\s*存/)[0]);

    expect(await screen.findByText('事件指标缺少计算方法')).toBeTruthy();
  });
});
