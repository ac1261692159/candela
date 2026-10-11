import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { MetaVirtualEventService } from './meta-virtual-event.service';
import { CreateMetaVirtualEventDto, UpdateMetaVirtualEventDto } from './dto/meta-virtual-event.dto';

import { RequirePermission } from '../iam/require-permission';

@Controller('sa/api/meta/virtual-events')
@RequirePermission('meta.view')
export class MetaVirtualEventController {
  constructor(private readonly service: MetaVirtualEventService) {}

  @Get()
  @RequirePermission('meta.view', 'meta.picker.view')
  async list(@CurrentProject() project: string) {
    const items = await this.service.list(project);
    return { items, total: items.length, page: 1, pageSize: items.length || 20 };
  }

  @Post()
  @RequirePermission('meta.edit')
  async create(
    @CurrentProject() project: string,
    @Body() dto: CreateMetaVirtualEventDto,
  ) {
    return this.service.create(project, dto);
  }

  @Put(':veId')
  @RequirePermission('meta.edit')
  async update(
    @CurrentProject() project: string,
    @Param('veId') veId: string,
    @Body() dto: UpdateMetaVirtualEventDto,
  ) {
    return this.service.update(veId, project, dto);
  }

  @Delete(':veId')
  @RequirePermission('meta.edit')
  async delete(
    @CurrentProject() project: string,
    @Param('veId') veId: string,
  ) {
    return this.service.delete(veId, project);
  }
}
