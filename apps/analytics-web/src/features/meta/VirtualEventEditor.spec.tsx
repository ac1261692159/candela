// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VirtualEventEditor } from './VirtualEventEditor';

vi.mock('../../services/meta.service', () => ({
  getEventProperties: vi.fn().mockResolvedValue([]),
}));

describe('VirtualEventEditor', () => {
  it('does not render delete when onDelete is omitted', () => {
    render(<VirtualEventEditor onCancel={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '删除虚拟事件' })).toBeNull();
  });

  it('renders delete in the detail editor when onDelete is provided', () => {
    render(
      <VirtualEventEditor
        value={{ ve_id: 've_1', display_name: '注册', status: 'visible', definition_json: { events: ['AppStart'] } }}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '删除虚拟事件' })).toBeTruthy();
  });
});
