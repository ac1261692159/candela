import { Controller, Get, Optional, Post, Put, Query, Body, Param } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { isAdmin } from '../../common/utils/rbac.util';
import { badRequest, forbidden } from '../../i18n/domain-error';
import type { AuthUser } from '../auth/auth.service';
import { AllowWithoutMembership, RequirePermission } from '../iam/require-permission';
import { DataMgmtService } from './data-mgmt.service';
import { DataDeleteService } from './data-delete.service';
import { MetaReconcileService } from './meta-reconcile.service';
import { ProjectRetireService } from './project-retire.service';
import type { DeleteKind } from './cleanup-plan';
import { TimezoneService } from '../time/timezone.service';
import { todayInTz } from '../time/calendar';

function assertOpsAdmin(user: AuthUser): void {
  if (!isAdmin(user)) {
    throw forbidden({
      code: 'ops.admin.forbidden',
      messageKey: 'ops:error.admin.forbidden',
      message: '仅平台超管可访问运维面板',
    });
  }
}

/**
 * 数据管理（phase: clklog-analytics-data-management-v1）。
 * 仅超管；读路径（概览/趋势/健康/预演）与写路径（清理执行/TTL/保留策略登记）都在本控制器，
 * 写路径一律走审计流（二次确认 + 前置对拍 + 审计 + 清理登记，见 quality-ops-v1）。
 *
 * 两层拦截与运维面板其余接口一致：第一道 `ops.runtime.access`（项目管理员不持有），
 * 第二道 handler 内的 `assertOpsAdmin` 身份兜底（见 slow-query.controller 注释）。
 */
@Controller('sa/api/ops/data-mgmt')
@RequirePermission('ops.runtime.access')
@AllowWithoutMembership()
export class DataMgmtController {
  constructor(
    private readonly service: DataMgmtService,
    private readonly dataDelete: DataDeleteService,
    private readonly metaReconcile: MetaReconcileService,
    private readonly projectRetire: ProjectRetireService = undefined as unknown as ProjectRetireService,
    @Optional() private readonly timezones: TimezoneService = undefined as unknown as TimezoneService,
  ) {}

  @Get('overview')
  async overview(@CurrentUser() user: AuthUser) {
    assertOpsAdmin(user);
    return this.service.overview();
  }

  @Get('trend')
  async trend(@CurrentUser() user: AuthUser, @Query('hours') hours?: string) {
    assertOpsAdmin(user);
    const h = hours ? parseInt(hours, 10) : 24 * 30;
    if (!Number.isFinite(h)) {
      throw badRequest({
        code: 'ops.trend.hoursInvalid',
        messageKey: 'ops:error.trend.hoursInvalid',
        message: 'hours 须为数字',
      });
    }
    return this.service.trend(h);
  }

  /** 清理预演：只读，返回将被 DROP PARTITION 影响的分区清单 */
  @Post('cleanup/preview')
  async preview(
    @CurrentUser() user: AuthUser,
    @Body() body: { table?: string; older_than_days?: number },
  ) {
    assertOpsAdmin(user);
    if (!body.table || !body.older_than_days) {
      throw badRequest({
        code: 'ops.cleanup.previewParamsRequired',
        messageKey: 'ops:error.cleanup.previewParamsRequired',
        message: 'table 与 older_than_days 必填',
      });
    }
    return this.service.previewCleanup(body.table, Number(body.older_than_days));
  }

  /** 对拍快照（最新一次），无快照返回 null */
  @Get('health')
  async health(@CurrentUser() user: AuthUser, @CurrentProject() project: string) {
    assertOpsAdmin(user);
    return this.service.latestSnapshot(project);
  }

  // ---------- V1.1 清理执行（动作类：二次确认 + 审计）----------

