import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/auth.service';
import { CohortService } from './cohort.service';
import { CreateCohortDto, CreateResultCohortDto, PreviewConditionCohortDto, PreviewResultCohortDto, PreviewSqlCohortDto, ReplaceCohortMembersDto, UpdateCohortDto } from './dto/cohort.dto';

import { RequirePermission } from '../iam/require-permission';
import { CurrentIam } from '../iam/current-iam.decorator';
import type { IamContext } from '../iam/iam.types';
import { AssetPolicyService } from '../iam/asset-policy.service';

@Controller('sa/api/meta/cohorts')
@RequirePermission('cohort.view')
export class CohortController {
  constructor(
    private readonly service: CohortService,
    private readonly policy: AssetPolicyService,
  ) {}

  @Get('template.csv')
  template() {
    return this.service.templateCsv();
  }

  @Get()
  async list(
    @CurrentProject() project: string,
    @Query('keyword') keyword?: string,
    @Query('status') status?: string,
    @Query('subject_id') subjectId?: string,
  ) {
    const items = await this.service.list(project, keyword, status, subjectId);
    return { items, total: items.length, page: 1, pageSize: items.length || 20 };
  }

  @Post('from-result')
  @RequirePermission('cohort.edit_own')
  fromResult(
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateResultCohortDto,
  ) {
    return this.service.createFromResult(project, user.id, dto);
  }

  @Post('preview-result')
  previewResult(@CurrentProject() project: string, @Body() dto: PreviewResultCohortDto) {
    return this.service.previewFromResult(project, dto);
  }

  @Post('preview-sql')
  previewSql(@CurrentProject() project: string, @Body() dto: PreviewSqlCohortDto) {
    return this.service.previewSql(project, dto);
  }

  /** 条件分群试跑：人数 + 示例成员，只读（详见设计文档 A.4） */
  @Post('preview-condition')
  previewCondition(@CurrentProject() project: string, @Body() dto: PreviewConditionCohortDto) {
    return this.service.previewCondition(project, dto);
  }

  @Post()
  @RequirePermission('cohort.edit_own')
  create(
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCohortDto,
  ) {
    return this.service.create(project, user.id, dto, dto.csv_text);
  }

  @Get(':id/members')
  members(
    @CurrentProject() project: string,
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('keyword') keyword?: string,
  ) {
    return this.service.membersPreview(id, project, limit ? Number(limit) : 1000, keyword);
  }

  /** ID 分群重传名单（整体替换）；与 PUT /:id 同一道资产权限 */
  @Post(':id/members')
  @RequirePermission('cohort.edit_own')
  async replaceMembers(
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Param('id') id: string,
    @Body() dto: ReplaceCohortMembersDto,
  ) {
    const asset = await this.policy.loadCohort(project, id);
    await this.policy.assert(user.id, iam, 'update', asset);
    return this.service.replaceMembers(id, project, dto.csv_text);
  }

  @Post(':id/compute')
  compute(@CurrentProject() project: string, @Param('id') id: string) {
    return this.service.refresh(id, project);
  }

  @Post(':id/preview-sql')
  previewSavedSql(
    @CurrentProject() project: string,
    @Param('id') id: string,
    @Body() dto: PreviewSqlCohortDto,
  ) {
    return this.service.previewSql(project, dto, id);
  }

  @Get(':id')
  get(@CurrentProject() project: string, @Param('id') id: string) {
    return this.service.get(id, project);
  }

  @Put(':id')
  @RequirePermission('cohort.edit_own')
  async update(
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Param('id') id: string,
    @Body() dto: UpdateCohortDto,
  ) {
    const asset = await this.policy.loadCohort(project, id);
    await this.policy.assert(user.id, iam, 'update', asset);
    return this.service.update(id, project, dto);
  }

  @Post(':id/lock')
  @RequirePermission('asset.lock')
  async lock(
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Param('id') id: string,
    @Body() body: { locked: boolean },
  ) {
    const asset = await this.policy.loadCohort(project, id);
    await this.policy.assert(user.id, iam, 'lock', asset, { locking: body.locked });
    return this.service.setLocked(id, project, body.locked);
  }

  @Delete(':id')
  @RequirePermission('cohort.edit_own')
  async remove(
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Param('id') id: string,
    @Query('force') force?: string,
  ) {
    const asset = await this.policy.loadCohort(project, id);
    await this.policy.assert(user.id, iam, 'delete', asset);
    return this.service.remove(id, project, force === '1' || force === 'true');
  }
}
