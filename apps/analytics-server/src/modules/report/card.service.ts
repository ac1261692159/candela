import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { nanoid } from 'nanoid';
import { badRequest, conflict, forbidden, notFound } from '../../i18n/domain-error';
import { CardRepository } from './card.repository';
import { DashboardRepository } from './dashboard.repository';
import { EventQueryService } from '../query/event-query.service';
import { FunnelQueryService } from '../query/funnel-query.service';
import { RetentionQueryService } from '../query/retention-query.service';
import { MetricEvalService } from '../query/metric-eval.service';
import { PrismaService } from '../shared/prisma.service';
import { SqlReportService } from './sql-report.service';
import { CohortBatchService } from '../query/cohort-batch.service';
import {
  mergeDashboardCohortFilter,
  parseDashboardCohortFilter,
} from './sql-cohort-filter';
import {
  CreateCardDto,
  UpdateCardDto,
  ReorderCardsDto,
  AddCardToDashboardDto,
  UpdateCardLayoutDto,
  UpdateCardDisplayDto,
  SaveDashboardLayoutDto,
} from './dto/card.dto';
import type { AuthUser } from '../auth/auth.service';
import type { TimeRange } from '../../types/dsl.types';
import { parseStoredCache, serializeCacheResult, summarizeCache } from './card-cache.policy';
import { assertCardDisplay, parseStoredDisplay } from './card-display';
import { parseChartConfigV1 } from './chart-config.validator';
import { AssetPolicyService } from '../iam/asset-policy.service';
import type { IamContext, DataScope } from '../iam/iam.types';
import type { AssetAclGrant } from '../iam/asset-policy.service';

/**
 * 卡片业务（2026-09 重设计）。
 * 卡片是全局一等资产：各分析模块（事件/漏斗/留存/自定义SQL）保存产出卡片；
 * 看板是卡片的引用集合（DashboardCard 关联表存储布局）。
 * refresh 按卡片 type 调用对应 QueryService 实时重算（绕过缓存）。
 */
@Injectable()
export class CardService {
  private readonly logger = new Logger(CardService.name);

  constructor(
    private readonly repo: CardRepository,
    private readonly dashboardRepo: DashboardRepository,
    private readonly eventQuery: EventQueryService,
    private readonly funnelQuery: FunnelQueryService,
    private readonly retentionQuery: RetentionQueryService,
    private readonly sqlReport: SqlReportService,
    private readonly cohortBatches: CohortBatchService,
    private readonly policy: AssetPolicyService,
    // 指标卡（metric-v3）：读 metasavedmetric 并复用指标求值（与试算/告警同一实现）
    private readonly prisma: PrismaService,
    private readonly metricEval: MetricEvalService,
  ) {}

  // ===== 全局卡片 =====

  /** 卡片库列表（admin 看全部，其余看自己的） */
  async list(project: string, user: AuthUser, iam: IamContext, type?: string) {
    const rows = await this.repo.findMany(project, type);
    const visible =
      iam.permissions.has('dashboard.view_all') || iam.permissions.has('model.card_save')
        ? rows
        : rows.filter((c) => c.owner === user.id);
    const isAdmin = iam.role_key === 'project_owner' || iam.role_key === 'analysis_admin';
    const out = [];
    for (const c of visible) {
      const asset = await this.policy.loadCard(project, c.card_id);
      const canEdit = await this.policy.canUpdate(user.id, iam, asset);
      const dashIds = c.dashboard_cards?.map((d) => d.db_id) ?? [];
      const dashTtls = (c.dashboard_cards ?? [])
        .map((d) => d.dashboard?.cache_ttl_sec)
        .filter((ttl): ttl is number => typeof ttl === 'number');
      out.push({
        ...this.toCard(c, dashIds),
        locked: c.locked,
        ref_count: dashIds.length,
        can_edit: canEdit && !isAdmin,
        grant_count: isAdmin ? await this.policy.grantCount('card', c.card_id) : undefined,
        cache_summary: summarizeCache(c.cache, dashTtls),
      });
    }
    return out;
  }

