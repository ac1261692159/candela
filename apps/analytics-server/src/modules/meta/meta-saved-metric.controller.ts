import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/auth.service';
import { MetaSavedMetricService } from './meta-saved-metric.service';
import { CreateSavedMetricDto, UpdateSavedMetricDto } from './dto/meta-saved-metric.dto';
import { CurrentIam } from '../iam/current-iam.decorator';
import type { IamContext } from '../iam/iam.types';

import { RequirePermission } from '../iam/require-permission';

@Controller('sa/api/meta/metrics')
@RequirePermission('metric.view')
export class MetaSavedMetricController {
  constructor(private readonly service: MetaSavedMetricService) {}

  @Get()
  async list(@CurrentProject() project: string, @Query('kind') kind?: string) {
    const items = await this.service.list(project, kind);
    return { items, total: items.length, page: 1, pageSize: items.length || 20 };
  }

  @Get(':metricId')
  get(@CurrentProject() project: string, @Param('metricId') metricId: string) {
    return this.service.get(metricId, project);
  }

  @Post()
  @RequirePermission('metric.edit_own')
  create(
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSavedMetricDto,
  ) {
    return this.service.create(project, user.id, dto);
  }

  @Put(':metricId')
  @RequirePermission('metric.edit_own')
  update(
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Param('metricId') metricId: string,
    @Body() dto: UpdateSavedMetricDto,
  ) {
    return this.service.update(metricId, project, dto, user.id, iam);
  }

  @Delete(':metricId')
  @RequirePermission('metric.edit_own')
  delete(
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Param('metricId') metricId: string,
  ) {
    return this.service.delete(metricId, project, user.id, iam);
  }
}
