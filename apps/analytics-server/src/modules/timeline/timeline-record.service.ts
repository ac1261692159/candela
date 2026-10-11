import { Injectable, Logger } from '@nestjs/common';
import { forbidden, notFound } from '../../i18n/domain-error';
import { PrismaService } from '../shared/prisma.service';
import type { AuthUser } from '../auth/auth.service';
import type { IamContext } from '../iam/iam.types';
import { buildSnapshotRows } from '../query-job/query-job.rows';
import { QUERY_JOB_ERROR_TIMEOUT } from '../query-job/query-job.policy';
import {
  TIMELINE_MAX_ROWS,
  type UserTimelineOverview,
  type UserTimelineRow,
  type UserTimelineSpec,
  type UserTimelineSummary,
} from './timeline.service';

/** 时间线的记录种类（与记录表 kind 列一致） */
export const TIMELINE_KIND = 'user_timeline';
const PAGE_SIZE_MAX = 100;

export interface TimelineJobPayload {
  id: string;
  project_name: string;
  created_at: Date;
  spec: UserTimelineSpec;
}

export interface TimelineOutcome {
  archived: boolean;
  record_id?: string;
  truncated?: boolean;
  archive_disabled?: boolean;
}

/**
 * 用户行为序列的记录读写（kind = `user_timeline`）。
 *
 * 复用 Debug 的查询记录表（状态机/回收/前端状态列同构），但**本 kind 的写入只有这一个服务**；
 * 规格与汇总分别落在 `spec_json` / `summary_json`。
 */
