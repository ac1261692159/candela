import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/auth.service';
import { CurrentIam } from '../iam/current-iam.decorator';
import type { IamContext } from '../iam/iam.types';
import { RequirePermission } from '../iam/require-permission';
import { FolderService } from './folder.service';
import type { AssetAclGrant } from '../iam/asset-policy.service';

@Controller('sa/api/report/folders')
export class FolderController {
  constructor(private readonly folders: FolderService) {}

  @Get()
  @RequirePermission('dashboard.view')
  tree(@CurrentProject() project: string) {
    return this.folders.tree(project);
  }

  @Post()
  @RequirePermission('dashboard.folder.manage')
  create(@CurrentProject() project: string, @Body() body: { name: string; parent_id?: string | null }) {
    return this.folders.create(project, body);
  }

  @Patch(':id')
  @RequirePermission('dashboard.folder.manage')
  patch(
    @Param('id') id: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Body() body: { name?: string; parent_id?: string | null; sort_order?: number },
  ) {
    return this.folders.patch(project, id, user.id, iam, body);
  }

  @Delete(':id')
  @RequirePermission('dashboard.folder.manage')
  remove(
    @Param('id') id: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.folders.remove(project, id, user.id, iam);
  }

  @Post(':id/lock')
  @RequirePermission('asset.lock')
  lock(
    @Param('id') id: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Body() body: { locked: boolean },
  ) {
    return this.folders.lock(project, id, user.id, iam, Boolean(body.locked));
  }

  @Get(':id/acl')
  @RequirePermission('asset.grant')
  listAcl(@Param('id') id: string, @CurrentProject() project: string) {
    return this.folders.listAcl(project, id);
  }

  @Put(':id/acl')
  @RequirePermission('asset.grant')
  putAcl(
    @Param('id') id: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Body() body: { grants: AssetAclGrant[] },
  ) {
    return this.folders.putAcl(project, id, user.id, iam, body.grants ?? []);
  }
}
