import { useEffect, useRef, useState, type RefObject } from 'react';
import { AxiosError } from 'axios';
import { post } from '../../services/api';
import { useT } from '../../i18n';

export interface HarnessConnectionOptions {
  /**
   * 官方弹层开合（phase: clklog-analytics-ai-panel-surface-v1）。
   * 面板据此在弹窗打开时临时离开文档流——官方设置弹窗需要 ≥640 才排得开。
   */
  onDialogChange?: (open: boolean) => void;
}

export function useHarnessConnection(
  frame: RefObject<HTMLIFrameElement>,
  source: string,
  tabId: string,
  options: HarnessConnectionOptions = {},
) {
  const { t } = useT('ai');
  const [notice, setNotice] = useState('');
  // 回调放 ref：它一变就重启 effect 会连带重建 runtimeId 与重连计时器，那是我们不想要的副作用。
  const onDialogChange = useRef(options.onDialogChange);
  useEffect(() => {
    onDialogChange.current = options.onDialogChange;
  });
  useEffect(() => {
    setNotice('');
    if (!source) return;
    let runtimeId = '';
    let active = true;
    let pending = false;
    let blocked = false;
    let failedOperation = false;
    const controller = new AbortController();
    const renew = async () => {
      if (!active || !runtimeId || pending || blocked || !navigator.onLine) return;
      pending = true;
      try {
        const result = await post<{ prefix: string }>('/assistant/connection/renew',
          { runtime_id: runtimeId, tab_id: tabId }, { silent: true, timeout: 15_000, signal: controller.signal });
        if (!active) return;
        frame.current?.contentWindow?.postMessage({ type: 'clklog:harness-renewed', prefix: result.prefix }, '*');
        setNotice(failedOperation ? t('ai:connection.renewed') : '');
      } catch (error) {
        if (!active) return;
        const status = error instanceof AxiosError ? error.response?.status : undefined;
        if (status === 401 || status === 403) {
          blocked = true;
          setNotice(t('ai:connection.unauthorized'));
        } else if (status === 404) {
          blocked = true;
          setNotice(t('ai:connection.recycled'));
        } else {
          setNotice(t('ai:connection.checkFailed'));
        }
      } finally { pending = false; }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'clklog:harness-ready' && /^air_[a-zA-Z0-9_-]{20,}$/.test(event.data.runtime_id)) {
        if (runtimeId && runtimeId !== event.data.runtime_id) return;
        runtimeId = event.data.runtime_id;
        void renew();
      }
      if (event.data.type === 'clklog:harness-unauthorized') {
        failedOperation = true;
        setNotice(t('ai:connection.opUnauthorized'));
        void renew();
      }
      if (event.data.type === 'clklog:harness-dialog' && typeof event.data.open === 'boolean') {
        onDialogChange.current?.(event.data.open);
      }
    };
    const check = () => { if (document.visibilityState !== 'hidden') void renew(); };
    const offline = () => setNotice(t('ai:connection.offline'));
    window.addEventListener('message', onMessage);
    window.addEventListener('online', check);
    window.addEventListener('offline', offline);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    const timer = window.setInterval(check, 60_000);
    return () => {
      active = false; controller.abort(); window.clearInterval(timer);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('online', check);
      window.removeEventListener('offline', offline);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [frame, source, t, tabId]);
  return notice;
}
