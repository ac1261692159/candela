// @vitest-environment jsdom
/**
 * 指标口径表单 + 新建指标（phase: clklog-analytics-metric-v2，PRD §4.1/§4.3 与 AC-1/AC-4/AC-7）。
 *
 * 断言的是用户可见行为：九个区块都在、试算把**当前表单值**发出去并把结果显示出来、
 * 新建时默认带「近 7 天」查询时间、保存载荷里带着口径字段。
 */
import { Form } from 'antd';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricDefinitionForm } from './MetricDefinitionForm';
import { CreateEventMetricModal } from './CreateEventMetricModal';
import * as metaService from '../../services/meta.service';

// 整页渲染用例（antd 表单/表格 + 数据装配）单文件就要 18–35 秒；套件变大后 20s 上限会在整轮
// 并行时被挤爆（表现为「单跑必过、整轮超时」）。这里放到 60s 作为**卡死检测**上限，不是预期耗时。
// 主体/分群/标签下拉都会各拉一次接口：不 mock 的话 jsdom 会真的发 XHR（测试里全是 AggregateError 噪声）
vi.mock('../../services/subject.service', () => ({
  getSubjects: vi.fn(async () => ({ items: [{ subject_id: 'subj_1', display_name: '用户', is_preset: true }] })),
}));
vi.mock('../../services/cohort.service', () => ({ getCohorts: vi.fn(async () => ({ items: [] })) }));
vi.mock('../../services/tag.service', () => ({ getTags: vi.fn(async () => ({ items: [] })) }));

vi.mock('../../services/meta.service', () => ({
  getEvents: vi.fn(async () => ({ items: [{ event_key: 'Purchase', display_name: '下单' }] })),
  getEventProperties: vi.fn(async () => [{ prop_key: 'pay_amount', display_name: '金额', data_type: 'number' }]),
  getVirtualProperties: vi.fn(async () => []),
  getUserProperties: vi.fn(async () => ({ items: [{ prop_key: 'city', display_name: '城市', data_type: 'string' }] })),
  previewSavedMetric: vi.fn(),
  createSavedMetric: vi.fn(),
}));

const mockService = vi.mocked(metaService);

function FormHost({ onReady }: { onReady?: (form: ReturnType<typeof Form.useForm>[0]) => void }) {
  const [form] = Form.useForm();
  onReady?.(form);
  return (
    <Form form={form} layout="vertical" initialValues={{ analysis: 'total_times', event: 'Purchase' }}>
      <MetricDefinitionForm form={form} />
    </Form>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('指标口径表单', () => {
  it('九区都在：分析主体 / 事件 / 计算方法 / 属性 / 数值变换 / 取值选择 / 查询时间 / 条件组 / 试算', async () => {
    render(<FormHost />);

    expect((await screen.findAllByText('分析主体')).length).toBeGreaterThan(0);
    expect(screen.getByText('事件')).toBeTruthy();
    expect(screen.getByText('计算方法')).toBeTruthy();
    expect(screen.getByText('属性')).toBeTruthy();
    expect(screen.getByText('数值变换')).toBeTruthy();
    expect(screen.getByText('保留小数位')).toBeTruthy();
    expect(screen.getByText('取值选择')).toBeTruthy();
    expect(screen.getByText('查询时间')).toBeTruthy();
    expect(screen.getByText('条件组')).toBeTruthy();
    expect(screen.getByRole('button', { name: /试\s*算/ })).toBeTruthy();
    // 未设置取值时给出「自动（按计算方法）」的说明，避免以为漏配
    expect(screen.getByText(/不选 = 自动（按计算方法推荐）/)).toBeTruthy();
  });

  it('试算：按当前表单值调用预演接口，并显示取值/窗口/序列（AC-7）', async () => {
    mockService.previewSavedMetric.mockResolvedValue({
      value: 42,
      value_fmt: '42',
      series: [
        { date: '2026-09-15', value: 20 },
        { date: '2026-09-16', value: 22 },
      ],
      pick: 'sum',
      pick_label: '累计',
      pick_note: '窗口内各日值相加；没有数据的日子按 0 计',
      pick_explicit: false,
      used_overall: true,
      window: { start: '2026-09-10', end: '2026-09-16', days: 7, label: '近 7 天（含今天）', source: 'metric' },
      elapsed_ms: 12,
    });

    render(<FormHost />);
    await userEvent.click(await screen.findByRole('button', { name: /试\s*算/ }));

    await waitFor(() => expect(mockService.previewSavedMetric).toHaveBeenCalledTimes(1));
    const [definition] = mockService.previewSavedMetric.mock.calls[0];
    expect((definition.metric as Record<string, unknown>).event).toBe('Purchase');
    expect(await screen.findByText(/当前值 42/)).toBeTruthy();
    expect(screen.getByText(/近 7 天（含今天）/)).toBeTruthy();
    expect(screen.getByText(/累计/)).toBeTruthy();
    expect(screen.getByText(/09-15 20/)).toBeTruthy();
  });

  it('试算失败就地给原因（不弹 toast 吞掉）', async () => {
    mockService.previewSavedMetric.mockRejectedValue(new Error('查询时间跨度不能超过 90 天'));

    render(<FormHost />);
    await userEvent.click(await screen.findByRole('button', { name: /试\s*算/ }));

    expect(await screen.findByText('试算失败')).toBeTruthy();
    expect(screen.getByText('查询时间跨度不能超过 90 天')).toBeTruthy();
  });
});

describe('新建事件指标', () => {
  it('默认带「近 7 天（含今天）」查询时间，保存载荷包含事件与查询时间（AC-1/AC-4）', async () => {
    mockService.createSavedMetric.mockResolvedValue({} as never);
    const onCreated = vi.fn();
    render(<CreateEventMetricModal open onClose={vi.fn()} onCreated={onCreated} />);

    await userEvent.type(await screen.findByLabelText('显示名'), '订单量');
    await userEvent.type(screen.getByLabelText('指标名'), 'order_count');
    // 事件是必填：从下拉里选一个（antd Select 需要先点开）
    await userEvent.click(screen.getByLabelText('事件'));
    await userEvent.click(await screen.findByText('Purchase（下单）'));
    await userEvent.click(screen.getByRole('button', { name: /保\s*存/ }));

    await waitFor(() => expect(mockService.createSavedMetric).toHaveBeenCalledTimes(1));
    const payload = mockService.createSavedMetric.mock.calls[0][0] as unknown as {
      name: string;
      display_name: string;
      definition_json: { metric: Record<string, unknown> };
    };
    expect(payload.name).toBe('order_count');
    expect(payload.display_name).toBe('订单量');
    expect(payload.definition_json.metric.event).toBe('Purchase');
    expect(payload.definition_json.metric.time_range).toEqual({
      start: '',
      end: '',
      relative: { kind: 'recent_n', n: 7 },
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  }, 60_000);

  it('指标名格式不符时不提交（资产唯一键约束）', async () => {
    render(<CreateEventMetricModal open onClose={vi.fn()} onCreated={vi.fn()} />);

    await userEvent.type(await screen.findByLabelText('显示名'), '订单量');
    await userEvent.type(screen.getByLabelText('指标名'), 'Order-Count');
    await userEvent.click(screen.getByLabelText('事件'));
    await userEvent.click(await screen.findByText('Purchase（下单）'));
    await userEvent.click(screen.getByRole('button', { name: /保\s*存/ }));

    expect(await screen.findByText(/小写字母开头/)).toBeTruthy();
    expect(mockService.createSavedMetric).not.toHaveBeenCalled();
  }, 60_000);
});
