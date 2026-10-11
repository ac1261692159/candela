import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { badRequest, DomainError } from '../../i18n/domain-error';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/auth.service';
import { CurrentIam } from '../iam/current-iam.decorator';
import type { IamContext } from '../iam/iam.types';
import { DebugArchiveService } from './debug-archive.service';
import { DebugService, type DebugQueryResult } from './debug.service';
import { QUERY_JOB_SYNC_BUDGET_S } from '../query-job/query-job.policy';
import { DebugArchiveToggleDto, DebugQueryDto } from './dto/debug-query.dto';

import { RequirePermission } from '../iam/require-permission';

@Controller('sa/api/meta/debug')
@RequirePermission('meta.view')
export class DebugController {
  constructor(
    private readonly service: DebugService,
    private readonly archive: DebugArchiveService,
  ) {}

  /**
   * 只查不留档（外部调用 / AI 工具用）。列表接口统一 `{ items }` 契约
   * （勿返回裸数组，见 HANDOVER §11.2 接口契约坑）+ 命中总数 `matched_total`。
   */
  @Get('recent')
  async recent(
    @CurrentProject() project: string,
    @Query('distinct_id') distinctId?: string,
    @Query('user_key') userKey?: string,
    @Query('event') event?: string,
    @Query('window') window?: string,
    @Query('limit') limit?: string,
  ) {
    this.assertCondition(distinctId, userKey, event);
    const result = await this.service.recent(
      { distinct_id: distinctId, user_key: userKey, event, window, limit: parseLimit(limit) },
      project,
    );
    return { items: result.items, matched_total: result.matched_total, window: result.window, limit: result.limit };
  }

  /**
   * 查询 + 留档（前端主路径），**两段式**：
   * ① 快路径：带短预算同步跑，成功即落档并返回结果（与既有契约一致）；
   * ② 超预算（CH 超时）→ 登记后台任务并立即返回 `{ status: 'running', record_id }`，
   *    前端轮询 `GET /records/:id`，完成后就地渲染；留档失败仍不影响结果。
   */
  @Post('query')
  async query(@CurrentProject() project: string, @CurrentUser() user: AuthUser, @Body() dto: DebugQueryDto) {
    this.assertCondition(dto.distinct_id, dto.user_key, dto.event);
    const window = this.service.normalizeWindow(dto.window);
    const limit = this.service.normalizeLimit(dto.limit);
    const startedAt = Date.now();

    let result: DebugQueryResult;
    try {
      result = await this.service.recent(dto, project, startedAt, { maxExecutionTime: QUERY_JOB_SYNC_BUDGET_S });
    } catch (error) {
      if (error instanceof DomainError && error.errorCode === 'meta.debug.queryTimeout') {
        // 项目关闭留档时不转后台：任务本身就是一条留档，关了就不该留下任何痕迹（PRD F2），
        // 如实把超时抛给前端（文案提示缩小时间范围）。
        if (!(await this.archive.isEnabled(project))) throw error;
        const job = await this.archive.enqueue({ project, user, query: dto, window, limit });
        return { status: 'running', record_id: job.record_id, reused: job.reused, window, limit };
      }
      throw error;
    }

    const outcome = await this.archive.archive({
      project,
      user,
      query: dto,
      result,
      durationMs: Date.now() - startedAt,
    });
    return {
      items: result.items,
      matched_total: result.matched_total,
      window: result.window,
      limit: result.limit,
      ...outcome,
    };
  }

  @Get('records')
  async list(@CurrentProject() project: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.archive.list(project, parseIntOr(page, 1), parseIntOr(pageSize, 20));
  }

  @Get('records/:id')
  detail(@CurrentProject() project: string, @Param('id') id: string) {
    return this.archive.detail(project, id);
  }

  @Delete('records/:id')
  remove(@CurrentProject() project: string, @CurrentUser() user: AuthUser, @CurrentIam() iam: IamContext, @Param('id') id: string) {
    return this.archive.remove(project, id, user, iam);
  }

  /** 项目级留档开关状态（写接口见下方 PUT，权限 ops.owner.assign）；前端据此显示与提示 */
  @Get('archive-setting')
  async archiveSetting(@CurrentProject() project: string) {
    return { enabled: await this.archive.isEnabled(project) };
  }

  /** 项目级留档开关写入（F2）：权限与项目时区设置对齐（运维/超管） */
  @Put('archive-setting')
  @RequirePermission('ops.owner.assign')
  setArchiveSetting(
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: DebugArchiveToggleDto,
  ) {
    return this.archive.setEnabled(project, dto.enabled, user.username);
  }

  private assertCondition(distinctId?: string, userKey?: string, event?: string) {
    if (!distinctId && !userKey && !event) {
      throw badRequest({
        code: 'meta.debug.conditionRequired',
        messageKey: 'meta:error.debug.conditionRequired',
        message: '至少传入 distinct_id、user_key 或 event 中的一个',
      });
    }
  }
}

/** limit 只接受整数（含负号，越界由 service 收敛）；`abc` / `1.5` 这类非法值一律 400 */
function parseLimit(raw?: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    throw badRequest({ code: 'meta.debug.invalidLimit', messageKey: 'meta:error.debug.invalidLimit' });
  }
  return Number.parseInt(raw, 10);
}

function parseIntOr(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isNaN(value) ? fallback : value;
}
