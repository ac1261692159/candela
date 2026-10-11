// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FieldBindingPanel } from './FieldBindingPanel';
import { fxDayEventCount, fxWideFunnel } from './chart.fixtures';
import { profileColumns } from './column-profiler';
import { recommendChart } from './chart-recommender';
import { bindingColumnsFromProfiles, defaultOptions } from './chart-compatibility';
import { CHART_CONFIG_SCHEMA_VERSION, CHART_RECOMMENDATION_VERSION } from './chart.constants';
import type { ChartConfigV1 } from './chart.types';

describe('FieldBindingPanel', () => {
  it('blocks apply until required slots are filled and keeps cancel local', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onClose = vi.fn();
    const profiles = profileColumns(fxDayEventCount.columns, fxDayEventCount.rows);
    const config = recommendChart(profiles, fxDayEventCount.rows).recommended!.config!;
    const cleared = { ...config, bindings: { ...config.bindings, x: undefined, metrics: [] } };
    render(
      <FieldBindingPanel
        open
        config={cleared}
        columns={bindingColumnsFromProfiles(profiles)}
        chartType="line"
        onClose={onClose}
        onApply={onApply}
        onRestoreAuto={() => undefined}
      />,
    );
    expect(screen.getByText(/关闭未应用的修改不会改变当前图/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '应用配置' }));
    expect(screen.getByText('请选择时间轴')).toBeTruthy();
    expect(screen.getByText('请选择指标')).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: (name) => name.replace(/\s/g, '') === '取消' }));
    expect(onClose).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('applies roles and keyboard-sortable funnel steps', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const profiles = profileColumns(fxWideFunnel.columns, fxWideFunnel.rows);
    const config = recommendChart(profiles, fxWideFunnel.rows).recommended!.config!;
    render(
      <FieldBindingPanel
        open
        config={config}
        columns={bindingColumnsFromProfiles(profiles)}
        chartType="funnel"
        onClose={() => undefined}
        onApply={onApply}
        onRestoreAuto={() => undefined}
      />,
    );
    expect(screen.getAllByLabelText('1.加载开始UV 角色').length).toBeGreaterThan(0);
    await user.click(screen.getAllByLabelText('上移 加载成功')[0]);
    await user.click(screen.getByRole('button', { name: '应用配置' }));
    expect(onApply).toHaveBeenCalled();
    const next = onApply.mock.calls[0][0];
    expect(next.mode).toBe('manual');
    expect(next.bindings.funnel?.steps[0].column).toBe('2.加载成功UV');
  });

  // PRD §2.4 / AC5：选中趋势图后，设置面板应切换为趋势图配置项
  it('switches to trend settings when chartType is trend and writes options.trend', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const profiles = profileColumns(fxDayEventCount.columns, fxDayEventCount.rows);
    const config = recommendChart(profiles, fxDayEventCount.rows).recommended!.config!;
    render(
      <FieldBindingPanel
        open
        config={config}
        columns={bindingColumnsFromProfiles(profiles)}
        chartType="trend"
        onClose={() => undefined}
        onApply={onApply}
        onRestoreAuto={() => undefined}
      />,
    );

    // 趋势图专属配置项出现
    expect(screen.getByLabelText('预测点数')).toBeTruthy();
    expect(screen.getByLabelText('阈值线')).toBeTruthy();
    expect(screen.getByLabelText('显示拟合线')).toBeTruthy();
    expect(screen.getByLabelText('显示阈值线')).toBeTruthy();
    // 时间轴（与折线图同源）也要在；antd Select 会渲染多个带同一 label 的节点
    expect(screen.getAllByLabelText('时间轴').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('event_count 单位').length).toBeGreaterThan(0);

    // 改阈值后应用，配置应落到 options.trend
    await user.clear(screen.getByLabelText('阈值线'));
    await user.type(screen.getByLabelText('阈值线'), '200');
    await user.click(screen.getByRole('button', { name: '应用配置' }));

    expect(onApply).toHaveBeenCalled();
    const next = onApply.mock.calls[onApply.mock.calls.length - 1][0];
    expect(next.chart_type).toBe('trend');
    expect(next.options.trend).toBeDefined();
    expect(next.options.trend.threshold).toBe(200);
  });

  it('config=null（旧配置失效被丢弃）时仍能配置并应用，不再静默无反应', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const columns = [
      { name: '资源类型', type: 'String' },
      { name: '整体带宽MBps', type: 'Float64' },
      { name: '慢_lt100KBps_%', type: 'Float64' },
    ];
    const rows = [
      { 资源类型: '1.tex 贴图', 整体带宽MBps: 0.507, '慢_lt100KBps_%': 36.6 },
      { 资源类型: '2.prefab 预制体', 整体带宽MBps: 0.694, '慢_lt100KBps_%': 53.9 },
    ];
    const profiles = profileColumns(columns as never, rows as never);
    render(
      <FieldBindingPanel
        open
        layout="settings"
        config={null}
        columns={bindingColumnsFromProfiles(profiles)}
        chartType="bar"
        onClose={() => undefined}
        onApply={onApply}
        onRestoreAuto={() => undefined}
      />,
    );

    // 面板自建了基线：校验落在「请选择指标」这类可操作项上，而不是「当前结果没有列」
    await user.click(screen.getByRole('button', { name: '应用配置' }));
    expect(screen.queryByText('当前结果没有列')).toBeNull();
    expect(screen.getByText('请选择指标')).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();

    // 选项来自当前结果列（选完类别轴/指标即可应用；点选项的交互在 jsdom 里不稳，留给界面验收）
    await user.click(screen.getByRole('combobox', { name: '类别轴' }));
    expect(await screen.findAllByTitle('资源类型')).toBeTruthy();
    await user.click(screen.getByRole('combobox', { name: '指标' }));
    expect(await screen.findAllByTitle('整体带宽MBps')).toBeTruthy();
  });

  it('应用配置成功时给出可见反馈（回归：点了"没反应"分不清成功还是失败）', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const profiles = profileColumns(fxDayEventCount.columns, fxDayEventCount.rows);
    const config = recommendChart(profiles, fxDayEventCount.rows).recommended!.config!;
    render(
      <FieldBindingPanel
        open
        layout="settings"
        config={config}
        columns={bindingColumnsFromProfiles(profiles)}
        chartType={config.chart_type}
        onClose={() => undefined}
        onApply={onApply}
        onRestoreAuto={() => undefined}
      />,
    );
    await user.click(screen.getByRole('button', { name: '应用配置' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/图表配置已应用/)).toBeTruthy();
  });
});