  /** 执行 DROP PARTITION：confirmed_table 必须与 table 一致（前端输入表名确认） */
  @Post('cleanup/execute')
  async executeDrop(
    @CurrentUser() user: AuthUser,
    @Body() body: {
      table?: string;
      partitions?: string[];
      confirmed_table?: string;
      dry_run_snapshot?: unknown;
    },
  ) {
    assertOpsAdmin(user);
    if (!body.table || !Array.isArray(body.partitions) || !body.confirmed_table) {
      throw badRequest({
        code: 'ops.cleanup.executeParamsRequired',
        messageKey: 'ops:error.cleanup.executeParamsRequired',
        message: 'table / partitions / confirmed_table 必填',
      });
    }
    if (body.partitions.length > 60) {
      throw badRequest({
        code: 'ops.cleanup.tooManyPartitions',
        messageKey: 'ops:error.cleanup.tooManyPartitions',
        params: { max: 60 },
        message: '单次最多 60 个分区（分批执行，降低 IO 峰值）',
      });
    }
    return this.service.executeDropPartitions({
      table: body.table,
      partitions: body.partitions.map(String),
      confirmed_table: body.confirmed_table,
      dry_run_snapshot: body.dry_run_snapshot ?? null,
      operator: user.username,
    });
  }

  /** 设置 TTL：confirmed_table 必须与 table 一致 */
  @Post('ttl')
  async setTtl(
    @CurrentUser() user: AuthUser,
    @Body() body: { table?: string; days?: number; confirmed_table?: string },
  ) {
    assertOpsAdmin(user);
    if (!body.table || !body.days || !body.confirmed_table) {
      throw badRequest({
        code: 'ops.ttl.paramsRequired',
        messageKey: 'ops:error.ttl.paramsRequired',
        message: 'table / days / confirmed_table 必填',
      });
    }
    return this.service.executeSetTtl({
      table: body.table,
      days: Number(body.days),
      confirmed_table: body.confirmed_table,
      operator: user.username,
    });
  }

  // ---------- V1.2 保留策略（R2：预期 × 实际 × 可信区间）----------

  /** 保留策略总览：预期（登记/默认建议） × 实际 TTL × 状态 × 对拍可信区间 */
  @Get('retention')
  async retention(@CurrentUser() user: AuthUser) {
    assertOpsAdmin(user);
    return this.service.retentionOverview();
  }

  /** 登记预期保留（审计 retention_policy_update） */
  @Put('retention/:db/:table')
  async saveRetention(
    @CurrentUser() user: AuthUser,
    @Param('db') db: string,
    @Param('table') table: string,
    @Body() body: { keep_days?: number; mode?: string; enabled?: boolean; remark?: string | null },
  ) {
    assertOpsAdmin(user);
    if (!Number.isFinite(Number(body.keep_days))) {
      throw badRequest({
        code: 'ops.retention.keepDaysRequired',
        messageKey: 'ops:error.retention.keepDaysRequired',
        message: 'keep_days 必填',
      });
    }
    return this.service.upsertRetentionPolicy(
      {
        db,
        table,
        keep_days: Number(body.keep_days),
        mode: body.mode,
        enabled: body.enabled,
        remark: body.remark ?? null,
      },
      user.username,
    );
  }

  // ---------- V1.2 定点删除（ALTER DELETE；条件白名单，无任意 SQL）----------

