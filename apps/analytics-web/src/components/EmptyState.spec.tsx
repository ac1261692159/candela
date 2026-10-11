// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from 'antd';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders dashboard default copy with illustration', () => {
    const { container } = render(<EmptyState variant="dashboard" />);
    expect(screen.getByText('还没有看板')).toBeTruthy();
    expect(screen.getByText('创建第一个看板，沉淀你的分析结论')).toBeTruthy();
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders analysis default copy', () => {
    render(<EmptyState variant="analysis" />);
    expect(screen.getByText('当前时间范围内暂无数据')).toBeTruthy();
    expect(screen.getByText('调整时间范围或检查埋点上报后重试')).toBeTruthy();
  });

  it('renders sql / meta / cohort / tag default copies', () => {
    const cases: Array<[Parameters<typeof EmptyState>[0]['variant'], string]> = [
      ['sql', '查询无结果'],
      ['meta', '尚未发现上报事件'],
      ['cohort', '还没有用户分群'],
      ['tag', '还没有用户标签'],
    ];
    for (const [variant, title] of cases) {
      const { unmount } = render(<EmptyState variant={variant} />);
      expect(screen.getByText(title)).toBeTruthy();
      unmount();
    }
  });

  it('hides the title row when title is null (illustration + hint only)', () => {
    const { container } = render(
      <EmptyState variant="analysis" title={null} description="在左侧配置查询条件后点击“查询”查看结果" />,
    );
    expect(container.querySelector('svg')).toBeTruthy();
    expect(screen.getByText('在左侧配置查询条件后点击“查询”查看结果')).toBeTruthy();
    expect(screen.queryByText('当前时间范围内暂无数据')).toBeNull();
  });

  it('allows overriding title and description', () => {
    render(<EmptyState variant="analysis" title="自定义标题" description="自定义说明" />);
    expect(screen.getByText('自定义标题')).toBeTruthy();
    expect(screen.getByText('自定义说明')).toBeTruthy();
  });

  it('renders action and fires its callback on click', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <EmptyState
        variant="dashboard"
        action={
          <Button type="primary" onClick={onAction}>
            新建看板
          </Button>
        }
      />,
    );
    await user.click(screen.getByRole('button', { name: '新建看板' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
