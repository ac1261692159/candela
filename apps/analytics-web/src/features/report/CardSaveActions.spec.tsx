// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CardSaveActions } from './CardSaveActions';

describe('CardSaveActions', () => {
  it('shows only 保存为卡片 when unbound', () => {
    render(<CardSaveActions bound={false} onSaveAs={vi.fn()} />);
    expect(screen.getByRole('button', { name: '保存为卡片' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '覆盖保存' })).toBeNull();
    expect(screen.queryByRole('button', { name: '另存为卡片' })).toBeNull();
  });

  it('shows overwrite and save-as when bound to a card', () => {
    render(<CardSaveActions bound onOverwrite={vi.fn()} onSaveAs={vi.fn()} />);
    expect(screen.getByRole('button', { name: '覆盖保存' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '另存为卡片' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '保存为卡片' })).toBeNull();
  });
});