  async get(cardId: string, project: string, user: AuthUser, iam: IamContext) {
    const card = await this.repo.findById(cardId);
    if (!card || card.project_name !== project) {
      throw notFound({
        code: 'report.card.notFound',
        messageKey: 'report:error.card.notFound',
        params: { id: cardId },
        message: `卡片不存在: ${cardId}`,
      });
    }
    await this.assertCard(cardId, project, user, iam, 'view');
    return {
      ...this.toCard(card, card.dashboard_cards?.map((d) => d.db_id) ?? []),
      cache: parseStoredCache(card.cache),
    };
  }

  /** 同项目内名称唯一（重命名时排除自身） */
  private async assertNameFree(project: string, name: string, exceptCardId?: string) {
    if (await this.repo.findByName(project, name, exceptCardId)) {
      throw conflict({
        code: 'report.card.nameExists',
        messageKey: 'report:error.card.nameExists',
        params: { name },
        message: `已存在同名卡片「${name}」，请换一个名称`,
      });
    }
  }

  /** 创建全局卡片 */
  async create(dto: CreateCardDto, project: string, user: AuthUser) {
    if (dto.type === 'text') this.assertTextDsl(dto.dsl);
    if (dto.type === 'metric') await this.assertMetricCardDsl(project, dto.dsl);
    this.assertEventChartConfig(dto.type, dto.dsl);
    await this.assertNameFree(project, dto.name);
    const card = await this.repo.create({
      card_id: `card_${nanoid(10)}`,
      project_name: project,
      owner: user.id,
      name: dto.name,
      description: dto.description?.trim() || null,
      type: dto.type,
      dsl_json: JSON.stringify(dto.dsl),
      chart_type: dto.chart_type ?? (dto.type === 'text' ? 'table' : 'line'),
      refresh_policy: dto.refresh_policy ?? 'auto',
    });
    return this.toCard(card);
  }

