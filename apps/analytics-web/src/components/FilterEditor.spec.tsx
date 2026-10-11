// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilterEditor, isFilterGroup } from './FilterEditor';
import type { FilterGroup } from '../types/dsl.types';

describe('isFilterGroup', () => {
  it('distinguishes a nested group from a leaf condition', () => {
    expect(isFilterGroup({ logic: 'or', items: [] })).toBe(true);
    expect(isFilterGroup({ scope: 'event', prop: 'a', op: '=' })).toBe(false);
  });
});

/** ➕ 收纳后：点按钮 → 菜单项（添加筛选条件/添加条件组） */
async function addViaMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('button', { name: '添加筛选' }));
  await user.click(await screen.findByRole('menuitem', { name: label }));
}

describe('FilterEditor', () => {
  it('hides 且/或 until there are two items', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <FilterEditor value={{ logic: 'and', items: [] }} onChange={onChange} />,
    );
    expect(screen.queryByRole('group', { name: '条件关系' })).toBeNull();

    await addViaMenu(user, '添加筛选条件');
    const afterOne = onChange.mock.calls[onChange.mock.calls.length - 1][0] as FilterGroup;
    expect(afterOne.items).toHaveLength(1);

    rerender(<FilterEditor value={afterOne} onChange={onChange} />);
    expect(screen.queryByRole('group', { name: '条件关系' })).toBeNull();

    await addViaMenu(user, '添加筛选条件');
    const afterTwo = onChange.mock.calls[onChange.mock.calls.length - 1][0] as FilterGroup;
    rerender(<FilterEditor value={afterTwo} onChange={onChange} />);
    expect(screen.getAllByRole('group', { name: '条件关系' }).length).toBeGreaterThan(0);
  });

  it('shows 用户分群 when ready cohorts are passed', () => {
    render(
      <FilterEditor
        value={{ logic: 'and', items: [{ scope: 'cohort', prop: 'cohort_abc123xx', op: 'in' }] }}
        onChange={vi.fn()}
        cohorts={[
          {
            cohort_id: 'cohort_abc123xx',
            project_name: 'demo',
            owner: 'u1',
            name: 'vip',
            display_name: '高价值',
            remark: null,
            kind: 'condition',
            definition_json: {},
            schedule: 'manual',
            status: 'ready',
            member_count: 10,
            batch_id: 'b1',
            last_computed_at: '2026-09-05T00:00:00.000Z',
            compute_error: null,
            created_at: '2026-09-05T00:00:00.000Z',
            updated_at: '2026-09-05T00:00:00.000Z',
          },
        ]}
      />,
    );
    expect(screen.getByText('高价值 (vip)')).toBeTruthy();
    expect(screen.getByText('属于')).toBeTruthy();
  });

  it('shows 用户标签 with equals / in / not_in', () => {
    render(
      <FilterEditor
        value={{ logic: 'and', items: [{ scope: 'tag', prop: 'tag_abc123xx', op: '=', value: '高活' }] }}
        onChange={vi.fn()}
        tags={[
          {
            tag_id: 'tag_abc123xx',
            project_name: 'demo',
            owner: 'u1',
            name: 'activity',
            display_name: '活跃分层',
            remark: null,
            kind: 'condition',
            definition_json: { rules: [{ value: '高活' }, { value: '低活' }] },
            schedule: 'manual',
            status: 'ready',
            member_count: 10,
            batch_id: 'b1',
            last_computed_at: '2026-09-05T00:00:00.000Z',
            compute_error: null,
            created_at: '2026-09-05T00:00:00.000Z',
            updated_at: '2026-09-05T00:00:00.000Z',
          },
        ]}
      />,
    );
    expect(screen.getByText('活跃分层 (activity)')).toBeTruthy();
    expect(screen.getByText('等于')).toBeTruthy();
  });

  it('adds a nested condition group', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FilterEditor value={{ logic: 'and', items: [] }} onChange={onChange} />);
    await addViaMenu(user, '添加条件组');
    const next = onChange.mock.calls[onChange.mock.calls.length - 1][0] as FilterGroup;
    expect(next.items).toHaveLength(1);
    expect(isFilterGroup(next.items[0])).toBe(true);
  });
});
