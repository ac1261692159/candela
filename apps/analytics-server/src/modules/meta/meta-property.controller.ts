import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { MetaPropertyService } from './meta-property.service';
import { UpdateMetaPropertyDto } from './dto/meta-property.dto';

import { RequirePermission } from '../iam/require-permission';

@Controller('sa/api/meta')
@RequirePermission('meta.view')
export class MetaPropertyController {
  constructor(private readonly service: MetaPropertyService) {}

  @Get('events/:eventKey/properties')
  @RequirePermission('meta.view', 'meta.picker.view')
  async getEventProperties(
    @CurrentProject() project: string,
    @Param('eventKey') eventKey: string,
  ) {
    return this.service.getEventProperties(eventKey, project);
  }

  @Get('user-properties')
  @RequirePermission('meta.view', 'meta.picker.view')
  async getUserProperties(@CurrentProject() project: string) {
    // 与其它列表接口契约一致：{ items, total, page, pageSize }（前端 PropertyList 按 res.items 取）
    const items = await this.service.getUserProperties(project);
    return { items, total: items.length, page: 1, pageSize: items.length || 20 };
  }

  @Put('properties/:id')
  @RequirePermission('meta.edit')
  async updateEventProperty(
    @CurrentProject() project: string,
    @Param('id') id: string,
    @Body() dto: UpdateMetaPropertyDto,
  ) {
    return this.service.updateEventProperty(id, dto);
  }

  @Put('user-properties/:id')
  @RequirePermission('meta.edit')
  async updateUserProperty(
    @CurrentProject() project: string,
    @Param('id') id: string,
    @Body() dto: UpdateMetaPropertyDto,
  ) {
    return this.service.updateUserProperty(id, dto);
  }

  @Post('properties/:id/materialize')
  @RequirePermission('meta.edit')
  async materializeEventProperty(
    @CurrentProject() project: string,
    @Param('id') id: string,
  ) {
    return this.service.materializeEventProperty(id, project);
  }

  @Post('user-properties/:id/materialize')
  @RequirePermission('meta.edit')
  async materializeUserProperty(
    @CurrentProject() project: string,
    @Param('id') id: string,
  ) {
    return this.service.materializeUserProperty(id, project);
  }
}