  /** 更新全局卡片（仅 owner / admin） */
  async update(cardId: string, project: string, user: AuthUser, iam: IamContext, dto: UpdateCardDto) {
    const card = await this.assertCard(cardId, project, user, iam, 'update');
    if (dto.dsl !== undefined && card.type === 'text') this.assertTextDsl(dto.dsl);
    if (dto.dsl !== undefined) this.assertEventChartConfig(card.type, dto.dsl);
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined && dto.name !== card.name) {
      await this.assertNameFree(project, dto.name, card.card_id);
      data.name = dto.name;
    }
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.dsl !== undefined) data.dsl_json = JSON.stringify(dto.dsl);
    if (dto.chart_type !== undefined) data.chart_type = dto.chart_type;
    if (dto.refresh_policy !== undefined) data.refresh_policy = dto.refresh_policy;

    await this.repo.update(card.card_id, data);
    const fresh = await this.repo.findById(cardId);
    return this.toCard(fresh!);
  }

  /** 删除全局卡片（从所有看板级联移除引用） */
  async delete(cardId: string, project: string, user: AuthUser, iam: IamContext) {
    const card = await this.assertCard(cardId, project, user, iam, 'delete');
    await this.repo.delete(card.card_id);
    return { deleted: 1 };
  }

  // ===== 看板-卡片关联 =====

  /** 看板引用的卡片列表（卡片内容 + 布局） */
  async listByDashboard(dbId: string, project: string, user: AuthUser, iam: IamContext) {
    await this.assertDashboard(dbId, project, user, iam, 'view');
    const links = await this.repo.findDashboardCards(dbId);
    return links.map((l) => ({ ...this.toCard(l.card), ...this.toPlacement(l) }));
  }

  /** 添加已有卡片到看板 */
  async addToDashboard(dbId: string, project: string, user: AuthUser, iam: IamContext, dto: AddCardToDashboardDto) {
    const dashboard = await this.assertDashboard(dbId, project, user, iam, 'update');
    const card = await this.repo.findById(dto.card_id);
    if (!card || card.project_name !== project) {
      throw notFound({
        code: 'report.card.notFound',
        messageKey: 'report:error.card.notFound',
        params: { id: dto.card_id },
        message: `卡片不存在: ${dto.card_id}`,
      });
    }
    if (await this.repo.findLink(dbId, dto.card_id)) {
      throw forbidden({
        code: 'report.card.alreadyInDashboard',
        messageKey: 'report:error.card.alreadyInDashboard',
        message: '该卡片已在此看板中',
      });
    }
    const cols = dashboard.grid_columns ?? 24;
    let position_x = dto.position_x;
    let position_y = dto.position_y;
    let width = dto.width;
    let height = dto.height;
    if (position_x === undefined || position_y === undefined || width === undefined || height === undefined) {
      const links = await this.repo.findDashboardCards(dbId);
      const maxY = links.reduce((m, l) => Math.max(m, l.position_y + l.height), 0);
      position_x = position_x ?? 0;
      position_y = position_y ?? maxY;
      width = width ?? Math.max(1, Math.floor(cols / 2));
      height = height ?? (card.type === 'text' ? 3 : 6);
    }
    await this.repo.addLink({
      db_id: dbId,
      card_id: dto.card_id,
      position_x,
      position_y,
      width,
      height,
    });
    return this.toCard(card);
  }

  /** 更新看板内卡片布局（仅布局，卡片内容由全局接口改） */
  async updateLayout(
    cardId: string,
    dbId: string,
    project: string,
    user: AuthUser,
    iam: IamContext,
    dto: UpdateCardLayoutDto,
  ) {
    await this.assertDashboard(dbId, project, user, iam, 'update');
    const link = await this.repo.findLink(dbId, cardId);
    if (!link) {
      throw notFound({
        code: 'report.card.linkNotFound',
        messageKey: 'report:error.card.linkNotFound',
        params: { id: cardId },
        message: `看板中不存在该卡片: ${cardId}`,
      });
    }
    await this.repo.updateLink(dbId, cardId, dto);
    return { ok: true };
  }

  async updateDisplay(
    cardId: string,
    dbId: string,
    project: string,
    user: AuthUser,
    iam: IamContext,
    dto: UpdateCardDisplayDto,
  ) {
    await this.assertDashboard(dbId, project, user, iam, 'update');
    const link = await this.repo.findLink(dbId, cardId);
    if (!link) {
      throw notFound({
        code: 'report.card.linkNotFound',
        messageKey: 'report:error.card.linkNotFound',
        params: { id: cardId },
        message: `看板中不存在该卡片: ${cardId}`,
      });
    }
    const card = await this.repo.findById(cardId);
    if (!card || card.project_name !== project) {
      throw notFound({
        code: 'report.card.notFound',
        messageKey: 'report:error.card.notFound',
        params: { id: cardId },
        message: `卡片不存在: ${cardId}`,
      });
    }
    const display = assertCardDisplay(card.type, dto);
    await this.repo.updateLink(dbId, cardId, { display_json: JSON.stringify(display) });
    return { ok: true, display };
  }

  /** 批量保存 Grafana 网格坐标 */
  async saveLayouts(dbId: string, project: string, user: AuthUser, iam: IamContext, dto: SaveDashboardLayoutDto) {
    await this.assertDashboard(dbId, project, user, iam, 'update');
    await this.repo.saveLayouts(dbId, dto.items);
    return { ok: true };
  }

  /** 从看板移除卡片（仅删关联，不删卡片） */
  async removeFromDashboard(cardId: string, dbId: string, project: string, user: AuthUser, iam: IamContext) {
    await this.assertDashboard(dbId, project, user, iam, 'update');
    const link = await this.repo.findLink(dbId, cardId);
    if (!link) {
      throw notFound({
        code: 'report.card.linkNotFound',
        messageKey: 'report:error.card.linkNotFound',
        params: { id: cardId },
        message: `看板中不存在该卡片: ${cardId}`,
      });
    }
    await this.repo.removeLink(dbId, cardId);
    return { ok: true };
  }

  /** 调整卡片顺序（按传入的 card_id 数组更新 position_x） */
  async reorder(dbId: string, project: string, user: AuthUser, iam: IamContext, dto: ReorderCardsDto) {
    await this.assertDashboard(dbId, project, user, iam, 'update');
    const links = await this.repo.findDashboardCards(dbId);
    const orderMap = new Map(dto.card_ids.map((id, i) => [id, i]));
    for (const link of links) {
      const idx = orderMap.get(link.card_id);
      if (idx !== undefined) {
        await this.repo.updateLink(dbId, link.card_id, { position_x: idx, position_y: 0 });
      }
    }
    return { ok: true };
  }

  /**
   * 执行 SQL 卡片（不要求已挂到看板）。
   * 会话目录 / API Key catalog / Harness 静默拉数共用。
   */
  async executeSql(
    cardId: string,
    project: string,
    user: AuthUser,
    iam: IamContext,
    overrides?: { time_range?: TimeRange; limit?: number },
  ) {
    const card = await this.assertCard(cardId, project, user, iam, 'view');
    if (card.type !== 'sql') {
      throw badRequest({
        code: 'report.card.sqlCardOnly',
        messageKey: 'report:error.card.sqlCardOnly',
        message: '仅 sql 卡片支持目录执行',
      });
    }
    return this.sqlReport.executeFromCardDsl(this.parseDsl(card.dsl_json), project, {
      ...overrides,
      scope: iam.data_scope,
    });
  }

  async refresh(cardId: string, dbId: string, project: string, user: AuthUser, iam: IamContext) {
    const dashboard = await this.assertDashboard(dbId, project, user, iam, 'view');
    const card = await this.repo.findById(cardId);
    if (!card || card.project_name !== project) {
      throw notFound({
        code: 'report.card.notFound',
        messageKey: 'report:error.card.notFound',
        params: { id: cardId },
        message: `卡片不存在: ${cardId}`,
      });
    }

    const dashFilter = parseDashboardCohortFilter(dashboard.cohort_filter_json);
    if (dashFilter) {
      const resolved = await this.cohortBatches.resolve(project, dashFilter.cohort_id);
      if (!resolved.ready) {
        throw badRequest({
          code: 'report.card.cohortFilterUnavailable',
          messageKey: 'report:error.card.cohortFilterUnavailable',
          message: '看板分群筛选不可用：分群未就绪或已删除',
        });
      }
      const result = await this.computeResult(
        card,
        {
          filter: dashFilter,
          batchId: resolved.batch_id,
        },
        iam.data_scope,
      );
      await this.writeCache(card.card_id, result, null);
      return { card_id: cardId, type: card.type, result };
    }

    const result = await this.computeResult(card, undefined, iam.data_scope);
    await this.writeCache(card.card_id, result, null);
    return { card_id: cardId, type: card.type, result };
  }

  /**
   * 执行卡片查询（系统任务与用户 refresh 共用）。
   * 不写缓存、不校验看板归属。
   */
  async computeResult(
    card: { card_id: string; type: string; dsl_json: string; project_name: string },
    dashboardCohort?: { filter: { cohort_id: string; op: 'in' | 'not_in' }; batchId: string },
    scope?: DataScope,
  ) {
    const parsed = this.parseDsl(card.dsl_json);
    const merged = dashboardCohort
      ? mergeDashboardCohortFilter(parsed, card.type, dashboardCohort.filter)
      : { dsl: parsed, handwrittenSql: false };
    const dsl = merged.dsl;
    switch (card.type) {
      case 'event':
        return this.eventQuery.analyze(dsl as never, card.project_name, true, scope);
      case 'funnel':
        return this.funnelQuery.analyze(dsl as never, card.project_name, true, scope);
      case 'sql':
        return this.sqlReport.executeFromCardDsl(
          dsl,
          card.project_name,
          {
            ...(merged.handwrittenSql && dashboardCohort
              ? {
                  cohortTableFilter: {
                    cohortId: dashboardCohort.filter.cohort_id,
                    batchId: dashboardCohort.batchId,
                    op: dashboardCohort.filter.op,
                  },
                }
              : {}),
            scope,
          },
        );
      case 'text':
        throw badRequest({
        code: 'report.card.textNoRefresh',
        messageKey: 'report:error.card.textNoRefresh',
        message: '标签卡无需刷新',
      });
      case 'retention':
        return this.retentionQuery.analyze(dsl as never, card.project_name, true, scope);
      case 'metric':
        return this.computeMetricCard(dsl, card.project_name, Boolean(dashboardCohort?.filter));
      default:
        throw badRequest({
          code: 'report.card.unknownType',
          messageKey: 'report:error.card.unknownType',
          params: { type: card.type },
          message: `未知卡片类型: ${card.type}`,
        });
    }
  }

  /**
   * 指标卡（phase: clklog-analytics-metric-v3）：以已保存指标为数据源，
   * 产出**分析同构**结果（日期列 + 指标列，首行是「阶段汇总」取值行），
   * 这样折线 / 柱状 / 表格 / 数值四种视图与 CSV 导出都能直接复用既有渲染链路。
   */
  private async computeMetricCard(dsl: Record<string, unknown>, project: string, cohortRequested = false) {
    const metricId = typeof dsl.metric_id === 'string' ? dsl.metric_id : '';
    const metric = await this.prisma.metaSavedMetric.findFirst({
      where: { metric_id: metricId, project_name: project },
    });
    if (!metric) {
      throw badRequest({
        code: 'report.card.metricCardMissing',
        messageKey: 'report:error.card.metricCardMissing',
        message: '指标卡引用的指标不存在或不属于本项目',
      });
    }
    if (metric.kind !== 'event') {
      throw badRequest({
        code: 'report.card.metricEventOnly',
        messageKey: 'report:error.card.metricEventOnly',
        message: '指标卡目前只支持事件指标（留存指标请用留存分析卡片）',
      });
    }
    let definition: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(metric.definition_json) as unknown;
      if (parsed && typeof parsed === 'object') definition = parsed as Record<string, unknown>;
    } catch {
      definition = {};
    }
    const outcome = await this.metricEval.evaluateEvent({
      project,
      definition,
      kind: 'event',
      withSeries: true,
      refresh: true,
    });
    const title = metric.display_name || metric.name;
    return {
      columns: [
        // 固定文案列名附文案键：前端按查看者语言渲染；中文 title 原值保留（老客户端兜底）
        { key: 'g_0', title: '日期', title_key: 'analysis:column.date' },
        // 指标显示名属用户数据，不附文案键
        { key: 'm_0', title, unit: '' },
      ],
      rows: [
        { __stage: true, g_0: '阶段汇总', m_0: outcome.value },
        ...outcome.series.map((point) => ({ g_0: point.date, m_0: point.value })),
      ],
      elapsed_ms: outcome.elapsed_ms,
      // 卡片展示用：口径文案（取值选择 + 查询时间），前端在卡片副标题里显示。
      // 结果进缓存，所以只下发**结构 + 参数**：中文 `*_label` 原值保留（老客户端兜底），
      // 界面按查看者语言用 `metricWindowPayloadLabel` / `valuePickLabel` 渲染（i18n 收口）。
      metric_meta: {
        metric_id: metric.metric_id,
        display_name: title,
        window_label: outcome.window.label,
        window_days: outcome.window.days,
        window_source: outcome.window.source,
        window_relative: outcome.window.source === 'metric' ? outcome.window.range.relative ?? null : null,
        value_pick: outcome.pick,
        value_pick_label: outcome.pick_label,
        // 看板分群筛选对指标卡不生效：结果照常返回，界面据此提示（PRD AC-12）
        cohort_applied: !cohortRequested,
      },
    };
  }

  /** 指标卡必须给 metric_id，且指标存在、可求值（创建时就挡住，避免建出一张永远空的卡） */
  private async assertMetricCardDsl(project: string, dsl: unknown) {
    const raw = (dsl ?? {}) as { metric_id?: unknown };
    if (typeof raw.metric_id !== 'string' || !raw.metric_id) {
      throw badRequest({
        code: 'report.card.metricIdRequired',
        messageKey: 'report:error.card.metricIdRequired',
        message: '指标卡需要 dsl.metric_id',
      });
    }
    const metric = await this.prisma.metaSavedMetric.findFirst({
      where: { metric_id: raw.metric_id, project_name: project },
    });
    if (!metric) {
      throw badRequest({
        code: 'report.card.metricNotFound',
        messageKey: 'report:error.card.metricNotFound',
        message: '指标不存在或不属于本项目',
      });
    }
    if (metric.kind !== 'event') {
      throw badRequest({
        code: 'report.card.metricEventOnly',
        messageKey: 'report:error.card.metricEventOnly',
        message: '指标卡目前只支持事件指标（留存指标请用留存分析卡片）',
      });
    }
  }

  /** 卡片缓存唯一写入入口 */
  async writeCache(cardId: string, result: unknown, error: string | null) {
    const packed = serializeCacheResult(result);
    await this.repo.upsertCache(cardId, {
      result_json: packed.json,
      error,
      row_count: packed.rowCount,
      refreshed_at: new Date(),
    });
  }

  private parseDsl(json: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 损坏的 dsl 按空对象处理，后续 execute 会因缺少 SQL 返回 400
    }
    return {};
  }

  // ===== 私有 =====

  async lock(
    cardId: string,
    project: string,
    user: AuthUser,
    iam: IamContext,
    locked: boolean,
    confirm = false,
  ) {
    const asset = await this.policy.loadCard(project, cardId);
    const ref_count = await this.repo.findById(cardId).then((c) => c?.dashboard_cards?.length ?? 0);
    if (locked && ref_count > 0 && !confirm) {
      return { need_confirm: true, ref_count };
    }
    await this.policy.assert(user.id, iam, 'lock', asset, { locking: locked });
    await this.repo.update(cardId, { locked });
    return { ok: true, locked, ref_count };
  }

  async listAcl(cardId: string, project: string) {
    return this.policy.listAcl(project, 'card', cardId);
  }

  async putAcl(cardId: string, project: string, user: AuthUser, iam: IamContext, grants: AssetAclGrant[]) {
    const asset = await this.policy.loadCard(project, cardId);
    await this.policy.replaceAcl(user.id, iam, project, asset, grants.filter((g) => g.perm === 'edit'));
    return { ok: true };
  }

  private async assertDashboard(
    dbId: string,
    project: string,
    user: AuthUser,
    iam: IamContext,
    action: 'view' | 'update',
  ) {
    const db = await this.dashboardRepo.findById(dbId, project);
    if (!db) {
      throw notFound({
        code: 'report.dashboard.notFound',
        messageKey: 'report:error.dashboard.notFound',
        params: { id: dbId },
        message: `看板不存在: ${dbId}`,
      });
    }
    const asset = await this.policy.loadDashboard(project, dbId);
    if (action === 'view') {
      const canView =
        iam.permissions.has('dashboard.view_all') ||
        db.owner === user.id ||
        (await this.policy.hasViewGrant(user.id, iam, dbId));
      if (!canView) {
        throw forbidden({
          code: 'report.asset.forbidden',
          messageKey: 'report:error.asset.forbidden',
          message: '无权访问该资源',
        });
      }
      return db;
    }
    await this.policy.assert(user.id, iam, 'update', asset);
    return db;
  }

  private async assertCard(
    cardId: string,
    project: string,
    user: AuthUser,
    iam: IamContext,
    action: 'view' | 'update' | 'delete',
  ) {
    const card = await this.repo.findById(cardId);
    if (!card || card.project_name !== project) {
      throw notFound({
        code: 'report.card.notFound',
        messageKey: 'report:error.card.notFound',
        params: { id: cardId },
        message: `卡片不存在: ${cardId}`,
      });
    }
    if (action === 'view') {
      const viewAll = iam.permissions.has('dashboard.view_all') || iam.permissions.has('model.card_save');
      if (viewAll || card.owner === user.id) return card;
      const asset = await this.policy.loadCard(project, cardId);
      if (await this.policy.canUpdate(user.id, iam, asset)) return card;
      throw forbidden({
        code: 'report.asset.forbidden',
        messageKey: 'report:error.asset.forbidden',
        message: '无权访问该资源',
      });
    }
    const asset = await this.policy.loadCard(project, cardId);
    await this.policy.assert(user.id, iam, action, asset);
    return card;
  }

  /**
   * 事件卡的 `dsl.chart_config` 与 SQL 卡同名字段、同一份契约
   * （phase: clklog-analytics-event-chart-binding-v1）。
   *
   * 只在**存在时**校验：没有该键的旧卡照旧保存（`dsl` 仍是自由 JSON）。
   * 非法配置抛 400 拒绝保存，而不是静默丢弃——静默丢弃会让用户以为配置存上了。
   */
  private assertEventChartConfig(type: string, dsl: unknown) {
    if (type !== 'event') return;
    if (!dsl || typeof dsl !== 'object' || Array.isArray(dsl)) return;
    const raw = (dsl as { chart_config?: unknown }).chart_config;
    if (raw === undefined || raw === null) return;
    parseChartConfigV1(raw, 'event');
  }

  private assertTextDsl(dsl: unknown) {
    if (!dsl || typeof dsl !== 'object' || Array.isArray(dsl)) {
      throw badRequest({
        code: 'report.card.textDslNotObject',
        messageKey: 'report:error.card.textDslNotObject',
        message: '标签卡 dsl 必须是对象',
      });
    }
    const rec = dsl as Record<string, unknown>;
    if (typeof rec.body !== 'string') {
      throw badRequest({
        code: 'report.card.textBodyRequired',
        messageKey: 'report:error.card.textBodyRequired',
        message: '标签卡需要 body 文本',
      });
    }
    const hex = /^#[0-9A-Fa-f]{6}$/;
    if (rec.text_color !== undefined && (typeof rec.text_color !== 'string' || !hex.test(rec.text_color))) {
      throw badRequest({
        code: 'report.card.textColorInvalid',
        messageKey: 'report:error.card.textColorInvalid',
        message: 'text_color 须为 #RRGGBB',
      });
    }
    if (
      rec.background_color !== undefined &&
      (typeof rec.background_color !== 'string' || !hex.test(rec.background_color))
    ) {
      throw badRequest({
        code: 'report.card.backgroundColorInvalid',
        messageKey: 'report:error.card.backgroundColorInvalid',
        message: 'background_color 须为 #RRGGBB',
      });
    }
  }

  private toPlacement(l: {
    position_x: number;
    position_y: number;
    width: number;
    height: number;
    display_json?: string | null;
  }) {
    return {
      ...this.toLayout(l),
      display: parseStoredDisplay(l.display_json),
    };
  }

  private toLayout(l: { position_x: number; position_y: number; width: number; height: number }) {
    return {
      position_x: l.position_x,
      position_y: l.position_y,
      width: l.width,
      height: l.height,
    };
  }

  private toCard(
    c: {
      card_id: string;
      name: string;
      description?: string | null;
      type: string;
      dsl_json: string;
      chart_type: string;
      refresh_policy: string;
      owner: string;
      locked?: boolean;
      created_at: Date;
      updated_at: Date;
    },
    dashboard_ids: string[] = [],
  ) {
    return {
      card_id: c.card_id,
      name: c.name,
      description: c.description ?? null,
      type: c.type,
      dsl: JSON.parse(c.dsl_json),
      chart_type: c.chart_type,
      refresh_policy: c.refresh_policy,
      owner: c.owner,
      locked: c.locked ?? false,
      dashboard_ids,
      ref_count: dashboard_ids.length,
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }
}
