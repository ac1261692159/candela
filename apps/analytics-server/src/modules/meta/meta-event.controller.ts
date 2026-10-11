import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { MetaEventService } from './meta-event.service';
import { ListMetaEventsQueryDto, CreateMetaEventDto, UpdateMetaEventDto, BatchMetaEventsDto } from './dto/meta-event.dto';
import { RequirePermission } from '../iam/require-permission';

@Controller('sa/api/meta/events')
@RequirePermission('meta.view')
export class MetaEventController {
  constructor(private readonly service: MetaEventService) {}

  @Get()
  @RequirePermission('meta.view', 'meta.picker.view')
  async list(
    @CurrentProject() project: string,
    @Query() query: ListMetaEventsQueryDto,
  ) {
    const page = Math.max(1, parseInt(query.page ?? '1', 10));
    const pageSize = Math.min(500, Math.max(1, parseInt(query.pageSize ?? '20', 10)));
    return this.service.listEvents(
      {
        project_name: project,
        status: query.status,
        event_type: query.event_type,
        availability_status: query.availability_status,
        data_status: query.data_status,
        connection_status: query.connection_status,
        keyword: query.keyword,
        exclude_hidden: query.exclude_hidden === 'true' || query.exclude_hidden === '1',
      },
      {
        sort_by: query.sort_by as any,
        sort_order: query.sort_order as any,
      },
      { page, pageSize },
    );
  }

  @Post()
  @RequirePermission('meta.edit')
  async create(
    @CurrentProject() project: string,
    @Body() dto: CreateMetaEventDto,
  ) {
    return this.service.createEvent(project, dto);
  }

  @Post('batch')
  @RequirePermission('meta.edit')
  async batch(
    @CurrentProject() project: string,
    @Body() dto: BatchMetaEventsDto,
  ) {
    return this.service.batchEvents(project, dto);
  }

  @Put(':eventKey')
  @RequirePermission('meta.edit')
  async update(
    @CurrentProject() project: string,
    @Param('eventKey') eventKey: string,
    @Body() dto: UpdateMetaEventDto,
  ) {
    return this.service.updateEvent(eventKey, project, dto);
  }

  @Post('refresh-stats')
  @RequirePermission('meta.edit')
  async refreshStats(@CurrentProject() project: string) {
    await this.service.refreshStats(project);
    return { success: true };
  }
}
