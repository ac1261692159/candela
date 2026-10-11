// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxiosError } from 'axios';
import { useHarnessConnection } from './useHarnessConnection';
import { post } from '../../services/api';

vi.mock('../../services/api', () => ({ post: vi.fn() }));
const runtimeId = `air_${'a'.repeat(24)}`;
const prefix = `/sa/harness/${runtimeId}/1780000000000.${'x'.repeat(43)}/`;
afterEach(() => { vi.clearAllMocks(); document.body.innerHTML = ''; });
function setup() {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const frame = { current: iframe };
  const result = renderHook(() => useHarnessConnection(frame, '/bootstrap', 'tab_fixture'));
  const send = (source = iframe.contentWindow, type = 'clklog:harness-ready') => act(() => {
    window.dispatchEvent(new MessageEvent('message', { source, data: { type, runtime_id: runtimeId } }));
  });
  return { ...result, frame, send };
}
describe('Harness renewal lifecycle', () => {
  it('ignores forged messages, renews in place and rechecks after waking', async () => {
    vi.mocked(post).mockResolvedValue({ prefix });
    const hook = setup();
    const original = hook.frame.current;
    hook.send(window);
    expect(post).not.toHaveBeenCalled();
    hook.send();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(hook.frame.current).toBe(original);
    hook.unmount();
    window.dispatchEvent(new Event('focus'));
    expect(post).toHaveBeenCalledTimes(2);
  });
  it('does not retry an invalid login forever', async () => {
    const error = new AxiosError('unauthorized');
    error.response = { status: 401 } as never;
    vi.mocked(post).mockRejectedValue(error);
    const hook = setup(); hook.send();
    await waitFor(() => expect(hook.result.current).toContain('重新登录'));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(post).toHaveBeenCalledTimes(1);
    hook.unmount();
  });
  it('collapses concurrent checks and never repeats the failed business operation', async () => {
    let done!: (value: unknown) => void;
    vi.mocked(post).mockImplementation(() => new Promise((resolve) => { done = resolve; }));
    const hook = setup(); hook.send();
    hook.send(hook.frame.current.contentWindow, 'clklog:harness-unauthorized');
    window.dispatchEvent(new Event('focus'));
    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => done({ prefix }));
    await waitFor(() => expect(hook.result.current).toContain('未自动重试'));
    expect(vi.mocked(post).mock.calls[0][0]).toBe('/assistant/connection/renew');
    hook.unmount();
  });
  it.each([[403, '权限已失效'], [404, '已回收']] as const)('stops renewal for HTTP %s and shows recovery', async (status, notice) => {
    const error = new AxiosError('unavailable');
    error.response = { status } as never;
    vi.mocked(post).mockRejectedValue(error);
    const hook = setup(); hook.send();
    await waitFor(() => expect(hook.result.current).toContain(notice));
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(post).toHaveBeenCalledTimes(1);
    hook.unmount();
  });
});

describe('官方弹层通知', () => {
  it('把弹层开合转给回调，伪造来源与非布尔载荷都被忽略', async () => {
    const onDialogChange = vi.fn();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const frame = { current: iframe };
    renderHook(() => useHarnessConnection(frame, '/bootstrap', 'tab_fixture', { onDialogChange }));
    const sendDialog = (source: unknown, open: unknown) => act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: source as Window,
        data: { type: 'clklog:harness-dialog', runtime_id: runtimeId, open },
      }));
    });

    sendDialog(window, true);                        // 伪造来源
    expect(onDialogChange).not.toHaveBeenCalled();
    sendDialog(iframe.contentWindow, true);
    sendDialog(iframe.contentWindow, false);
    expect(onDialogChange.mock.calls.map((call) => call[0])).toEqual([true, false]);
    sendDialog(iframe.contentWindow, 'yes');         // 非布尔
    expect(onDialogChange).toHaveBeenCalledTimes(2);
  });
});
