import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/auth.service';
import { TagService } from './tag.service';
import { CreateTagDto, UpdateTagDto } from './dto/tag.dto';

import { RequirePermission } from '../iam/require-permission';
import { CurrentIam } from '../iam/current-iam.decorator';
import type { IamContext } from '../iam/iam.types';
import { AssetPolicyService } from '../iam/asset-policy.service';

@Controller('sa/api/meta/tags')
@RequirePermission('tag.view')
export class TagController {
  constructor(
    private readonly service: TagService,
    private readonly policy: AssetPolicyService,
  ) {}

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

  @Post()
  @RequirePermission('tag.edit_own')
  create(@CurrentProject() project: string, @CurrentUser() user: AuthUser, @Body() dto: CreateTagDto) {
    return this.service.create(project, user.id, dto);
  }

  @Get(':id/members')
  members(@CurrentProject() project: string, @Param('id') id: string, @Query('limit') limit?: string) {
    return this.service.membersPreview(id, project, limit ? Number(limit) : 1000);
  }

  @Post(':id/compute')
  compute(@CurrentProject() project: string, @Param('id') id: string) {
    return this.service.refresh(id, project);
  }

  @Get(':id')
  get(@CurrentProject() project: string, @Param('id') id: string) {
    return this.service.get(id, project);
  }

  @Put(':id')
  @RequirePermission('tag.edit_own')
  async update(
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Param('id') id: string,
    @Body() dto: UpdateTagDto,
  ) {
    const asset = await this.policy.loadTag(project, id);
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
    const asset = await this.policy.loadTag(project, id);
    await this.policy.assert(user.id, iam, 'lock', asset, { locking: body.locked });
    return this.service.setLocked(id, project, body.locked);
  }

  @Delete(':id')
  @RequirePermission('tag.edit_own')
  async remove(
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Param('id') id: string,
    @Query('force') force?: string,
  ) {
    const asset = await this.policy.loadTag(project, id);
    await this.policy.assert(user.id, iam, 'delete', asset);
    return this.service.remove(id, project, force === '1' || force === 'true');
  }
}
