import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AuthUser } from '../../auth/auth.service';
import { RequirePermission } from '../../iam/require-permission';
import { WorkspaceSyncService } from './workspace-sync.service';
import { WorkspaceService } from './workspace.service';
import { WorkspaceTemplateService } from './workspace-template.service';
import {
  WorkspaceSyncScope,
  WorkspaceTemplatePolicy,
} from './workspace-template.types';

@Controller('sa/api/admin/ai')
@RequirePermission('ops.ai_workspace.manage')
export class WorkspaceAdminController {
  constructor(
    private readonly templates: WorkspaceTemplateService,
    private readonly sync: WorkspaceSyncService,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Get('workspace-template/draft/tree')
  tree() {
    return this.templates.draftTree();
  }

  @Put('workspace-template/draft/file')
  putFile(
    @Body()
    body: {
      path: string;
      content: string;
      encoding?: 'utf8' | 'base64';
      executable?: boolean;
    },
  ) {
    return this.templates.putFile(body);
  }

  @Post('workspace-template/draft/directory')
  createDirectory(@Body() body: { path: string }) {
    return this.templates.createDirectory(body.path);
  }

  @Patch('workspace-template/draft/entry')
  patchEntry(
    @Body()
    body: {
      path: string;
      new_path?: string;
      policy?: WorkspaceTemplatePolicy;
      executable?: boolean;
    },
  ) {
    return this.templates.patchEntry(body);
  }

  @Delete('workspace-template/draft/entry')
  deleteEntry(@Query('path') path: string) {
    return this.templates.deleteEntry(path);
  }

  @Get('workspace-template/preview')
  preview() {
    return this.templates.preview();
  }

  @Post('workspace-template/publish')
  publish(@CurrentUser() user: AuthUser) {
    return this.templates.publish(user.id);
  }

  @Get('workspace-template/versions')
  versions() {
    return this.templates.versions();
  }

  @Post('workspace-template/versions/:version/restore-draft')
  restoreDraft(@Param('version') version: string) {
    return this.templates.restoreVersionToDraft(Number(version));
  }

  @Post('workspace-sync-jobs')
  startSync(@CurrentUser() user: AuthUser, @Body() scope: WorkspaceSyncScope) {
    return this.sync.start(scope ?? {}, user.id);
  }

  @Get('workspace-sync-jobs/:id')
  getSync(@Param('id') id: string) {
    return this.sync.get(id);
  }

  @Post('workspace-sync-jobs/:id/retry')
  retrySync(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.sync.retry(id, user.id);
  }

  @Get('workspaces')
  workspacesList(
    @Query('project_name') projectName?: string,
    @Query('user_id') userId?: string,
    @Query('kind') kind?: 'persistent' | 'temporary',
  ) {
    return this.workspaces.listAll({ project_name: projectName, user_id: userId, kind });
  }

  @Post('workspaces/:id/initialize-legacy')
  initializeLegacy(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.sync.initializeLegacy(id, user.id);
  }
}
