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
import { CurrentProject } from '../../common/decorators/project.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/auth.service';
import { CurrentIam } from './current-iam.decorator';
import { IamService } from './iam.service';
import { AssetPolicyService } from './asset-policy.service';
import { AllowWithoutMembership, RequirePermission } from './require-permission';
import type { IamContext } from './iam.types';
import { sanitizeAdminOverlay } from './iam-evaluate';
import { badRequest } from '../../i18n/domain-error';

@Controller('sa/api/iam')
export class IamController {
  constructor(
    private readonly iam: IamService,
    private readonly policy: AssetPolicyService,
  ) {}

  @Get('me')
  @AllowWithoutMembership()
  me(@CurrentUser() user: AuthUser, @CurrentProject() project: string) {
    return this.iam.me(user.id, project);
  }

  @Get('projects')
  @AllowWithoutMembership()
  listProjects(@CurrentUser() user: AuthUser) {
    return this.iam.listAccessibleProjects(user.id);
  }

  @Get('catalog')
  @RequirePermission('iam.member.view')
  catalog(@CurrentIam() ctx: IamContext, @CurrentProject() project: string) {
    return this.iam.buildCatalog(ctx, project);
  }

  @Get('user-directory')
  @RequirePermission('iam.member.edit', 'ops.owner.assign')
  userDirectory() {
    return this.iam.listUserDirectory();
  }

  @Get('users/:id/footprint')
  @RequirePermission('ops.user.manage')
  userFootprint(@Param('id') id: string) {
    return this.iam.userFootprint(id);
  }

  @Get('members')
  @RequirePermission('iam.member.view')
  members(@CurrentProject() project: string) {
    return this.iam.listMembers(project);
  }

  @Post('members')
  @RequirePermission('iam.member.edit')
  addMember(
    @CurrentUser() user: AuthUser,
    @CurrentProject() project: string,
    @Body() body: { user_id: string; role_key: string; data_policy_id?: string | null; expires_at?: string | null },
  ) {
    return this.iam.addMember(project, user.username, body);
  }

  @Patch('members/:id')
  @RequirePermission('iam.member.edit')
  patchMember(
    @CurrentUser() user: AuthUser,
    @CurrentProject() project: string,
    @Param('id') id: string,
    @Body() body: { role_key?: string; data_policy_id?: string | null; expires_at?: string | null },
  ) {
    return this.iam.patchMember(project, id, body, user.username);
  }

  @Delete('members/:id')
  @RequirePermission('iam.member.edit')
  removeMember(@CurrentProject() project: string, @Param('id') id: string) {
    return this.iam.removeMember(project, id);
  }

  // ---- 项目邀请（按邮箱，phase: clklog-analytics-account-lifecycle-v2）----

  @Post('invitations')
  @RequirePermission('iam.member.edit')
  createInvitation(
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { email: string; role_key: string },
  ) {
    return this.iam.createInvitation(project, user, body);
  }

  // rbac-v4：邀请队列含未入会者邮箱，属治理面——不再随 iam.member.view 外溢
  @Get('invitations')
  @RequirePermission('iam.member.edit')
  listInvitations(@CurrentProject() project: string) {
    return this.iam.listPendingInvitations(project);
  }

  @Delete('invitations/:id')
  @RequirePermission('iam.member.edit')
  revokeInvitation(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.iam.revokeInvitation(user, id);
  }

  @Get('groups')
  @RequirePermission('iam.member.view')
  groups(@CurrentProject() project: string) {
    return this.iam.listGroups(project);
  }

  @Post('groups')
  @RequirePermission('iam.member.edit')
  createGroup(
    @CurrentProject() project: string,
    @Body() body: { name: string; role_key: string; data_policy_id?: string | null },
  ) {
    return this.iam.createGroup(project, body);
  }

  @Patch('groups/:id')
  @RequirePermission('iam.member.edit')
  patchGroup(
    @CurrentProject() project: string,
    @Param('id') id: string,
    @Body() body: { name?: string; role_key?: string; data_policy_id?: string | null },
  ) {
    return this.iam.patchGroup(project, id, body);
  }

