// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSelect } from './EventSelect';
import { getEvents, getVirtualEvents } from '../services/meta.service';
import type { MetaEvent } from '../types/meta.types';

vi.mock('../services/meta.service', () => ({
  getEvents: vi.fn(),
  getVirtualEvents: vi.fn(),
}));

vi.mock('../stores/project.store', () => ({
  useProjectStore: (selector: (state: { currentProject: string }) => unknown) =>
    selector({ currentProject: 'clklogapp' }),
}));

const getEventsMock = vi.mocked(getEvents);
const getVirtualEventsMock = vi.mocked(getVirtualEvents);

function meta(eventKey: string, status: MetaEvent['status'] = 'visible'): MetaEvent {
  return {
    event_key: eventKey,
    status,
    event_type: 'report',
    availability_status: 'available',
    data_status: 'normal',
    connection_status: 'auto',
    is_deleted: false,
    project_name: 'clklogapp',
    created_at: '',
    updated_at: '',
  };
}

describe('EventSelect remote search', () => {
  beforeEach(() => {
    getEventsMock.mockReset();
    getVirtualEventsMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 0 });
    getEventsMock.mockResolvedValue({
      items: [meta('currency_goldens_consume_success')],
      total: 1,
      page: 1,
      pageSize: 100,
    });
  });

  it('loads the first page with exclude_hidden and pageSize 100, not the API default of 20', async () => {
    render(<EventSelect />);
    await waitFor(() => expect(getEventsMock).toHaveBeenCalled());
    expect(getEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pageSize: 100,
        exclude_hidden: true,
        keyword: undefined,
      }),
    );
  });

  it('searches the server by keyword instead of filtering only loaded options', async () => {
    const user = userEvent.setup();
    getEventsMock
      .mockResolvedValueOnce({
        items: [meta('currency_goldens_consume_success')],
        total: 1,
        page: 1,
        pageSize: 100,
      })
      .mockResolvedValue({
        items: [meta('complete_novice_guidance3_click', 'pending')],
        total: 1,
        page: 1,
        pageSize: 100,
      });

    render(<EventSelect />);
    await waitFor(() => expect(getEventsMock).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByRole('combobox'), 'complete_novice_guidance3_click');

    await waitFor(
      () =>
        expect(getEventsMock).toHaveBeenCalledWith(
          expect.objectContaining({
            keyword: 'complete_novice_guidance3_click',
            pageSize: 100,
            exclude_hidden: true,
          }),
        ),
      { timeout: 3000 },
    );
  });

  it('keeps visible virtual events on the first page with a 虚拟 label', async () => {
    const user = userEvent.setup();
    getVirtualEventsMock.mockResolvedValue({
      items: [
        {
          ve_id: 've_abc123xxxx',
          event_key: 've_abc123xxxx',
          display_name: '新手完成',
          status: 'visible',
          definition_json: { events: ['complete_novice_guidance3'] },
          project_name: 'clklogapp',
          created_at: '',
          updated_at: '',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 1,
    });

    render(<EventSelect />);
    await waitFor(() => expect(getVirtualEventsMock).toHaveBeenCalled());
    await user.click(screen.getByRole('combobox'));
    expect(await screen.findByText('新手完成（虚拟）')).toBeTruthy();
  });
});