@Injectable()
export class TimelineRecordService {
  private readonly logger = new Logger(TimelineRecordService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 快路径：查询成功即落一条 done 记录（写失败只降级，不影响结果返回） */
  async archiveSuccess(input: {
    project: string;
    user: AuthUser;
    spec: UserTimelineSpec;
    summary: UserTimelineSummary;
    /** 行为概览（每日趋势/事件占比），随快照一起回看 */
    overview?: UserTimelineOverview;
    items: UserTimelineRow[];
    durationMs: number;
  }): Promise<TimelineOutcome> {
    const { project, user, spec, summary, overview, items, durationMs } = input;
    try {
      const { rows, truncated } = buildSnapshotRows(items, { maxRows: TIMELINE_MAX_ROWS });
      const record = await this.prisma.metaDebugRecord.create({
        data: {
          project_name: project,
          created_by: user.id,
          created_by_name: user.display_name || user.username,
          kind: TIMELINE_KIND,
          spec_json: JSON.stringify(spec),
          summary_json: JSON.stringify({ ...summary, truncated: truncated || summary.truncated, ...(overview ? { overview } : {}) }),
          window: null,
          cond_limit: spec.limit,
          matched_total: summary.matched_total,
          row_count: rows.length,
          truncated: truncated || summary.truncated,
          duration_ms: durationMs,
          status: 'done',
          started_at: new Date(Date.now() - durationMs),
          finished_at: new Date(),
          rows: { create: rows },
        },
        select: { id: true },
      });
      return { archived: true, record_id: record.id, truncated: truncated || summary.truncated };
    } catch (error) {
      this.logger.warn(
        `行为序列留档失败（project=${project}）: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { archived: false };
    }
  }

  /** 转后台：同项目 + 同规格的待办/运行中任务复用（防连点） */
  async enqueue(input: { project: string; user: AuthUser; spec: UserTimelineSpec }): Promise<{ record_id: string; reused: boolean }> {
    const { project, user, spec } = input;
    const specJson = JSON.stringify(spec);
    const duplicate = await this.prisma.metaDebugRecord.findFirst({
      where: { project_name: project, kind: TIMELINE_KIND, status: { in: ['pending', 'running'] }, spec_json: specJson },
      orderBy: { created_at: 'desc' },
      select: { id: true },
    });
    if (duplicate) return { record_id: duplicate.id, reused: true };

    const created = await this.prisma.metaDebugRecord.create({
      data: {
        project_name: project,
        created_by: user.id,
        created_by_name: user.display_name || user.username,
        kind: TIMELINE_KIND,
        spec_json: specJson,
        window: null,
        cond_limit: spec.limit,
        matched_total: 0,
        row_count: 0,
        status: 'pending',
      },
      select: { id: true },
    });
    return { record_id: created.id, reused: false };
  }

  /** worker：认领（原子） */
  async claimNext(): Promise<TimelineJobPayload | null> {
    const candidate = await this.prisma.metaDebugRecord.findFirst({
      where: { kind: TIMELINE_KIND, status: 'pending' },
      orderBy: { created_at: 'asc' },
      select: { id: true, project_name: true, created_at: true, spec_json: true },
    });
    if (!candidate?.spec_json) return null;
    const claimed = await this.prisma.metaDebugRecord.updateMany({
      where: { id: candidate.id, status: 'pending' },
      data: { status: 'running', started_at: new Date() },
    });
    if (claimed.count !== 1) return null;
    return {
      id: candidate.id,
      project_name: candidate.project_name,
      created_at: candidate.created_at,
      spec: JSON.parse(candidate.spec_json) as UserTimelineSpec,
    };
  }

  /** worker：落结果 */
  async finishJob(
    id: string,
    summary: UserTimelineSummary,
    items: UserTimelineRow[],
    durationMs: number,
    overview?: UserTimelineOverview,
  ) {
    const { rows, truncated } = buildSnapshotRows(items, { maxRows: TIMELINE_MAX_ROWS });
    const isTruncated = truncated || summary.truncated;
    await this.prisma.$transaction([
      this.prisma.metaDebugRecordRow.deleteMany({ where: { record_id: id } }),
      this.prisma.metaDebugRecord.update({
        where: { id },
        data: {
          status: 'done',
          matched_total: summary.matched_total,
          row_count: rows.length,
          truncated: isTruncated,
          duration_ms: durationMs,
          finished_at: new Date(),
          error_code: null,
          summary_json: JSON.stringify({ ...summary, truncated: isTruncated, ...(overview ? { overview } : {}) }),
          rows: { create: rows },
        },
      }),
    ]);
    return { row_count: rows.length, truncated: isTruncated };
  }

  async failJob(id: string, errorCode: string): Promise<void> {
    await this.prisma.metaDebugRecord.updateMany({
      where: { id, kind: TIMELINE_KIND, status: { in: ['pending', 'running'] } },
      data: { status: 'failed', error_code: errorCode, finished_at: new Date() },
    });
  }

  async reclaimStale(before: Date): Promise<number> {
    const result = await this.prisma.metaDebugRecord.updateMany({
      where: { kind: TIMELINE_KIND, status: 'running', started_at: { lt: before } },
      data: { status: 'failed', error_code: QUERY_JOB_ERROR_TIMEOUT, finished_at: new Date() },
    });
    return result.count;
  }

  async list(project: string, page = 1, pageSize = 20) {
    const take = Math.min(PAGE_SIZE_MAX, Math.max(1, pageSize));
    const safePage = Math.max(1, page);
    const where = { project_name: project, kind: TIMELINE_KIND };
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
          spec_json: true,
          summary_json: true,
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
      where: { id, project_name: project, kind: TIMELINE_KIND },
      include: { rows: { orderBy: { seq: 'asc' } } },
    });
    if (!record) {
      throw notFound({ code: 'timeline.recordNotFound', messageKey: 'analysis:error.timeline.recordNotFound' });
    }
    return record;
  }

  /** 删除：创建者 / 超管 / 持 meta.edit 的项目成员（沿用 Debug 记录的既有规则） */
  async remove(project: string, id: string, user: AuthUser, iam: IamContext) {
    const record = await this.prisma.metaDebugRecord.findFirst({
      where: { id, project_name: project, kind: TIMELINE_KIND },
      select: { id: true, created_by: true, matched_total: true, row_count: true, spec_json: true },
    });
    if (!record) {
      throw notFound({ code: 'timeline.recordNotFound', messageKey: 'analysis:error.timeline.recordNotFound' });
    }
    const allowed =
      record.created_by === user.id || iam.platform_role === 'super_admin' || iam.permissions.has('meta.edit');
    if (!allowed) {
      throw forbidden({ code: 'timeline.deleteForbidden', messageKey: 'analysis:error.timeline.deleteForbidden' });
    }
    await this.prisma.metaDebugRecord.delete({ where: { id: record.id } });
    return { deleted: true, record_id: record.id };
  }
}
