// @vitest-environment jsdom
/**
 * 分片加载失败兜底（2026-09-19 事故）。
 *
 * 发版替换资产后，停留在旧页面的浏览器会请求不到分片：此前表现为长时间白屏且无提示。
 * 现在先自动刷新一次自愈（时间窗防循环），仍失败则给出「平台已更新，请刷新页面」+ 刷新按钮。
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChunkErrorBoundary, CHUNK_RELOAD_KEY } from './routes';

function Boom(): JSX.Element {
  throw new Error('Failed to fetch dynamically imported module');
}

describe('ChunkErrorBoundary', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('首次失败自动刷新一次以自愈', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <ChunkErrorBoundary failedText="平台已更新，请刷新页面" reloadText="刷新">
        <Boom />
      </ChunkErrorBoundary>,
    );

    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).not.toBeNull();
  });

  it('时间窗内再次失败：不再刷新，给出可操作提示与刷新按钮', async () => {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <ChunkErrorBoundary failedText="平台已更新，请刷新页面" reloadText="刷新">
        <Boom />
      </ChunkErrorBoundary>,
    );

    expect(reload).not.toHaveBeenCalled();
    expect(await screen.findByText('平台已更新，请刷新页面')).toBeTruthy();
    expect(screen.getByRole('button', { name: /刷\s*新/ })).toBeTruthy();
  });
});
