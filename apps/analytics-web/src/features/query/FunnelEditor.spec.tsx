// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FunnelEditor } from './FunnelEditor';

vi.mock('../../services/meta.service', () => ({
  getEvents: () => Promise.resolve({ items: [] }),
  getEventProperties: () => Promise.resolve([]),
  getUserProperties: () => Promise.resolve({ items: [] }),
  getVirtualProperties: () => Promise.resolve([]),
}));

vi.mock('../../stores/project.store', () => ({
  useProjectStore: (selector: (s: { currentProject: string }) => unknown) =>
    selector({ currentProject: 'demo' }),
}));

vi.mock('../../services/cohort.service', () => ({
  getCohorts: () => Promise.resolve({ items: [], total: 0 }),
}));

vi.mock('../../services/tag.service', () => ({
  getTags: () => Promise.resolve({ items: [], total: 0 }),
}));

vi.mock('../../services/subject.service', () => ({
  getSubjects: () =>
    Promise.resolve({
      items: [
        {
          subject_id: 'asub_userxxxx',
          name: 'user',
          display_name: '用户',
          kind: 'preset',
          is_preset: true,
        },
      ],
      total: 1,
    }),
}));

vi.mock('../../components/EventSelect', () => ({
  EventSelect: () => <div>event-select</div>,
}));

vi.mock('../../components/FilterEditor', () => ({
  FilterEditor: () => <div>filters</div>,
}));

// 只替换组件本体，保留 createGroupItem / groupAddMenuItems 等真实实现
vi.mock('../../components/GroupEditor', async () => {
  const actual = await vi.importActual<typeof import('../../components/GroupEditor')>(
    '../../components/GroupEditor',
  );
  return { ...actual, GroupEditor: () => <div>groups</div> };
});

vi.mock('../../components/TimeRangePicker', () => ({
  TimeRangePicker: () => <div>time</div>,
}));

describe('FunnelEditor', () => {
  it('step ➕ menu inserts steps before/after and can reorder', async () => {
    const user = userEvent.setup();
    render(<FunnelEditor onAnalyze={vi.fn()} />);

    // 每步一个 ➕（含插入/添加筛选入口），上下移动已改为长按标题拖动
    expect(screen.getAllByRole('button', { name: /添加第 \d 步内容/ })).toHaveLength(2);

    await user.click(screen.getAllByRole('button', { name: /添加第 \d 步内容/ })[0]);
    await user.click(await screen.findByRole('menuitem', { name: '在此后插入步骤' }));
    // 新插入的步骤默认别名「第 2 步」
    expect(screen.getAllByTitle('点击改名').map((el) => el.textContent)).toEqual([
      '第 1 步',
      '第 2 步',
      '第 2 步',
    ]);
  });
});
