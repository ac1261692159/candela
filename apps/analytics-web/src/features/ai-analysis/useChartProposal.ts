import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import type { AiAnalysisPage, PageBridgeEvent } from '../../types/ai.types';
import { decidePageBridgeProposal } from '../../services/ai.service';
import { useAiContextStore } from '../../stores/ai-context.store';
import { useT } from '../../i18n';
import { PAGE_BRIDGE_EVENT } from '../ai/usePageBridge';

export interface PendingChartProposal {
  proposalId: string;
  expectedRevision: number;
  /** AI 给的理由，直接展示给用户（模型输出，不翻译） */
  reason: string;
  /** AI 提的图表配置原文，应用前不动它 */
  config: Record<string, unknown>;
}

/**
 * 事件分析的图表配置提案（phase: clklog-ai-event-chart-v1）。
 *
 * 与 `useAnalysisProposal` 的关键差异：**不自动应用**。
 * 那条通道改的是「还没跑的表单草稿」，这条改的是用户眼前正在读的图——
 * AI 自作主张把正在看的曲线挪走，比不帮忙更糟。所以这里只把提案落成一条待确认条，
 * 用户点「应用」才改本地状态（仍不写库，卡片要用户自己保存）。
 *
 * 提案的 5 分钟 TTL 内 AI 侧一直等；用户不点，AI 收到 timeout 而不是「已应用」。
 */
export function useChartProposal(
  page: AiAnalysisPage,
  project: string,
  apply: (config: Record<string, unknown>) => void,
  /** 当前生效配置，用于判断应用后 revision 会不会 +1（只做相等比较，不解析） */
  currentConfig?: unknown,
) {
  const { t } = useT('ai');
  const [proposal, setProposal] = useState<PendingChartProposal | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const configRef = useRef(currentConfig);
  configRef.current = currentConfig;

  const current = () =>
    useAiContextStore.getState().project === project &&
    useAiContextStore.getState().context?.page === page
      ? useAiContextStore.getState().context
      : null;

  useEffect(() => {
    const listener = (raw: Event) => {
      const incoming = (raw as CustomEvent<PageBridgeEvent>).detail;
      if (incoming?.action !== 'analysis_chart_edit') return;
      // page 缺失时放行：投递通道已按 tab 限定，page 只是额外守卫；
      // 严格要求它会让「服务端没下发 page」变成静默丢弃（宁可多渲染一次，也不要悄悄吞掉）
      if (incoming.page && incoming.page !== page) return;
      const reject = (reason: string) =>
        decidePageBridgeProposal(incoming.proposal_id, {
          accepted: false,
          current_revision: current()?.revision ?? 0,
          reason,
        }).catch(() => undefined);
      const expired = () =>
        Boolean(incoming.expires_at && Date.parse(incoming.expires_at) <= Date.now());
      if (expired()) {
        void reject(t('ai:analysis.proposalExpired'));
        return;
      }
      if (current()?.revision !== incoming.expected_revision) {
        void reject(t('ai:analysis.proposalStale'));
        return;
      }
      const config = incoming.chart_config;
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        void reject(t('ai:analysis.proposalApplyFailed'));
        return;
      }
      // 一次只保留最新一条；新提案覆盖旧提案（旧的那条由服务端标记 superseded）
      setProposal({
        proposalId: incoming.proposal_id,
        expectedRevision: incoming.expected_revision,
        reason: incoming.reason ?? '',
        config: config as Record<string, unknown>,
      });
      // 确认动作在结果区，而用户这时多半盯着 AI 面板——不提示就只看到一个转圈，
      // 观感等同「卡住」（2026-09-23 线上实测：提案在 5 分钟 TTL 内无人确认而超时）
      message.info(t('analysis:aiChart.incoming'));
    };
    window.addEventListener(PAGE_BRIDGE_EVENT, listener);
    return () => window.removeEventListener(PAGE_BRIDGE_EVENT, listener);
    // 依赖里不放 current/configRef：它们每次渲染都变，会把监听反复摘挂
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, project, t]);

  const accept = useCallback(() => {
    if (!proposal) return;
    const changed = JSON.stringify(configRef.current ?? null) !== JSON.stringify(proposal.config);
    setProposal(null);
    try {
      applyRef.current(proposal.config);
    } catch (error) {
      // 应用失败要如实回绝，不能让提案凭空消失（AI 侧会一直等到超时）
      const reason = error instanceof Error ? error.message : t('ai:analysis.proposalApplyFailed');
      void decidePageBridgeProposal(proposal.proposalId, {
        accepted: false,
        current_revision: current()?.revision ?? proposal.expectedRevision,
        reason,
      }).catch(() => undefined);
      message.warning(reason);
      return;
    }
    const appliedRevision = proposal.expectedRevision + (changed ? 1 : 0);
    void decidePageBridgeProposal(proposal.proposalId, {
      accepted: true,
      current_revision: appliedRevision,
      applied_revision: appliedRevision,
    })
      .then(() => message.success(t('analysis:aiChart.applied')))
      .catch(() => message.warning(t('ai:analysis.proposalReceiptMissing')));
  }, [proposal, t]);

  const dismiss = useCallback(() => {
    if (!proposal) return;
    setProposal(null);
    void decidePageBridgeProposal(proposal.proposalId, {
      accepted: false,
      current_revision: current()?.revision ?? proposal.expectedRevision,
      reason: t('analysis:aiChart.dismissed'),
    }).catch(() => undefined);
  }, [proposal, t]);

  /** 用户自己改了图表配置 → 未应用的提案已过时，丢弃 */
  const clear = useCallback(() => setProposal(null), []);

  return { proposal, accept, dismiss, clear };
}