  /** 预演：影响行数 + 日期范围 + 样例 + 前置对拍结论（只读） */
  @Post('delete/preview')
  async deletePreview(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      kind?: DeleteKind;
      table?: string;
      project?: string;
      event?: string;
      from?: string;
      to?: string;
      before?: string;
    },
  ) {
    assertOpsAdmin(user);
    if (!body.kind || !body.table || !body.project) {
      throw badRequest({
        code: 'ops.dataDelete.paramsRequired',
        messageKey: 'ops:error.dataDelete.paramsRequired',
        message: 'kind / table / project 必填',
      });
    }
    return this.dataDelete.preview({
      kind: body.kind,
      table: body.table,
      project: body.project,
      event: body.event,
      from: body.from,
      to: body.to,
      before: body.before,
    });
  }

  /** 执行删除：需 confirm_table + confirm_token（预演签发，5 分钟有效） */
  @Post('delete/execute')
  async deleteExecute(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      kind?: DeleteKind;
      table?: string;
      project?: string;
      event?: string;
      from?: string;
      to?: string;
      before?: string;
      confirm_table?: string;
      confirm_token?: string;
    },
  ) {
    assertOpsAdmin(user);
    if (!body.kind || !body.table || !body.project || !body.confirm_table || !body.confirm_token) {
      throw badRequest({
        code: 'ops.dataDelete.executeParamsRequired',
        messageKey: 'ops:error.dataDelete.executeParamsRequired',
        message: 'kind / table / project / confirm_table / confirm_token 必填',
      });
    }
    return this.dataDelete.execute({
      kind: body.kind,
      table: body.table,
      project: body.project,
      event: body.event,
      from: body.from,
      to: body.to,
      before: body.before,
      confirm_table: body.confirm_table,
      confirm_token: body.confirm_token,
      operator: user.username,
    });
  }

  // ---------- V1.2 项目退役预演（R4-b 第一步，只读）----------

  /** 项目退役预演：sa 5 张 + MySQL 31 张表的影响面 + 最近 24h 是否仍在写入 + 社区版提示 */
  @Post('project-retire/preview')
  async projectRetirePreview(@CurrentUser() user: AuthUser, @Body() body: { project?: string }) {
    assertOpsAdmin(user);
    if (!body.project) {
      throw badRequest({
        code: 'ops.projectRetire.projectRequired',
        messageKey: 'ops:error.projectRetire.projectRequired',
        message: 'project 必填',
      });
    }
    return this.projectRetire.preview(body.project);
  }

  /** 取退役执行的确认 token（绑定项目名 + 影响面，5 分钟有效） */
  @Post('project-retire/token')
  async projectRetireToken(@CurrentUser() user: AuthUser, @Body() body: { project?: string }) {
    assertOpsAdmin(user);
    if (!body.project) {
      throw badRequest({
        code: 'ops.projectRetire.projectRequired',
        messageKey: 'ops:error.projectRetire.projectRequired',
        message: 'project 必填',
      });
    }
    return this.projectRetire.signExecuteToken(body.project);
  }

  /** 执行退役的一步：step=sa（成员表 DROP PARTITION + 其余 ALTER DELETE）或 step=mysql（导出后逐表删） */
  @Post('project-retire/execute')
  async projectRetireExecute(
    @CurrentUser() user: AuthUser,
    @Body() body: { project?: string; step?: 'sa' | 'mysql'; confirm_token?: string },
  ) {
    assertOpsAdmin(user);
    if (!body.project || !body.step || !body.confirm_token) {
      throw badRequest({
        code: 'ops.projectRetire.executeParamsRequired',
        messageKey: 'ops:error.projectRetire.executeParamsRequired',
        message: 'project / step / confirm_token 必填',
      });
    }
    return this.projectRetire.execute({
      project: body.project,
      step: body.step,
      confirm_token: body.confirm_token,
      operator: user.username,
    });
  }

  // ---------- V1.2 数据 ↔ 元数据对账（R4-c）----------

  /**
   * 未登记事件（数据里有、元数据没有）与幽灵登记（元数据有、数据没有）。
   * 解决：「以前上报的测试事件在 ClickHouse 里，但平台看不到」。
   */
  @Get('unregistered-events')
  async unregisteredEvents(
    @CurrentUser() user: AuthUser,
    @Query('project') project?: string | string[],
    @Query('window_days') windowDays?: string | string[],
    @Query('limit') limit?: string,
  ) {
    assertOpsAdmin(user);
    const tz = (this.timezones ?? new TimezoneService(undefined)).platformTz;
    const today = todayInTz(tz);
    // 重复的 query 参数（?project=a&project=a）在 Nest 里会变成数组；取第一个，避免拼成 "a,a"
    const projectArg = (Array.isArray(project) ? project[0] : project) || 'clklogapp';
    const windowArg = Array.isArray(windowDays) ? windowDays[0] : windowDays;
    return this.metaReconcile.unregisteredEvents(projectArg, {
      windowDays: windowArg ? parseInt(windowArg, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      today,
    });
  }

  /** 审计记录（最近优先） */
  @Get('actions')
  async listActions(
    @CurrentUser() user: AuthUser,
    @Query('table') table?: string,
    @Query('limit') limit?: string,
  ) {
    assertOpsAdmin(user);
    return this.service.listActions(table || undefined, limit ? parseInt(limit, 10) : 20);
  }

  /** mutation 进度（TTL/DELETE 后台任务） */
  @Get('mutations')
  async mutations(@CurrentUser() user: AuthUser, @Query('table') table?: string) {
    assertOpsAdmin(user);
    if (!table) {
      throw badRequest({
        code: 'ops.mutation.tableRequired',
        messageKey: 'ops:error.mutation.tableRequired',
        message: 'table 必填',
      });
    }
    return this.service.mutationStatus(table);
  }
}
