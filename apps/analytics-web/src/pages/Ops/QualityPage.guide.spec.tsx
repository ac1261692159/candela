// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QualityGuide } from './QualityPage';

/**
 * 页面自解释说明区（phase: clklog-data-quality-ops-ia-v1，IA-AC5）。
 *
 * 背景：用户反馈「这个页面的作用没有说明」——术语与判读方法原来只在仓库文档里。
 */
describe('QualityGuide（数据质量页说明区）', () => {
  it('四段标题齐全，默认展开「作用」段', () => {
    render(<QualityGuide />);
    expect(screen.getByText('作用')).toBeTruthy();
    expect(screen.getByText('关键术语')).toBeTruthy();
    expect(screen.getByText('结果怎么读')).toBeTruthy();
    expect(screen.getByText('谁该做什么')).toBeTruthy();
    // 默认展开段的内容可见
    expect(screen.getByText(/旁路校验线/)).toBeTruthy();
    // 未展开段的内容不在文档里（折叠面板懒渲染）
    expect(screen.queryByText(/CRC 唯一性：/)).toBeNull();
  });

  it('展开「关键术语」后能看到可信区间与已清理的定义（可收起/展开）', async () => {
    render(<QualityGuide />);
    // antd Collapse：点击面板头切换展开状态
    screen.getByText('关键术语').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(await screen.findByText(/可信区间：/, {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText(/已清理区间：/)).toBeTruthy();
  });
});
