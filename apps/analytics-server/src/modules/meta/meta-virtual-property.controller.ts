import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { MetaVirtualPropertyService } from './meta-virtual-property.service';
import { CreateMetaVirtualPropertyDto, UpdateMetaVirtualPropertyDto } from './dto/meta-virtual-property.dto';

import { RequirePermission } from '../iam/require-permission';

@Controller('sa/api/meta/virtual-properties')
@RequirePermission('meta.view')
export class MetaVirtualPropertyController {
  constructor(private readonly service: MetaVirtualPropertyService) {}

  @Get()
  @RequirePermission('meta.view', 'meta.picker.view')
  async list(
    @CurrentProject() project: string,
    @Query('event_key') eventKey?: string,
  ) {
    return this.service.list(project, eventKey);
  }

  @Post()
  @RequirePermission('meta.edit')
  async create(
    @CurrentProject() project: string,
    @Body() dto: CreateMetaVirtualPropertyDto,
  ) {
    return this.service.create(project, dto);
  }

  @Put(':id')
  @RequirePermission('meta.edit')
  async update(
    @CurrentProject() project: string,
    @Param('id') id: string,
    @Body() dto: UpdateMetaVirtualPropertyDto,
  ) {
    return this.service.update(id, project, dto);
  }

  @Delete(':id')
  @RequirePermission('meta.edit')
  async delete(
    @CurrentProject() project: string,
    @Param('id') id: string,
  ) {
    return this.service.delete(id, project);
  }

  @Post(':id/validate')
  @RequirePermission('meta.edit')
  async validate(
    @CurrentProject() project: string,
    @Param('id') id: string,
  ) {
    return this.service.validate(id, project);
  }
}
