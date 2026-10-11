import { Body, Controller, Get, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { isAdmin } from '../../common/utils/rbac.util';
import { forbidden } from '../../i18n/domain-error';
import type { AuthUser } from '../auth/auth.service';
import { QualityService } from './quality.service';
import { SaveReconcileConfigDto } from './dto/reconcile-config.dto';
import { respondWithKeepalive } from '../long-response/query-keepalive';

import { RequirePermission } from '../iam/require-permission';

// 接口权限保持 rbac-v3 既定：类级 `meta.view`（分析师不持，故 RB3-3 拒止成立），
// 写接口另需 `ops.runtime.access` + isAdmin。页面入口在 quality-ops-ia-v1 已迁到运维层，
// 但**接口权限不随页面收紧**——那会改变另一 phase 已批准的设计（meta-picker-permission.spec 锁着）。
@Controller('sa/api/meta/quality')
@RequirePermission('meta.view')
export class QualityController {
  constructor(private readonly service: QualityService) {}

  /**
   * 数据一致性对拍报告
   * GET /sa/api/meta/quality/reconcile?from=YYYY-MM-DD&to=YYYY-MM-DD&threshold=0.1
   */
  @Get('reconcile')
  async reconcile(
    @CurrentProject() project: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('threshold') threshold: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // 对拍要跨天扫全量，实测可达 200 秒，走心跳保活（见 long-response/query-keepalive.ts）
    await respondWithKeepalive(res, 200, () =>
      this.service.reconcile({
        project,
        from,
        to,
        threshold: threshold ? parseFloat(threshold) : undefined,
      }),
    );
  }

  /**
   * 对拍配置（页面展示；写入仅限平台超管）
   * GET/PUT /sa/api/meta/quality/config
   */
  @Get('config')
  async config() {
    return this.service.configView();
  }

  @Put('config')
  @RequirePermission('ops.runtime.access')
  async saveConfig(@CurrentUser() user: AuthUser, @Body() dto: SaveReconcileConfigDto) {
    if (!isAdmin(user)) {
      throw forbidden({
        code: 'ops.reconcile.forbidden',
        messageKey: 'ops:error.reconcile.forbidden',
        message: '仅平台超管可修改对拍配置',
      });
    }
    return this.service.saveConfig(dto, user.username);
  }

  /**
   * 数据质量概览（预留，后续扩展字段级质量问题）
   * GET /sa/api/meta/quality/report
   */
  @Get('report')
  async report(@CurrentProject() project: string) {
    return this.service.report(project);
  }

  /**
   * 元数据自动发现变化记录（新增事件/属性/类型变更）
   * GET /sa/api/meta/quality/discovery-logs?limit=50
   */
  @Get('discovery-logs')
  async discoveryLogs(
    @CurrentProject() project: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getDiscoveryLog(project, limit ? parseInt(limit, 10) : 50);
  }

  /**
   * 最近一次对拍快照（秒开缓存）。
   * 页面默认加载快照并标注对拍时间；「开始对拍」按钮才触发重查询。
   * GET /sa/api/meta/quality/snapshot
   */
  @Get('snapshot')
  async snapshot(@CurrentProject() project: string) {
    return this.service.latestSnapshot(project);
  }
}
