// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryStep } from './QueryStep';

describe('QueryStep', () => {
  it('hides the body when the funnel step is folded', async () => {
    const user = userEvent.setup();
    render(
      <QueryStep index={1} title="第 1 步" collapsible>
        <span>选择事件</span>
      </QueryStep>,
    );

    expect(screen.getByText('选择事件')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '折叠步骤' }));
    expect(screen.queryByText('选择事件')).toBeNull();
    expect(screen.getByRole('button', { name: '展开步骤' })).toBeTruthy();
  });

  it('shows the alias input only after the title is clicked', async () => {
    const user = userEvent.setup();
    const onTitleChange = vi.fn();
    render(
      <QueryStep title="第 1 步" titleEditable onTitleChange={onTitleChange}>
        <span>选择事件</span>
      </QueryStep>,
    );

    expect(screen.queryByRole('textbox', { name: '步骤别名' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '第 1 步' }));
    const input = screen.getByRole('textbox', { name: '步骤别名' });
    await user.clear(input);
    await user.type(input, '访问首页');
    await user.tab();
    expect(onTitleChange).toHaveBeenCalledWith('访问首页');
  });
});
