import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { SubjectService } from './subject.service';
import { CreateSubjectDto, SortSubjectsDto, UpdateSubjectDto } from './dto/subject.dto';

import { RequirePermission } from '../iam/require-permission';

@Controller('sa/api/meta/subjects')
@RequirePermission('subject.view')
export class SubjectController {
  constructor(private readonly service: SubjectService) {}

  @Get()
  async list(@CurrentProject() project: string) {
    const items = await this.service.list(project);
    return { items, total: items.length, page: 1, pageSize: items.length || 20 };
  }

  @Post()
  @RequirePermission('subject.edit')
  create(@CurrentProject() project: string, @Body() dto: CreateSubjectDto) {
    return this.service.create(project, dto);
  }

  @Put('sort')
  @RequirePermission('subject.edit')
  sort(@CurrentProject() project: string, @Body() dto: SortSubjectsDto) {
    return this.service.sort(project, dto.ids);
  }

  @Get(':id')
  get(@CurrentProject() project: string, @Param('id') id: string) {
    return this.service.get(id, project);
  }

  @Put(':id')
  @RequirePermission('subject.edit')
  update(@CurrentProject() project: string, @Param('id') id: string, @Body() dto: UpdateSubjectDto) {
    return this.service.update(id, project, dto);
  }

  @Delete(':id')
  @RequirePermission('subject.edit')
  remove(@CurrentProject() project: string, @Param('id') id: string) {
    return this.service.remove(id, project);
  }
}
