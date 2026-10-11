// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { AxiosError, AxiosHeaders } from 'axios';
import { currentRevisionFromError, usePageBridge } from './usePageBridge';
import { useAiContextStore } from '../../stores/ai-context.store';
import { useProjectStore } from '../../stores/project.store';
import { disconnectPageBridge, publishPageBridgeSnapshot } from '../../services/ai.service';
vi.mock('../../services/ai.service', () => ({
  getAiTabId: () => 'fixture_tab_123456',
  publishPageBridgeSnapshot: vi.fn().mockResolvedValue({ ok: true }),
  pollPageBridgeEvents: vi.fn(() => new Promise(() => {})),
  disconnectPageBridge: vi.fn().mockResolvedValue({ ok: true }),
}));

describe('page bridge revision helpers', () => {
  it('publishes the content revision and disconnects when the bound page leaves', async () => {
    const store = useAiContextStore.getState();
    store.publishContext({ page: 'sql', route: '/report/sql', analysis: { sql: 'SELECT 1' } }, useProjectStore.getState().currentProject);
    const revision = useAiContextStore.getState().context!.revision;
    const hook = renderHook(() => usePageBridge());
    await waitFor(() => expect(publishPageBridgeSnapshot).toHaveBeenCalledWith('fixture_tab_123456', expect.any(Object), revision, expect.any(AbortSignal)));
    act(() => store.clearContext());
    await waitFor(() => expect(disconnectPageBridge).toHaveBeenCalledWith('fixture_tab_123456', revision));
    hook.unmount();
  });

  it('reads current_revision from a silent 409 payload', () => {
    const error = new AxiosError('conflict');
    error.response = {
      data: { code: 409, message: '页面 revision 已过期', data: { current_revision: 12 } },
      status: 409,
      statusText: 'Conflict',
      headers: {},
      config: { headers: new AxiosHeaders() },
    };
    expect(currentRevisionFromError(error)).toBe(12);
    expect(currentRevisionFromError(new Error('nope'))).toBeNull();
  });
});
