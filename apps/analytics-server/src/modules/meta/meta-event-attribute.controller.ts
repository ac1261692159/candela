import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { MetaEventAttributeService } from './meta-event-attribute.service';

import { RequirePermission } from '../iam/require-permission';

@Controller('sa/api/meta/event-attributes')
@RequirePermission('meta.view')
export class MetaEventAttributeController {
  constructor(private readonly service: MetaEventAttributeService) {}

  @Get()
  @RequirePermission('meta.view', 'meta.picker.view')
  async list(
    @CurrentProject() project: string,
    @Query('data_type') dataType?: string,
    @Query('status') status?: string,
    @Query('keyword') keyword?: string,
    @Query('sort_by') sort_by?: string,
    @Query('sort_order') sort_order?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const pagination = {
      page: Math.max(1, parseInt(page ?? '1', 10)),
      pageSize: Math.min(100, Math.max(1, parseInt(pageSize ?? '20', 10))),
    };
    return this.service.list(
      {
        project_name: project,
        data_type: dataType?.split(',').filter(Boolean),
        status,
        keyword,
      },
      {
        sort_by: sort_by as any,
        sort_order: sort_order as any,
      },
      pagination,
    );
  }

  @Get(':propKey')
  async detail(@CurrentProject() project: string, @Param('propKey') propKey: string) {
    return this.service.detail(propKey, project);
  }

  @Put(':propKey')
  @RequirePermission('meta.edit')
  async update(
    @CurrentProject() project: string,
    @Param('propKey') propKey: string,
    @Body() dto: Partial<{ display_name: string; data_type: string; remark: string; status: string }>,
  ) {
    return this.service.update(propKey, project, dto);
  }

  @Post('refresh-counts')
  @RequirePermission('meta.edit')
  async refreshCounts(@CurrentProject() project: string) {
    return this.service.refreshCounts(project);
  }
}
