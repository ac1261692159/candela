import { useEffect, useRef } from 'react';
import { message } from 'antd';
import type { AiAnalysisPage, PageBridgeEvent } from '../../types/ai.types';
import { decidePageBridgeProposal } from '../../services/ai.service';
import { useAiContextStore } from '../../stores/ai-context.store';
import { useT } from '../../i18n';
import { PAGE_BRIDGE_EVENT } from '../ai/usePageBridge';

/**
 * 分析提案自动应用（2026-09-09 产品决策，见 PRD「提案自动应用与查询自动执行」）：
 * 提案事件到达后直接填入表单草稿并回执 accepted，不再弹人工确认框。
 * 过期与 revision 复核保留；页面「计算」仍由用户点击。
 */
export function useAnalysisProposal<T>(page: AiAnalysisPage, project: string,
  convert: (dsl: Record<string, unknown>) => T, apply: (form: T) => void) {
  const { t } = useT('ai');
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    const current = () => {
      const state = useAiContextStore.getState();
      return state.project === project && state.context?.page === page ? state.context : null;
    };
    const listener = (raw: Event) => {
      const proposal = (raw as CustomEvent<PageBridgeEvent>).detail;
      if (proposal?.action !== 'analysis_edit' || proposal.page !== page) return;
      const reject = (reason: string) => decidePageBridgeProposal(proposal.proposal_id, {
        accepted: false, current_revision: current()?.revision ?? 0, reason,
      }).catch(() => undefined);
      const expired = () => Boolean(proposal.expires_at && Date.parse(proposal.expires_at) <= Date.now());
      if (expired()) { void reject(t('ai:analysis.proposalExpired')); return; }
      if (current()?.revision !== proposal.expected_revision) { void reject(t('ai:analysis.proposalStale')); return; }
      let form: T;
      try { form = convert(proposal.dsl ?? {}); }
      catch (error) {
        const reason = error instanceof Error ? error.message : t('ai:analysis.proposalApplyFailed');
        void reject(reason); message.warning(reason); return;
      }
      const changed = JSON.stringify(current()?.analysis?.form) !== JSON.stringify(form);
      if (changed) applyRef.current(form);
      const appliedRevision = proposal.expected_revision + (changed ? 1 : 0);
      // 应用会在同一批次发布新的语义版本，服务端允许 expected 或 expected+1。
      void decidePageBridgeProposal(proposal.proposal_id, {
        accepted: true, current_revision: appliedRevision,
        applied_revision: appliedRevision,
      }).then(() => {
        message.success(t('ai:analysis.proposalApplied'));
      }).catch(() => {
        message.warning(t('ai:analysis.proposalReceiptMissing'));
      });
    };
    window.addEventListener(PAGE_BRIDGE_EVENT, listener);
    return () => {
      window.removeEventListener(PAGE_BRIDGE_EVENT, listener);
    };
  }, [convert, page, project, t]);
}
