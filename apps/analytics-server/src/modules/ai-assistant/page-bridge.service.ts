import {
  ConflictException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { badRequest, conflict, domainError, notFound } from '../../i18n/domain-error';
import { AuthUser } from '../auth/auth.service';
import { AiContextSanitizerService } from './ai-context-sanitizer.service';
import {
  PageBridgeAction,
  PageBridgeDecisionInput,
  PageBridgeEvent,
  PageBridgeRuntimeIdentity,
  PageBridgeSnapshotInput,
} from './page-bridge.types';
import { parseChartProposal, snapshotResultColumns, type ChartProposalDomain } from './chart-proposal';

const TAB_ID = /^[a-zA-Z0-9_-]{16,128}$/;
const MAX_SQL_CHARS = 64 * 1024;
const BRIDGE_TTL_MS = 10 * 60_000;
const PROPOSAL_TTL_MS = 5 * 60_000 - 5_000;

interface BridgeEntry {
  snapshot: {
    page: PageBridgeSnapshotInput['page'];
    revision: number;
    state: Record<string, unknown>;
    truncated: boolean;
    updated_at: string;
  };
  sequence: number;
  events: PageBridgeEvent[];
  waiters: Set<() => void>;
  lastSeenAt: number;
}

interface PendingProposal {
  key: string;
  userId: string;
  project: string;
  event: PageBridgeEvent;
  expiresAt: number;
  resolve: (value: Record<string, unknown>) => void;
  timer: NodeJS.Timeout;
  /**
   * 页面是否取走过这条提案（轮询返回过它）。
   *
   * 没有这个信号时，「用户看到提案但没点」与「提案根本没送到页面」在工具侧
   * 都只表现为 timeout，无法区分（2026-09-23 线上连续三次超时无法定位，
   * 由 Harness 侧提出加此回执）。取值随结果一并返回。
   */
  delivered: boolean;
}

@Injectable()
export class PageBridgeService implements OnModuleDestroy {
  private readonly bridges = new Map<string, BridgeEntry>();
  private readonly proposals = new Map<string, PendingProposal>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly sanitizer: AiContextSanitizerService) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
    for (const proposal of this.proposals.values()) {
      clearTimeout(proposal.timer);
      proposal.resolve({ status: 'page_unavailable', proposal_id: proposal.event.proposal_id });
    }
    this.proposals.clear();
  }

  updateSnapshot(
    user: AuthUser,
    project: string,
    input: PageBridgeSnapshotInput,
  ): { ok: true; revision: number; truncated: boolean } {
    this.validateTabId(input.tab_id);
    if (!['event', 'funnel', 'retention', 'sql'].includes(input.page)) {
      throw badRequest({
        code: 'ai.bridge.pageTypeInvalid',
        messageKey: 'ai:error.bridge.pageTypeInvalid',
        message: '页面类型无效',
      });
    }
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
      throw badRequest({
        code: 'ai.bridge.revisionInvalid',
        messageKey: 'ai:error.bridge.revisionInvalid',
        message: '页面 revision 无效',
      });
    }
    if (!input.state || typeof input.state !== 'object' || Array.isArray(input.state)) {
      throw badRequest({
        code: 'ai.bridge.stateInvalid',
        messageKey: 'ai:error.bridge.stateInvalid',
        message: '页面状态无效',
      });
    }
    const sanitized = this.sanitizer.sanitize(input.state);
    const key = this.key(user.id, project, input.tab_id);
    const existing = this.bridges.get(key);
    if (existing && input.revision < existing.snapshot.revision) {
      throw new ConflictException({
        code: 'ai.bridge.revisionStale',
        errorCode: 'ai.bridge.revisionStale',
        messageKey: 'ai:error.bridge.revisionStale',
        message: '页面 revision 已过期',
        current_revision: existing.snapshot.revision,
      });
    }
    if (existing && existing.snapshot.page !== input.page) {
      for (const proposal of [...this.proposals.values()]) {
        if (proposal.key === key) {
          this.finishProposal(proposal, {
            status: 'page_unavailable',
            proposal_id: proposal.event.proposal_id,
          });
        }
      }
    }
    const entry: BridgeEntry = existing ?? {
      snapshot: {
        page: input.page,
        revision: input.revision,
        state: {},
        truncated: false,
        updated_at: new Date().toISOString(),
      },
      sequence: 0,
      events: [],
      waiters: new Set(),
      lastSeenAt: Date.now(),
    };
    entry.snapshot = {
      page: input.page,
      revision: input.revision,
      state: sanitized.value,
      truncated: sanitized.truncated,
      updated_at: new Date().toISOString(),
    };
    entry.lastSeenAt = Date.now();
    this.bridges.set(key, entry);
    return { ok: true, revision: input.revision, truncated: sanitized.truncated };
  }

  async events(
    user: AuthUser,
    project: string,
    tabId: string,
    after: number,
  ): Promise<{ events: PageBridgeEvent[]; current_revision: number | null }> {
    this.validateTabId(tabId);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw badRequest({
        code: 'ai.bridge.cursorInvalid',
        messageKey: 'ai:error.bridge.cursorInvalid',
        message: '事件游标无效',
      });
    }
    const key = this.key(user.id, project, tabId);
    const existing = this.bridges.get(key);
    if (!existing) return { events: [], current_revision: null };
    existing.lastSeenAt = Date.now();
    if (!existing.events.some((event) => event.sequence > after)) {
      await new Promise<void>((resolvePromise) => {
        const wake = () => {
          clearTimeout(timeout);
          existing.waiters.delete(wake);
          resolvePromise();
        };
        const timeout = setTimeout(wake, 25_000);
        existing.waiters.add(wake);
      });
    }
    const batch = existing.events.filter((event) => event.sequence > after).slice(0, 20);
    // 这批事件即将交给页面：对应的待决提案标记为「已送达」
    for (const event of batch) {
      const proposal = this.proposals.get(event.proposal_id);
      if (proposal) proposal.delivered = true;
    }
    return { events: batch, current_revision: existing.snapshot.revision };
  }

  read(identity: PageBridgeRuntimeIdentity) {
    const bridge = this.requiredBridge(identity);
    return bridge.snapshot;
  }

  disconnect(user: AuthUser, project: string, tabId: string, revision: number) {
    this.validateTabId(tabId);
    const key = this.key(user.id, project, tabId);
    const bridge = this.bridges.get(key);
    if (bridge?.snapshot.revision !== revision) return { ok: true };
    for (const proposal of [...this.proposals.values()]) {
      if (proposal.key === key) this.finishProposal(proposal, { status: 'page_unavailable', proposal_id: proposal.event.proposal_id });
    }
    for (const wake of bridge.waiters) wake();
    this.bridges.delete(key);
    return { ok: true };
  }

  propose(
    identity: PageBridgeRuntimeIdentity,
    action: PageBridgeAction,
    input: {
      sql: string;
      expected_revision: number;
      reason: string;
      card_id?: string;
      card_name?: string;
      page?: string;
      dsl?: Record<string, unknown>;
      chart_config?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    const bridge = this.requiredBridge(identity);
    if (action === 'analysis_edit') {
      if (!['event', 'funnel', 'retention'].includes(input.page ?? '') || input.page !== bridge.snapshot.page) {
        throw conflict({
          code: 'ai.bridge.analysisPageMismatch',
          messageKey: 'ai:error.bridge.analysisPageMismatch',
          message: 'analysis_page_mismatch',
        });
      }
      if (!input.dsl || JSON.stringify(input.dsl).length > MAX_SQL_CHARS) {
        throw badRequest({
          code: 'ai.bridge.analysisDslInvalid',
          messageKey: 'ai:error.bridge.analysisDslInvalid',
          message: 'analysis_dsl_invalid',
        });
      }
    } else if (action === 'analysis_chart_edit' || action === 'sql_chart_edit') {
      // 图表配置提案：SQL 与事件两域共用同一 action，按绑定页面选域（phase: clklog-ai-event-chart-v1）。
      // `sql_chart_edit` 是旧名，保留仅为「server 先更新、host 插件还是旧的」这种部署顺序容错。
      if (bridge.snapshot.page !== 'sql' && bridge.snapshot.page !== 'event') {
        throw conflict({
          code: 'ai.bridge.chartPageUnsupported',
          messageKey: 'ai:error.bridge.chartPageUnsupported',
          message: '当前页面不支持 AI 调整图表配置',
        });
      }
    } else if (bridge.snapshot.page !== 'sql') {
      throw conflict({
        code: 'ai.bridge.notSqlPage',
        messageKey: 'ai:error.bridge.notSqlPage',
        message: '当前绑定页面不是自定义 SQL',
      });
    }
    let chartConfig: Record<string, unknown> | undefined;
    if (action === 'analysis_chart_edit' || action === 'sql_chart_edit') {
      const columns = snapshotResultColumns(bridge.snapshot.state);
      if (!columns.length) {
        throw conflict({
          code: 'ai.bridge.chartRequiresResult',
          messageKey: 'ai:error.bridge.chartRequiresResult',
          message: 'sql_chart_requires_result',
        });
      }
      const domain: ChartProposalDomain = bridge.snapshot.page === 'event' ? 'event' : 'sql';
      chartConfig = parseChartProposal(input.chart_config, columns, domain) as unknown as Record<string, unknown>;
    }
    const sql = input.sql?.trim();
    if (
      action !== 'analysis_edit'
      && action !== 'sql_chart_edit'
      && action !== 'analysis_chart_edit'
      && (!sql || sql.length > MAX_SQL_CHARS)
    ) {
      throw badRequest({
        code: 'ai.bridge.sqlLengthInvalid',
        messageKey: 'ai:error.bridge.sqlLengthInvalid',
        message: 'SQL 长度无效',
      });
    }
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) {
      throw badRequest({
        code: 'ai.bridge.expectedRevisionInvalid',
        messageKey: 'ai:error.bridge.expectedRevisionInvalid',
        message: 'expected_revision 无效',
      });
    }
    if (input.expected_revision !== bridge.snapshot.revision) {
      throw conflict({
        code: 'ai.bridge.sqlRevisionConflict',
        messageKey: 'ai:error.bridge.sqlRevisionConflict',
        // message 是 Harness 侧唯一可见的错误面（插件按 `HTTP 409: <message>` 透出），
        // 故把「下一步该做什么」写进 message，而不是让模型去猜机器码含义。
        message:
          'sql_revision_conflict（页面 revision 已变化：编辑器被改过、卡片刚加载或跨轮失效）：' +
          '请重新调用 clklog_page_read 取最新 revision，再用该 revision 重试',
      });
    }
    if (action === 'sql_execute') {
      const analysis = bridge.snapshot.state.analysis;
      const currentSql =
        analysis && typeof analysis === 'object' && !Array.isArray(analysis)
          ? (analysis as Record<string, unknown>).sql
          : undefined;
      if (typeof currentSql !== 'string' || currentSql.trim() !== sql) {
        throw new ConflictException({
          code: 'ai.bridge.executionRequiresEditorSql',
          errorCode: 'ai.bridge.executionRequiresEditorSql',
          messageKey: 'ai:error.bridge.executionRequiresEditorSql',
          message:
            'sql_execution_requires_current_editor_sql（编辑器当前 SQL 与请求执行的 SQL 不一致）：' +
            '请先调用 clklog_propose_sql 提交同一段 SQL（它会写入编辑器），' +
            '再用完全相同的 SQL 调用 clklog_request_sql_execution',
        });
      }
    }
    const cardId = input.card_id?.trim();
    if (action === 'sql_load_card' && (!cardId || cardId.length > 128)) {
      throw badRequest({
        code: 'ai.bridge.cardIdInvalid',
        messageKey: 'ai:error.bridge.cardIdInvalid',
        message: 'card_id 无效',
      });
    }
    const reason = this.sanitizer.sanitizeText(input.reason?.trim() || 'AI 建议修改', 2_000);
    const bridgeKey = this.key(identity.user_id, identity.project_name, identity.tab_id);
    // 同一桥接至多一个待确认提案：新提案把旧待确认提案以 superseded 结束，
    // 旧工具等待立即返回，事件从列表移除后轮询端不再重放旧确认框。
    for (const pending of [...this.proposals.values()]) {
      if (pending.key === bridgeKey) {
        this.finishProposal(pending, { status: 'superseded', proposal_id: pending.event.proposal_id });
      }
    }
    const event: PageBridgeEvent = {
      sequence: ++bridge.sequence,
      proposal_id: `aip_${randomBytes(18).toString('base64url')}`,
      action,
      expected_revision: input.expected_revision,
      sql: sql ?? '',
      reason,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
      // page 对所有 action 都下发：客户端按它把自己不认识的事件过滤掉（事件自描述）。
      // 此前只给 analysis_edit 设置，图表提案的 page 是 undefined，按 page 过滤的
      // 监听器会把它们静默丢掉（2026-09-23 线上实测：送达了但页面不渲染，只能等超时）。
      page: bridge.snapshot.page,
      ...(action === 'analysis_edit' ? { dsl: input.dsl } : {}),
      ...(chartConfig ? { chart_config: chartConfig } : {}),
      ...(cardId ? { card_id: cardId } : {}),
      ...(input.card_name?.trim() ? { card_name: this.sanitizer.sanitizeText(input.card_name.trim(), 200) } : {}),
    };
    bridge.events.push(event);
    bridge.events = bridge.events.slice(-100);
    for (const wake of bridge.waiters) wake();
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        const pending = this.proposals.get(event.proposal_id);
        if (pending) this.finishProposal(pending, { status: 'timeout', proposal_id: event.proposal_id });
      }, PROPOSAL_TTL_MS);
      timer.unref();
      this.proposals.set(event.proposal_id, {
        key: bridgeKey,
        userId: identity.user_id,
        project: identity.project_name,
        event,
        expiresAt: Date.now() + PROPOSAL_TTL_MS,
        resolve: resolvePromise,
        timer,
        delivered: false,
      });
    });
  }

  decide(
    user: AuthUser,
    project: string,
    proposalId: string,
    decision: PageBridgeDecisionInput,
  ): { ok: true } {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.userId !== user.id || proposal.project !== project) {
      throw notFound({
        code: 'ai.bridge.proposalNotFound',
        messageKey: 'ai:error.bridge.proposalNotFound',
        message: '页面提案不存在或已失效',
      });
    }
    if (proposal.expiresAt <= Date.now()) {
      this.finishProposal(proposal, { status: 'timeout', proposal_id: proposalId });
      throw conflict({
        code: 'ai.bridge.proposalExpired',
        messageKey: 'ai:error.bridge.proposalExpired',
        message: 'proposal_expired',
      });
    }
    const bridge = this.bridges.get(proposal.key);
    if (!bridge) {
      throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
        code: 'ai.bridge.pageOffline',
        messageKey: 'ai:error.bridge.pageOffline',
        message: '页面已经离线',
      });
    }
    const expected = proposal.event.expected_revision;
    const appliedEditRevision =
      proposal.event.action !== 'sql_execute' &&
      decision.accepted
        ? decision.applied_revision
        : undefined;
    const expectedDecisionRevision = appliedEditRevision ?? expected;
    const bridgeRevisionAllowed =
      bridge.snapshot.revision === expected ||
      (Number.isSafeInteger(appliedEditRevision) &&
        appliedEditRevision === expected + 1 &&
        bridge.snapshot.revision === appliedEditRevision);
    if (
      !Number.isSafeInteger(decision.current_revision) ||
      decision.current_revision !== expectedDecisionRevision ||
      !bridgeRevisionAllowed
    ) {
      this.finishProposal(proposal, { status: 'revision_conflict', proposal_id: proposalId });
      throw conflict({
        code: 'ai.bridge.sqlRevisionConflict',
        messageKey: 'ai:error.bridge.sqlRevisionConflict',
        // message 是 Harness 侧唯一可见的错误面（插件按 `HTTP 409: <message>` 透出），
        // 故把「下一步该做什么」写进 message，而不是让模型去猜机器码含义。
        message:
          'sql_revision_conflict（页面 revision 已变化：编辑器被改过、卡片刚加载或跨轮失效）：' +
          '请重新调用 clklog_page_read 取最新 revision，再用该 revision 重试',
      });
    }
    if (!decision.accepted) {
      this.finishProposal(proposal, {
        status: 'rejected',
        proposal_id: proposalId,
        reason: this.sanitizer.sanitizeText(decision.reason ?? '用户拒绝', 500),
      });
      return { ok: true };
    }
    const result = decision.result === undefined
      ? undefined
      : this.sanitizer.sanitize({ result: decision.result }).value.result;
    this.finishProposal(proposal, {
      status: proposal.event.action === 'sql_execute' ? 'executed' : 'applied',
      proposal_id: proposalId,
      ...(decision.applied_revision === undefined
        ? {}
        : { applied_revision: decision.applied_revision }),
      ...(result === undefined ? {} : { result }),
    });
    return { ok: true };
  }

  private requiredBridge(identity: PageBridgeRuntimeIdentity): BridgeEntry {
    this.validateTabId(identity.tab_id);
    const bridge = this.bridges.get(this.key(identity.user_id, identity.project_name, identity.tab_id));
    if (!bridge || Date.now() - bridge.lastSeenAt > BRIDGE_TTL_MS) {
      throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
        code: 'ai.bridge.pageUnavailable',
        messageKey: 'ai:error.bridge.pageUnavailable',
        message: 'page_unavailable',
      });
    }
    return bridge;
  }

  private finishProposal(proposal: PendingProposal, result: Record<string, unknown>): void {
    clearTimeout(proposal.timer);
    this.proposals.delete(proposal.event.proposal_id);
    const bridge = this.bridges.get(proposal.key);
    if (bridge) {
      bridge.events = bridge.events.filter(
        (event) => event.proposal_id !== proposal.event.proposal_id,
      );
    }
    proposal.resolve({ ...result, delivered: proposal.delivered });
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, proposal] of this.proposals) {
      if (proposal.expiresAt > now) continue;
      this.finishProposal(proposal, { status: 'timeout', proposal_id: id });
    }
    for (const [key, bridge] of this.bridges) {
      if (now - bridge.lastSeenAt <= BRIDGE_TTL_MS) continue;
      for (const wake of bridge.waiters) wake();
      this.bridges.delete(key);
    }
  }

  private key(userId: string, project: string, tabId: string): string {
    return `${userId}\0${project}\0${tabId}`;
  }

  private validateTabId(tabId: string): void {
    if (!TAB_ID.test(tabId)) {
      throw badRequest({
        code: 'ai.bridge.tabIdInvalid',
        messageKey: 'ai:error.bridge.tabIdInvalid',
        message: 'tab_id 无效',
      });
    }
  }
}
