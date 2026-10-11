import { useEffect, useRef } from 'react';
import { AxiosError } from 'axios';
import { useAiContextStore } from '../../stores/ai-context.store';
import { useProjectStore } from '../../stores/project.store';
import {
  getAiTabId,
  pollPageBridgeEvents,
  publishPageBridgeSnapshot,
  disconnectPageBridge,
} from '../../services/ai.service';
import type { PageBridgeEvent } from '../../types/ai.types';

export const PAGE_BRIDGE_EVENT = 'clklog:page-bridge-event';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => window.setTimeout(resolvePromise, milliseconds));
}

export function currentRevisionFromError(error: unknown): number | null {
  const data = error instanceof AxiosError ? error.response?.data : undefined;
  const value =
    data && typeof data === 'object'
      ? (data as { data?: { current_revision?: unknown } }).data?.current_revision
      : undefined;
  return Number.isSafeInteger(value) ? Number(value) : null;
}

export function usePageBridge(): void {
  const context = useAiContextStore((state) => state.context);
  const contextProject = useAiContextStore((state) => state.project);
  const project = useProjectStore((state) => state.currentProject);
  const tabId = getAiTabId();
  const afterRef = useRef(0);
  const activeContext = contextProject === project ? context : null;
  const lastRevision = useRef(0);
  if (activeContext?.revision != null) lastRevision.current = activeContext.revision;

  useEffect(() => {
    if (!activeContext) return;
    const controller = new AbortController();
    const revision = activeContext.revision ?? 0;
    const publish = () => {
      void publishPageBridgeSnapshot(tabId, activeContext, revision, controller.signal).catch((error) => {
        if (controller.signal.aborted) return;
        const serverRevision = currentRevisionFromError(error);
        if (serverRevision != null && useAiContextStore.getState().context === activeContext) {
          useAiContextStore.getState().rebaseRevision(serverRevision);
        }
      });
    };
    const timer = window.setTimeout(publish, 100);
    const heartbeat = window.setInterval(publish, 30_000);
    window.addEventListener('online', publish);
    window.addEventListener('focus', publish);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      window.clearInterval(heartbeat);
      window.removeEventListener('online', publish);
      window.removeEventListener('focus', publish);
    };
  }, [activeContext, project, tabId]);

  const hasBridge = Boolean(activeContext);
  useEffect(() => {
    if (!hasBridge) return;
    const controller = new AbortController();
    afterRef.current = 0;
    const loop = async () => {
      while (!controller.signal.aborted) {
        try {
          const result = await pollPageBridgeEvents(tabId, afterRef.current, controller.signal);
          if (controller.signal.aborted) return;
          for (const event of result.events) {
            afterRef.current = Math.max(afterRef.current, event.sequence);
            window.dispatchEvent(new CustomEvent<PageBridgeEvent>(PAGE_BRIDGE_EVENT, { detail: event }));
          }
          if (result.current_revision == null) {
            afterRef.current = 0;
            await delay(1_000);
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof AxiosError && error.response?.status === 401) return;
          await delay(2_000);
        }
      }
    };
    void loop();
    return () => {
      controller.abort();
      if (!useAiContextStore.getState().context && useProjectStore.getState().currentProject === project) {
        void disconnectPageBridge(tabId, lastRevision.current).catch(() => undefined);
      }
    };
  }, [hasBridge, project, tabId]);
}