  @Post('groups/:id/users')
  @RequirePermission('iam.member.edit')
  addGroupUser(
    @CurrentProject() project: string,
    @Param('id') id: string,
    @Body() body: { user_id: string },
  ) {
    return this.iam.addGroupUser(project, id, body.user_id);
  }

  @Delete('groups/:id/users/:userId')
  @RequirePermission('iam.member.edit')
  removeGroupUser(
    @CurrentProject() project: string,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.iam.removeGroupUser(project, id, userId);
  }

  @Put('roles/analysis_admin')
  @RequirePermission('iam.role.edit_admin')
  putAdminRole(
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { grants: string[] },
  ) {
    if (!Array.isArray(body?.grants)) {
      throw badRequest({
        code: 'iam.role.grantsMustBeArray',
        messageKey: 'iam:error.role.grantsMustBeArray',
        message: 'grants 必须是数组',
      });
    }
    const grants = sanitizeAdminOverlay(body.grants);
    return this.iam.putAdminRole(project, grants, user.id);
  }

  @Get('data-policies')
  @RequirePermission('iam.member.view')
  policies(@CurrentProject() project: string) {
    return this.iam.listPolicies(project);
  }

  @Post('data-policies')
  @RequirePermission('iam.data_policy.manage')
  createPolicy(
    @CurrentProject() project: string,
    @Body() body: { name: string; definition: import('./iam.types').DataPolicyDef },
  ) {
    return this.iam.createPolicy(project, body);
  }

  @Patch('data-policies/:id')
  @RequirePermission('iam.data_policy.manage')
  patchPolicy(
    @CurrentProject() project: string,
    @Param('id') id: string,
    @Body() body: { name?: string; definition?: import('./iam.types').DataPolicyDef },
  ) {
    return this.iam.patchPolicy(project, id, body);
  }

  @Delete('data-policies/:id')
  @RequirePermission('iam.data_policy.manage')
  deletePolicy(@CurrentProject() project: string, @Param('id') id: string) {
    return this.iam.deletePolicy(project, id);
  }

  // ---- 主体视角的看板授权（rbac-v6）：成员 / 成员组能看到并调整「这个主体被授过哪些看板」 ----

  @Get('dashboard-grants')
  @RequirePermission('asset.grant')
  listDashboardGrants(
    @CurrentProject() project: string,
    @Query('subject_type') subjectType?: string,
    @Query('subject_id') subjectId?: string,
  ) {
    const type = assertSubjectType(subjectType);
    if (!subjectId) {
      throw badRequest({
        code: 'iam.grant.subjectRequired',
        messageKey: 'iam:error.grant.subjectRequired',
        message: '缺少 subject_id',
      });
    }
    return this.policy.listSubjectGrants(project, type, subjectId);
  }

  @Put('dashboard-grants')
  @RequirePermission('asset.grant')
  putDashboardGrants(
    @CurrentProject() project: string,
    @Body() body: { subject_type?: string; subject_id?: string; asset_ids?: string[] },
  ) {
    const type = assertSubjectType(body?.subject_type);
    if (!body?.subject_id) {
      throw badRequest({
        code: 'iam.grant.subjectRequired',
        messageKey: 'iam:error.grant.subjectRequired',
        message: '缺少 subject_id',
      });
    }
    if (!Array.isArray(body?.asset_ids)) {
      throw badRequest({
        code: 'iam.grant.assetsMustBeArray',
        messageKey: 'iam:error.grant.assetsMustBeArray',
        message: 'asset_ids 必须是数组',
      });
    }
    return this.policy
      .replaceSubjectViewGrants(project, type, body.subject_id, body.asset_ids)
      .then(() => ({ ok: true }));
  }
}

function assertSubjectType(value?: string): 'user' | 'group' {
  if (value === 'user' || value === 'group') return value;
  throw badRequest({
    code: 'iam.grant.subjectTypeInvalid',
    messageKey: 'iam:error.grant.subjectTypeInvalid',
    message: 'subject_type 必须是 user 或 group',
  });
}
