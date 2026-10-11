// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { UserTagsPage } from './UserTagsPage';

vi.mock('../../services/tag.service', () => ({
  getTags: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  deleteTag: vi.fn(),
  getTagMembers: vi.fn(),
  refreshTag: vi.fn(),
}));

describe('UserTagsPage', () => {
  it('shows the rule-tag list entry', async () => {
    render(
      <MemoryRouter>
        <UserTagsPage />
      </MemoryRouter>,
    );
    // 空态 CTA 的 aria-label 是「创建第一个标签」，不再匹配；此正则只命中顶部按钮
    expect(await screen.findByRole('button', { name: /创建标签/ })).toBeInTheDocument();
    expect(screen.getByText('用户标签')).toBeInTheDocument();
  });
});
