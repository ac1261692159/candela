// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAnalysisProposal } from './useAnalysisProposal';
import { eventForm } from './dsl-form';
import { useAiContextStore } from '../../stores/ai-context.store';
import { decidePageBridgeProposal } from '../../services/ai.service';
import { PAGE_BRIDGE_EVENT } from '../ai/usePageBridge';
import cases from '../../../../analytics-harness-host/plugins/analytics-tools/analysis-cases.json';
vi.mock('../../services/ai.service', () => ({ decidePageBridgeProposal: vi.fn().mockResolvedValue({ ok: true }) }));
afterEach(() => { useAiContextStore.getState().clearContext(); vi.clearAllMocks(); });

describe('analysis proposal auto-apply', () => {
  it('applies the proposal immediately without confirmation', async () => {
    const store = useAiContextStore.getState();
    store.publishContext({ page: 'event', route: '/analysis/event', analysis: { form: {} } }, 'fixture');
    const revision = useAiContextStore.getState().context!.revision!;
    const apply = vi.fn();
    const hook = renderHook(() => useAnalysisProposal('event', 'fixture', eventForm, apply));
    act(() => window.dispatchEvent(new CustomEvent(PAGE_BRIDGE_EVENT, { detail: {
      action: 'analysis_edit', page: 'event', proposal_id: 'p1',
      expected_revision: revision, dsl: cases.event, reason: 'fixture',
    } })));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply).toHaveBeenCalledWith(eventForm(cases.event));
    await waitFor(() => expect(decidePageBridgeProposal).toHaveBeenCalledWith('p1', {
      accepted: true, current_revision: revision + 1, applied_revision: revision + 1,
    }));
    hook.unmount();
  });

  it('keeps the same revision when the proposed form is already present', async () => {
    const form = eventForm(cases.event);
    useAiContextStore.getState().publishContext({ page: 'event', route: '/analysis/event', analysis: { form } }, 'fixture');
    const revision = useAiContextStore.getState().context!.revision;
    const apply = vi.fn();
    const hook = renderHook(() => useAnalysisProposal('event', 'fixture', eventForm, apply));
    act(() => window.dispatchEvent(new CustomEvent(PAGE_BRIDGE_EVENT, { detail: {
      action: 'analysis_edit', page: 'event', proposal_id: 'same', expected_revision: revision, dsl: cases.event,
    } })));
    await waitFor(() => expect(decidePageBridgeProposal).toHaveBeenCalledWith('same', {
      accepted: true, current_revision: revision, applied_revision: revision,
    }));
    expect(apply).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('rejects an expired proposal without applying', async () => {
    const store = useAiContextStore.getState();
    store.publishContext({ page: 'event', route: '/analysis/event', analysis: { form: {} } }, 'fixture');
    const revision = useAiContextStore.getState().context!.revision;
    const apply = vi.fn();
    const hook = renderHook(() => useAnalysisProposal('event', 'fixture', eventForm, apply));
    act(() => window.dispatchEvent(new CustomEvent(PAGE_BRIDGE_EVENT, { detail: {
      action: 'analysis_edit', page: 'event', proposal_id: 'old', expected_revision: revision,
      dsl: cases.event, reason: 'fixture', expires_at: new Date(Date.now() - 1000).toISOString(),
    } })));
    await waitFor(() => expect(decidePageBridgeProposal).toHaveBeenCalledWith('old', expect.objectContaining({ accepted: false })));
    expect(apply).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('rejects when the page revision has moved on', async () => {
    const store = useAiContextStore.getState();
    store.publishContext({ page: 'event', route: '/analysis/event', analysis: { form: {} } }, 'fixture');
    const staleRevision = useAiContextStore.getState().context!.revision;
    store.publishContext({ page: 'event', route: '/analysis/event', analysis: { form: { changed: true } } }, 'fixture');
    const apply = vi.fn();
    const hook = renderHook(() => useAnalysisProposal('event', 'fixture', eventForm, apply));
    act(() => window.dispatchEvent(new CustomEvent(PAGE_BRIDGE_EVENT, { detail: {
      action: 'analysis_edit', page: 'event', proposal_id: 'late', expected_revision: staleRevision,
      dsl: cases.event, reason: 'fixture',
    } })));
    await waitFor(() => expect(decidePageBridgeProposal).toHaveBeenCalledWith('late', expect.objectContaining({ accepted: false })));
    expect(apply).not.toHaveBeenCalled();
    hook.unmount();
  });
});
