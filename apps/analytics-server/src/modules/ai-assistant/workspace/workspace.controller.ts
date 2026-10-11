import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { CurrentProject } from '../../../common/decorators/project.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AuthUser } from '../../auth/auth.service';
import { WorkspaceService } from './workspace.service';
import { createOrderedId } from './workspace-paths.service';
import { HarnessRuntimeManagerService } from '../harness-runtime-manager.service';

import { RequireMember } from '../../iam/require-permission';

@Controller('sa/api/assistant/workspaces')
@RequireMember()
export class WorkspaceController {
  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly runtimes: HarnessRuntimeManagerService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @CurrentProject() project: string) {
    return this.workspaces.list(user, project);
  }

  @Post('default')
  defaultWorkspace(@CurrentUser() user: AuthUser, @CurrentProject() project: string) {
    return this.workspaces.defaultWorkspace(user, project);
  }

  @Post('persistent')
  createPersistent(
    @CurrentUser() user: AuthUser,
    @CurrentProject() project: string,
    @Body() body: { display_name: string },
  ) {
    return this.workspaces.createPermanent(user, project, body.display_name);
  }

  @Post('temporary')
  createTemporary(
    @CurrentUser() user: AuthUser,
    @CurrentProject() project: string,
  ) {
    return this.workspaces.createTemporary(user, project, createOrderedId('ais_'));
  }

  @Post(':id/promote')
  async promote(
    @CurrentUser() user: AuthUser,
    @CurrentProject() project: string,
    @Param('id') id: string,
    @Body() body: { display_name: string },
  ) {
    const workspace = await this.workspaces.getOwned(id, user, project);
    await this.runtimes.closeWorkspace(user.id, project, id);
    return this.workspaces.promoteTemporary(workspace, body.display_name);
  }

  @Delete(':id')
  async delete(
    @CurrentUser() user: AuthUser,
    @CurrentProject() project: string,
    @Param('id') id: string,
  ) {
    const workspace = await this.workspaces.getOwned(id, user, project);
    await this.runtimes.closeWorkspace(user.id, project, id);
    return this.workspaces.deleteOwned(workspace);
  }
}
