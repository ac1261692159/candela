import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { forbidden, notFound } from '../../i18n/domain-error';
import { PrismaService } from '../shared/prisma.service';
import type { AuthUser } from '../auth/auth.service';
import type { IamContext } from '../iam/iam.types';
import { QUERY_JOB_ERROR_TIMEOUT } from '../query-job/query-job.policy';
import { buildSnapshotRows } from '../query-job/query-job.rows';
import type { DebugWindow } from './dto/debug-query.dto';
import type { DebugQueryResult, RecentDebugQuery } from './debug.service';

// 快照体积上限与构造逻辑已抽到 query-job/query-job.rows.ts（两种 kind 共用同一套截断语义）
/** 列表分页上限 */
export const DEBUG_ARCHIVE_PAGE_SIZE_MAX = 100;

/** 项目级开关的进程内短缓存：避免每次查询多一次 DB 往返（写接口会主动清） */
const SWITCH_CACHE_TTL_MS = 30_000;
/** 本 kind（记录表泛化后：Debug 的读写一律限定 kind，避免与其它 kind 串味） */
const DEBUG_KIND = 'debug';

export interface DebugArchiveInput {
  project: string;
  user: AuthUser;
  query: RecentDebugQuery;
  result: DebugQueryResult;
  durationMs: number;
}

export interface DebugArchiveOutcome {
  archived: boolean;
  record_id?: string;
  truncated?: boolean;
  /** 项目关闭了留档（与「写失败」区分，前端文案不同） */
  archive_disabled?: boolean;
}

/** 转后台入参：窗口与条数由调用方归一后再传（避免两处各判一次） */
export interface EnqueueInput {
  project: string;
  user: AuthUser;
  query: RecentDebugQuery;
  window: DebugWindow;
  limit: number;
}

/** worker 认领到的任务（含重建查询所需的条件） */
export interface ClaimedDebugJob {
  id: string;
  project_name: string;
  created_by_name: string | null;
  created_at: Date;
  window: string;
  cond_distinct_id: string | null;
  cond_user_key: string | null;
  cond_event: string | null;
  cond_limit: number;
}

/**
 * Debug 查询留档（phase: clklog-analytics-debug-query-v1，PRD §3.5/F1）。
 *
 * 记录**永久保存**、可按条删除（写审计）；删除只删这份派生快照，不动 `sa_events`。
 * 留档失败一律降级：查询结果照常返回，只在响应里标 `archived:false`。
 */
