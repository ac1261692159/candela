import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { isAdmin } from '../../common/utils/rbac.util';
import { forbidden } from '../../i18n/domain-error';
import type { AuthUser } from '../auth/auth.service';
import { AllowWithoutMembership, RequirePermission } from '../iam/require-permission';
import { ServerStatusService } from './server-status.service';
import { LogCleanupService } from './log-cleanup.service';
import { DiskTrendDto } from './dto/alert.dto';

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
 * 运维面板 · 服务器状态（phase: clklog-analytics-ops-console-v1）。
 * 只读聚合：主机（/proc + statfs，无 shell）+ ClickHouse 依赖 + 数据量。
 * 权限同慢 SQL：权限码 + isAdmin 双闸。
 * V1.1：+ 日志目录治理（配置/预演/手动执行——写动作仅审计表与日志文件本身）。
 */
@Controller('sa/api/ops')
export class ServerStatusController {
  constructor(
    private readonly service: ServerStatusService,
    private readonly logCleanup: LogCleanupService,
  ) {}

  @Get('server-status')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async status(@CurrentUser() user: AuthUser) {
    assertOpsAdmin(user);
    return this.service.status();
  }

  /** 磁盘用量采样历史（切片 3 + 多目录扩展：path 可选白名单目录，只读） */
  @Get('disk-trend')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async diskTrend(@Query() query: DiskTrendDto, @CurrentUser() user: AuthUser) {
    assertOpsAdmin(user);
    return this.service.diskTrend(query.hours ?? 168, query.path);
  }

  /** 日志目录治理：配置列表（含实时用量，只读） */
  @Get('log-cleanup')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async logConfigs(@CurrentUser() user: AuthUser) {
    assertOpsAdmin(user);
    return this.logCleanup.listConfigs();
  }

  /** 日志清理预演（只读） */
  @Get('log-cleanup/preview')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async logPreview(@CurrentUser() user: AuthUser, @Query('path') path?: string) {
    assertOpsAdmin(user);
    if (!path) {
      throw forbidden({
        code: 'ops.logCleanup.pathRequired',
        messageKey: 'ops:error.logCleanup.pathRequired',
        message: 'path 必填',
      });
    }
    return this.logCleanup.preview(path);
  }

  /** 手动执行一次日志清理（动作类：写 ops_action_log 审计） */
  @Post('log-cleanup/execute')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async logExecute(@CurrentUser() user: AuthUser, @Body() body: { path?: string }) {
    assertOpsAdmin(user);
    if (!body.path) {
      throw forbidden({
        code: 'ops.logCleanup.pathRequired',
        messageKey: 'ops:error.logCleanup.pathRequired',
        message: 'path 必填',
      });
    }
    return this.logCleanup.execute(body.path, user.username);
  }

  /** 更新目录治理配置（保留天数 / 自动清理开关） */
  @Post('log-cleanup/config')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async logConfigUpdate(
    @CurrentUser() user: AuthUser,
    @Body() body: { path?: string; retain_days?: number; enabled?: boolean },
  ) {
    assertOpsAdmin(user);
    if (!body.path) {
      throw forbidden({
        code: 'ops.logCleanup.pathRequired',
        messageKey: 'ops:error.logCleanup.pathRequired',
        message: 'path 必填',
      });
    }
    return this.logCleanup.updateConfig(body.path, {
      retain_days: body.retain_days,
      enabled: body.enabled,
    });
  }
}