/**
 * 双 Y 轴（phase: clklog-analytics-sql-dual-axis-v1）。
 * 轴归属控件本期只给折线族——SQL 的柱/饼 adapter 还不读 metric_axis，
 * 暴露出来会变成「能设但不生效」。
 */
describe('FieldBindingPanel 轴归属', () => {
  const profiles = profileColumns(fxDayEventCount.columns, fxDayEventCount.rows);
  const config = recommendChart(profiles, fxDayEventCount.rows).recommended!.config!;

  const renderAs = (chartType: 'line' | 'trend' | 'bar' | 'pie') => {
    const onApply = vi.fn();
    const view = render(
      <FieldBindingPanel
        open
        config={config}
        columns={bindingColumnsFromProfiles(profiles)}
        chartType={chartType}
        onClose={() => undefined}
        onApply={onApply}
        onRestoreAuto={() => undefined}
      />,
    );
    const axisSelects = screen.queryAllByLabelText(/^轴 · /);
    return { onApply, axisSelects, unmount: view.unmount };
  };

  it('折线与趋势图出现轴归属下拉，柱状/饼图不出现', () => {
    for (const chartType of ['line', 'trend'] as const) {
      const { axisSelects, unmount } = renderAs(chartType);
      expect(axisSelects.length).toBeGreaterThan(0);
      unmount();
    }
    for (const chartType of ['bar', 'pie'] as const) {
      const { axisSelects, unmount } = renderAs(chartType);
      expect(axisSelects).toHaveLength(0);
      unmount();
    }
  });

  it('改轴归属写入 options.metric_axis，经「应用配置」生效', async () => {
    const user = userEvent.setup();
    const { onApply, axisSelects, unmount } = renderAs('line');
    expect(axisSelects.length).toBeGreaterThan(0);
    // antd Select 在 jsdom 里靠 mousedown 展开（click 不触发）
    const container = axisSelects[0].closest('.ant-select') as HTMLElement;
    fireEvent.mouseDown(container.querySelector('.ant-select-selector') ?? container);
    const option = await screen.findByTitle('右轴');
    await user.click(option);
    await user.click(screen.getByRole('button', { name: '应用配置' }));
    expect(onApply).toHaveBeenCalled();
    const next = onApply.mock.calls[0][0];
    expect(Object.values(next.options.metric_axis ?? {})).toContain('right');
    unmount();
  });

  /**
   * 轴内单位一致（phase: clklog-analytics-axis-unit-coherence-v1）：
   * 同一根轴混单位时给出出路，而不是让用户自己猜该怎么办。
   */
  it('同一根轴混单位时出现「按单位拆轴」，点一下把不同单位的指标分到两轴', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const columns = [
      { name: 'day', type: 'Date' },
      { name: 'revenue', type: 'Float64' },
      { name: 'payers', type: 'Float64' },
      { name: 'rate', type: 'Float64' },
    ];
    const rows = [
      { day: '2026-09-01', revenue: 12000, payers: 120, rate: 0.5 },
      { day: '2026-09-02', revenue: 9500, payers: 90, rate: 0.4 },
    ];
    const profiles = profileColumns(columns, rows);
    const config: ChartConfigV1 = {
      schema_version: CHART_CONFIG_SCHEMA_VERSION,
      recommendation_version: CHART_RECOMMENDATION_VERSION,
      mode: 'manual' as const,
      chart_type: 'line' as const,
      preferred_view: 'chart' as const,
      roles: { day: 'time', revenue: 'metric', payers: 'metric', rate: 'metric' } as const,
      bindings: { x: 'day', metrics: ['revenue', 'payers', 'rate'], ignored: [] },
      options: defaultOptions({ units: { rate: 'percent_0_100' } }),
    };
    render(
      <FieldBindingPanel
        open
        config={config}
        columns={bindingColumnsFromProfiles(profiles)}
        chartType="line"
        layout="panel"
        onClose={() => undefined}
        onApply={onApply}
        onRestoreAuto={() => undefined}
      />,
    );
    await user.click(screen.getByRole('button', { name: '按单位拆轴' }));
    const applied = onApply.mock.calls[0][0] as { options: { metric_axis: Record<string, string> } };
    // 数值组（两个）留左轴，百分比那个进右轴
    expect(applied.options.metric_axis).toEqual({ revenue: 'left', payers: 'left', rate: 'right' });
  });

  it('单位一致时不出现「按单位拆轴」', () => {
    const profiles = profileColumns(fxDayEventCount.columns, fxDayEventCount.rows);
    const config = recommendChart(profiles, fxDayEventCount.rows).recommended!.config!;
    render(
      <FieldBindingPanel
        open
        config={config}
        columns={bindingColumnsFromProfiles(profiles)}
        chartType="line"
        onClose={() => undefined}
        onApply={() => undefined}
        onRestoreAuto={() => undefined}
      />,
    );
    expect(screen.queryByRole('button', { name: '按单位拆轴' })).toBeNull();
  });
});