@Injectable()
export class DebugArchiveService {
  private readonly logger = new Logger(DebugArchiveService.name);
  private readonly switchCache = new Map<string, { enabled: boolean; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /** 项目是否开启留档（默认开；项目行缺失也按默认开，不因配置缺行阻断查询） */
  async isEnabled(project: string): Promise<boolean> {
    const cached = this.switchCache.get(project);
    if (cached && Date.now() - cached.at < SWITCH_CACHE_TTL_MS) return cached.enabled;
    const row = await this.prisma.saProject.findUnique({
      where: { name: project },
      select: { debug_archive_enabled: true },
    });
    const enabled = row?.debug_archive_enabled ?? true;
    this.switchCache.set(project, { enabled, at: Date.now() });
    return enabled;
  }

  /** 项目级开关写入（权限在控制器：ops.owner.assign，与项目时区一致） */
  async setEnabled(project: string, enabled: boolean, operator: string): Promise<{ enabled: boolean }> {
    await this.prisma.saProject.update({
      where: { name: project },
      data: { debug_archive_enabled: enabled },
    });
    this.switchCache.set(project, { enabled, at: Date.now() });
    await this.audit('meta_debug_archive_toggled', operator, { project, enabled });
    return { enabled };
  }

  /** 查询后落档；任何失败都降级为 `archived:false`，不阻断查询结果 */
  async archive(input: DebugArchiveInput): Promise<DebugArchiveOutcome> {
    const { project, user, query, result, durationMs } = input;
    try {
      if (!(await this.isEnabled(project))) {
        return { archived: false, archive_disabled: true };
      }
      const { rows, truncated } = buildSnapshotRows(result.items);
      const record = await this.prisma.metaDebugRecord.create({
        data: {
          project_name: project,
          created_by: user.id,
          created_by_name: user.display_name || user.username,
          window: result.window,
          cond_distinct_id: query.distinct_id ?? null,
          cond_user_key: query.user_key ?? null,
          cond_event: query.event ?? null,
          cond_limit: result.limit,
          matched_total: result.matched_total,
          row_count: rows.length,
          truncated,
          duration_ms: durationMs,
          rows: { create: rows },
        },
        select: { id: true },
      });
      return { archived: true, record_id: record.id, truncated };
    } catch (error) {
      this.logger.warn(
        `Debug 留档失败（project=${project}）: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { archived: false };
    }
  }

  async list(project: string, page = 1, pageSize = 20) {
    const take = Math.min(DEBUG_ARCHIVE_PAGE_SIZE_MAX, Math.max(1, pageSize));
    const safePage = Math.max(1, page);
    const where = { project_name: project, kind: DEBUG_KIND };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.metaDebugRecord.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (safePage - 1) * take,
        take,
        select: {
          id: true,
          created_at: true,
          created_by: true,
          created_by_name: true,
          window: true,
          cond_distinct_id: true,
          cond_user_key: true,
          cond_event: true,
          cond_limit: true,
          matched_total: true,
          row_count: true,
          truncated: true,
          duration_ms: true,
          status: true,
          error_code: true,
          started_at: true,
          finished_at: true,
        },
      }),
      this.prisma.metaDebugRecord.count({ where }),
    ]);
    return { items, total, page: safePage, pageSize: take };
  }

  async detail(project: string, id: string) {
    const record = await this.prisma.metaDebugRecord.findFirst({
      where: { id, project_name: project, kind: DEBUG_KIND },
      include: { rows: { orderBy: { seq: 'asc' } } },
    });
    if (!record) {
      throw notFound({
        code: 'meta.debug.recordNotFound',
        messageKey: 'meta:error.debug.recordNotFound',
      });
    }
    return record;
  }

  /**
   * 删除一条留档。权限（已定决议）：创建者本人 / 平台超管 / 持 `meta.edit` 的项目成员。
   * 删除写审计（`ops_action_log`，不带 auth_ 前缀，避免混进账号审计列表）。
   */
  async remove(project: string, id: string, user: AuthUser, iam: IamContext) {
    const record = await this.prisma.metaDebugRecord.findFirst({
      where: { id, project_name: project, kind: DEBUG_KIND },
      select: { id: true, created_by: true, cond_event: true, matched_total: true, row_count: true, window: true },
    });
    if (!record) {
      throw notFound({
        code: 'meta.debug.recordNotFound',
        messageKey: 'meta:error.debug.recordNotFound',
      });
    }
    const allowed =
      record.created_by === user.id || iam.platform_role === 'super_admin' || iam.permissions.has('meta.edit');
    if (!allowed) {
      throw forbidden({
        code: 'meta.debug.deleteForbidden',
        messageKey: 'meta:error.debug.deleteForbidden',
      });
    }
    await this.prisma.metaDebugRecord.delete({ where: { id: record.id } });
    await this.audit('meta_debug_record_deleted', user.username, {
      record_id: record.id,
      project,
      window: record.window,
      cond_event: record.cond_event,
      matched_total: record.matched_total,
      row_count: record.row_count,
    });
    return { deleted: true, record_id: record.id };
  }

  /**
   * 转后台：超预算的查询登记为 `pending` 任务。
   * 相同项目 + 相同条件 + 相同窗口 + 相同条数若已有待办/运行中任务，直接复用（防连点重复排队）。
   */
  async enqueue(input: EnqueueInput): Promise<{ record_id: string; reused: boolean }> {
    const { project, user, query, window, limit } = input;
    const duplicate = await this.prisma.metaDebugRecord.findFirst({
      where: {
        project_name: project,
        kind: DEBUG_KIND,
        status: { in: ['pending', 'running'] },
        window,
        cond_distinct_id: query.distinct_id ?? null,
        cond_user_key: query.user_key ?? null,
        cond_event: query.event ?? null,
        cond_limit: limit,
      },
      orderBy: { created_at: 'desc' },
      select: { id: true },
    });
    if (duplicate) return { record_id: duplicate.id, reused: true };

    const created = await this.prisma.metaDebugRecord.create({
      data: {
        project_name: project,
        created_by: user.id,
        created_by_name: user.display_name || user.username,
        window,
        cond_distinct_id: query.distinct_id ?? null,
        cond_user_key: query.user_key ?? null,
        cond_event: query.event ?? null,
        cond_limit: limit,
        matched_total: 0,
        row_count: 0,
        status: 'pending',
      },
      select: { id: true },
    });
    return { record_id: created.id, reused: false };
  }

  /** worker：认领一条待办。原子性靠 `status='pending'` 的条件更新（影响行数 1 才算认领成功） */
  async claimNextPending(): Promise<ClaimedDebugJob | null> {
    const candidate = await this.prisma.metaDebugRecord.findFirst({
      where: { status: 'pending', kind: DEBUG_KIND },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        project_name: true,
        created_by_name: true,
        created_at: true,
        window: true,
        cond_distinct_id: true,
        cond_user_key: true,
        cond_event: true,
        cond_limit: true,
      },
    });
    if (!candidate) return null;
    const claimed = await this.prisma.metaDebugRecord.updateMany({
      where: { id: candidate.id, status: 'pending' },
      data: { status: 'running', started_at: new Date() },
    });
    return claimed.count === 1 ? candidate : null;
  }

  /** worker：把结果写进这条留档（复用同一套体积上限与截断标记） */
  async finishJob(id: string, result: DebugQueryResult, durationMs: number) {
    const { rows, truncated } = buildSnapshotRows(result.items);
    await this.prisma.$transaction([
      this.prisma.metaDebugRecordRow.deleteMany({ where: { record_id: id } }),
      this.prisma.metaDebugRecord.update({
        where: { id },
        data: {
          status: 'done',
          matched_total: result.matched_total,
          row_count: rows.length,
          truncated,
          duration_ms: durationMs,
          finished_at: new Date(),
          error_code: null,
          rows: { create: rows },
        },
      }),
    ]);
    return { row_count: rows.length, truncated };
  }

  /** worker：失败留痕（错误码稳定，明细只进服务端日志） */
  async failJob(id: string, errorCode: string): Promise<void> {
    await this.prisma.metaDebugRecord.updateMany({
      where: { id, status: { in: ['pending', 'running'] } },
      data: { status: 'failed', error_code: errorCode, finished_at: new Date() },
    });
  }

  /** worker：回收卡死的 running（如进程被杀），判超时失败，避免永久占位 */
  async reclaimStale(before: Date): Promise<number> {
    const result = await this.prisma.metaDebugRecord.updateMany({
      where: { status: 'running', kind: DEBUG_KIND, started_at: { lt: before } },
      data: { status: 'failed', error_code: QUERY_JOB_ERROR_TIMEOUT, finished_at: new Date() },
    });
    return result.count;
  }

  /** 写失败只告警不阻断主流程（与账号域审计同策略） */
  private async audit(action: string, operator: string, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.prisma.opsActionLog.create({
        data: { action, target_table: 'metadebugrecord', detail: detail as object, status: 'done', operator },
      });
    } catch (error) {
      this.logger.warn(`Debug 留档审计写入失败 [${action}]: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
