import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../iam/require-permission';
import { DatatableService } from './datatable.service';
import { DatatableMapService } from './datatable-map.service';
import {
  CreateBindingDto,
  CreateDatatableDto,
  ParseDatatableDto,
  UpdateBindingDto,
  UpdateDatatableDto,
  UpdateDatatableMetaDto,
} from './dto/datatable.dto';

/**
 * 数据表（维度表）API。契约见 `docs/architecture/clklog-analytics-design-datatable-v1.md` §11。
 */
@Controller('sa/api/meta/datatables')
@RequirePermission('meta.view')
export class DatatableController {
  constructor(
    private readonly service: DatatableService,
    private readonly maps: DatatableMapService,
  ) {}

  /** 第 1/3 步：解析 CSV（不落库） */
  @Post('parse')
  @RequirePermission('meta.edit')
  async parse(@Body() dto: ParseDatatableDto) {
    return this.service.preview(dto);
  }

  @Get()
  async list(@CurrentProject() project: string) {
    return this.service.list(project);
  }

  /** 分析页选择器：已生效绑定生成的 `{属性}@{字段}` */
  @Get('dimension-properties')
  @RequirePermission('meta.view', 'meta.picker.view')
  async dimensionProperties(@CurrentProject() project: string) {
    return this.service.listDimensionProperties(project);
  }

  /** 筛选下拉：已绑定属性的 名称（ID），提交值仍是 raw */
  @Get('labels')
  @RequirePermission('meta.view', 'meta.picker.view')
  async labels(@CurrentProject() project: string, @Query('prop') prop: string) {
    if (!prop?.trim()) return { bound: false, items: [], truncated: false };
    return this.maps.labelsForProp(project, prop.trim());
  }

  @Get(':id')
  async detail(@CurrentProject() project: string, @Param('id') id: string) {
    return this.service.detail(project, id);
  }

  /** 只改备注 */
  @Post(':id/remark')
  @RequirePermission('meta.edit')
  async updateMeta(
    @CurrentProject() project: string,
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: UpdateDatatableMetaDto,
  ) {
    return this.service.updateMeta(project, user?.id ?? 'system', id, dto);
  }

  @Get(':id/download')
  async download(@CurrentProject() project: string, @Param('id') id: string) {
    const content = await this.service.downloadCsv(project, id);
    return { content };
  }

  /** 保存：建表 + 写入首个版本 */
  @Post()
  @RequirePermission('meta.edit')
  async create(
    @CurrentProject() project: string,
    @CurrentUser() user: { id: string },
    @Body() dto: CreateDatatableDto,
  ) {
    return this.service.create(project, user?.id ?? 'system', dto);
  }

  /** 更新第 1 步：差异预览（不落库） */
  @Post(':id/update/preview')
  @RequirePermission('meta.edit')
  async updatePreview(
    @CurrentProject() project: string,
    @Param('id') id: string,
    @Body() dto: UpdateDatatableDto,
  ) {
    return this.service.updatePreview(project, id, dto);
  }

  @Post(':id/update')
  @RequirePermission('meta.edit')
  async update(
    @CurrentProject() project: string,
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: UpdateDatatableDto,
  ) {
    return this.service.update(project, user?.id ?? 'system', id, dto);
  }

  @Post(':id/clear')
  @RequirePermission('meta.edit')
  async clear(
    @CurrentProject() project: string,
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.service.clear(project, user?.id ?? 'system', id);
  }

  @Delete(':id')
  @RequirePermission('meta.edit')
  async remove(
    @CurrentProject() project: string,
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.service.remove(project, user?.id ?? 'system', id);
  }

  @Get(':id/bindings')
  async bindings(@CurrentProject() project: string, @Param('id') id: string) {
    return this.service.listBindings(project, id);
  }

  @Post(':id/bindings')
  @RequirePermission('meta.edit')
  async createBinding(
    @CurrentProject() project: string,
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: CreateBindingDto,
  ) {
    return this.service.createBinding(project, user?.id ?? 'system', id, dto);
  }

  @Patch(':id/bindings/:bindingId')
  @RequirePermission('meta.edit')
  async updateBinding(
    @CurrentProject() project: string,
    @Param('id') id: string,
    @Param('bindingId') bindingId: string,
    @Body() dto: UpdateBindingDto,
  ) {
    return this.service.updateBinding(project, id, bindingId, dto);
  }

  @Delete(':id/bindings/:bindingId')
  @RequirePermission('meta.edit')
  async deleteBinding(
    @CurrentProject() project: string,
    @Param('id') id: string,
    @Param('bindingId') bindingId: string,
  ) {
    return this.service.deleteBinding(project, id, bindingId);
  }

  @Get(':id/usage')
  async usage(@CurrentProject() project: string, @Param('id') id: string) {
    return this.service.usage(project, id);
  }
}
