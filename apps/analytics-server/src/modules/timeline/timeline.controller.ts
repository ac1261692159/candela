import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { DomainError } from '../../i18n/domain-error';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/auth.service';
import { CurrentIam } from '../iam/current-iam.decorator';
import type { IamContext } from '../iam/iam.types';
import { RequirePermission } from '../iam/require-permission';
import { DebugArchiveService } from '../meta/debug-archive.service';
import { QUERY_JOB_SYNC_BUDGET_S } from '../query-job/query-job.policy';
import { UserTimelineNeighborsDto, UserTimelineQueryDto } from './dto/user-timeline.dto';
import { TimelineRecordService } from './timeline-record.service';
import { TimelineService } from './timeline.service';

/**
 * 用户行为序列（phase: clklog-analytics-user-timeline-v1）：
 * 按分析主体 + 用户标识 + 起止时间，列该用户的全部上报事件（行为分析用）。
 *
 * 权限：`timeline.view`（数据分析师 / 分析管理员 / 项目 owner；超管由平台角色全权），项目隔离。
 * 两段式：快路径同步返回；超预算转后台（复用异步查询管道），完成后前端轮询记录就地渲染。
 */
@Controller('sa/api/analysis/user-timeline')
@RequirePermission('timeline.view')
export class TimelineController {
  constructor(
    private readonly service: TimelineService,
    private readonly records: TimelineRecordService,
    /** 项目级留档开关（与 Debug 共用同一开关：关了就不留痕，超预算也不转后台） */
    private readonly archiveSwitch: DebugArchiveService,
  ) {}

  @Post('query')
  async query(@CurrentProject() project: string, @CurrentUser() user: AuthUser, @Body() dto: UserTimelineQueryDto) {
    const spec = this.service.normalize(dto);
    const startedAt = Date.now();

    // 概览先行：聚合查询（不读 properties）先跑，明细超预算转后台时它已经能返回
    const overview = await this.service.overview(spec, project);
    try {
      const { items, summary } = await this.service.query(spec, project, {
        maxExecutionTime: QUERY_JOB_SYNC_BUDGET_S,
      });
      const enabled = await this.archiveSwitch.isEnabled(project);
      const outcome = enabled
        ? await this.records.archiveSuccess({
            project,
            user,
            spec,
            summary,
            overview,
            items,
            durationMs: Date.now() - startedAt,
          })
        : { archived: false, archive_disabled: true };
      return { overview, items, ...summary, from: spec.from, to: spec.to, order: spec.order, ...outcome };
    } catch (error) {
      if (error instanceof DomainError && error.errorCode === 'timeline.queryTimeout') {
        // 关闭留档时不转后台：任务本身就是一条记录，关了就不该留下任何痕迹
        if (!(await this.archiveSwitch.isEnabled(project))) throw error;
        const job = await this.records.enqueue({ project, user, spec });
        return { overview, status: 'running', record_id: job.record_id, reused: job.reused, from: spec.from, to: spec.to };
      }
      throw error;
    }
  }

  /** 查看前后行为：以某条事件为锚取前后各 N 条（窗口沿用当前查询区间；不落档、不产生记录） */
  @Post('neighbors')
  async neighbors(@CurrentProject() project: string, @Body() body: UserTimelineNeighborsDto) {
    const spec = { ...this.service.normalize(body as never), anchor: body.anchor, limit: body.limit ?? 10 };
    return this.service.neighbors(spec, project, { maxExecutionTime: QUERY_JOB_SYNC_BUDGET_S });
  }

  /** 用户画像：用户属性 + 标签最新值（支持按用户属性定位，并回报解析到的标识；失败降级为空，不阻断页面） */
  @Get('profile')
  profile(
    @CurrentProject() project: string,
    @Query('value') value?: string,
    @Query('id_kind') idKind?: string,
    @Query('id_key') idKey?: string,
  ) {
    return this.service.profile({ value: value ?? '', id_kind: idKind, id_key: idKey }, project);
  }

  @Get('records')
  list(@CurrentProject() project: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.records.list(project, parseIntOr(page, 1), parseIntOr(pageSize, 20));
  }

  @Get('records/:id')
  detail(@CurrentProject() project: string, @Param('id') id: string) {
    return this.records.detail(project, id);
  }

  @Delete('records/:id')
  remove(
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Param('id') id: string,
  ) {
    return this.records.remove(project, id, user, iam);
  }
}

function parseIntOr(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isNaN(value) ? fallback : value;
}
