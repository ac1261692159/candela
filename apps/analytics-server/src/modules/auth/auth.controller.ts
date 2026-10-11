import { Body, Controller, Get, Post, Put, Param, Headers, Delete, Query } from '@nestjs/common';
import { AuthService, AuthUser } from './auth.service';
import { ApiKeyService } from './api-key.service';
import { AuthAuditService } from './auth-audit.service';
import { AuthMailService } from './auth-mail.service';
import { sha256Hex } from './auth-token.service';
import { badRequest } from '../../i18n/domain-error';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AllowWithoutMembership, RequirePermission } from '../iam/require-permission';
import { HarnessRuntimeManagerService } from '../ai-assistant/harness-runtime-manager.service';

@Controller('sa/api/auth')
@AllowWithoutMembership()
export class AuthController {
  constructor(
    private readonly service: AuthService,
    private readonly apiKeyService: ApiKeyService,
    private readonly harnessRuntimes: HarnessRuntimeManagerService,
    private readonly audit: AuthAuditService,
    private readonly mail: AuthMailService,
  ) {}

  @Public()
  @Post('login')
  login(@Body() body: { username: string; password: string }) {
    return this.service.login(body.username, body.password);
  }

  @Public()
  @Post('forgot-password')
  forgotPassword(@Body() body: { identifier?: string }) {
    return this.service.forgotPassword(body?.identifier ?? '');
  }

  @Public()
  @Post('reset-password')
  resetPasswordByToken(@Body() body: { token: string; new_password: string }) {
    return this.service.setPasswordWithAnyPurpose(body.token, body.new_password);
  }

  @Get('mail-status')
  @RequirePermission('ops.user.manage')
  mailStatus() {
    return this.service.mailStatus();
  }

  // ---- 账号域 SMTP 网页配置（phase: clklog-analytics-account-lifecycle-v2 增补 v1.1）----

  @Get('mail-config')
  @RequirePermission('ops.user.manage')
  mailConfigView() {
    return this.mail.adminView();
  }

  @Put('mail-config')
  @RequirePermission('ops.user.manage')
  async saveMailConfig(
    @CurrentUser() actor: AuthUser,
    @Body()
    body: { enabled: boolean; host: string; port?: number; secure?: boolean; user?: string; from?: string; pass?: string },
  ) {
    const result = await this.mail.saveConfig(actor.username, body);
    await this.audit.record('auth_mail_config', actor.username, {
      enabled: body.enabled,
      host: body.host,
      port: body.port ?? 465,
      secure: body.secure ?? true,
      user: body.user ?? '',
      from: body.from ?? '',
      pass_changed: Boolean(body.pass),
    });
    return result;
  }

  @Post('mail-config/test')
  @RequirePermission('ops.user.manage')
  async testMailConfig(@CurrentUser() user: AuthUser, @Body() body: { to?: string }) {
    const to = (body?.to ?? '').trim() || user.email;
    if (!to) {
      throw badRequest({
        code: 'auth.mail.testToRequired',
        messageKey: 'auth:error.mail.testToRequired',
        message: '请填写测试收件邮箱',
      });
    }
    const result = await this.mail.sendTest(to, user.locale);
    await this.audit.record('auth_mail_test', user.username, { to_hash: sha256Hex(to).slice(0, 12), sent: result.sent });
    return result;
  }

  @Post('logout')
  async logout(@CurrentUser() user: AuthUser, @Headers('authorization') auth: string) {
    const token = (auth ?? '').replace(/^Bearer\s+/i, '');
    await this.harnessRuntimes.closeToken(user.id, token);
    return this.service.logout(token);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.service.me(user);
  }

  @Put('preferences')
  updatePreferences(
    @CurrentUser() user: AuthUser,
    @Body() body: { default_project?: string | null; locale?: string | null },
  ) {
    return this.service.updatePreferences(user, body);
  }

  @Put('profile')
  updateProfile(@CurrentUser() user: AuthUser, @Body() body: { display_name?: string; email?: string | null }) {
    return this.service.updateProfile(user, body);
  }

  @Put('password')
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Headers('authorization') auth: string,
    @Body() body: { old_password: string; new_password: string },
  ) {
    const token = (auth ?? '').replace(/^Bearer\s+/i, '');
    const result = await this.service.changePassword(user, body, token);
    await this.harnessRuntimes.closeUser(user.id);
    return result;
  }

  // ---- 会话管理（account-lifecycle-v3）----

  @Get('sessions')
  mySessions(@CurrentUser() user: AuthUser, @Headers('authorization') auth: string) {
    const token = (auth ?? '').replace(/^Bearer\s+/i, '');
    return this.service.listMySessions(user.id, token);
  }

  @Delete('sessions')
  revokeOtherSessions(@CurrentUser() user: AuthUser, @Headers('authorization') auth: string) {
    const token = (auth ?? '').replace(/^Bearer\s+/i, '');
    return this.service.revokeOtherSessions(user, token);
  }

  @Delete('sessions/:sid')
  revokeMySession(@CurrentUser() user: AuthUser, @Param('sid') sid: string, @Headers('authorization') auth: string) {
    const token = (auth ?? '').replace(/^Bearer\s+/i, '');
    return this.service.revokeMySession(user, sid, token);
  }

  @Get('users/:id/sessions')
  @RequirePermission('ops.user.manage')
  userSessions(@Param('id') id: string) {
    return this.service.listSessionsOf(id);
  }

  @Delete('users/:id/sessions/:sid')
  @RequirePermission('ops.user.manage')
  adminRevokeSession(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Param('sid') sid: string,
    @Headers('authorization') auth: string,
  ) {
    const token = (auth ?? '').replace(/^Bearer\s+/i, '');
    return this.service.adminRevokeSession(actor, id, sid, token);
  }

  @Delete('users/:id/sessions')
  @RequirePermission('ops.user.manage')
  adminRevokeAllSessions(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.service.adminRevokeAllSessions(actor, id);
  }

  // ---- 用户管理 ----
  @Get('users')
  @RequirePermission('ops.user.manage')
  listUsers() {
    return this.service.listUsers();
  }

  @Post('users')
  @RequirePermission('ops.user.manage')
  createUser(
    @CurrentUser() actor: AuthUser,
    @Body() body: { username: string; password: string; display_name?: string; email?: string | null; send_setup_email?: boolean },
  ) {
    return this.service.createUser(actor.username, body);
  }

  @Put('users/:id')
  @RequirePermission('ops.user.manage')
  updateUser(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: { display_name?: string | null; email?: string | null; platform_role?: 'super_admin' | 'none' },
  ) {
    return this.service.updateUser(actor, id, body);
  }

  @Put('users/:id/status')
  @RequirePermission('ops.user.manage')
  async setStatus(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: { status: 'active' | 'disabled' },
  ) {
    const result = await this.service.setUserStatus(actor, id, body.status);
    if (body.status === 'disabled') {
      await this.harnessRuntimes.disableUser(id);
    } else {
      this.harnessRuntimes.enableUser(id);
    }
    return result;
  }

  @Post('users/:id/unlock')
  @RequirePermission('ops.user.manage')
  unlockUser(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.service.unlockUser(actor, id);
  }

  @Post('users/:id/reset-password')
  @RequirePermission('ops.user.manage')
  async resetPassword(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    const result = await this.service.resetUserPassword(actor, id);
    // 该用户全部会话已被吊销，Harness 侧同步下线
    await this.harnessRuntimes.disableUser(id);
    return result;
  }

  @Delete('users/:id')
  @RequirePermission('ops.user.manage')
  async deleteUser(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    const result = await this.service.deleteUser(actor, id);
    await this.harnessRuntimes.disableUser(id);
    return result;
  }

  // rbac-v4：权限变更流水属治理面——改由「项目权限管理 · 编辑」把守，不再随 iam.member.view 外溢
  @Get('audit-logs')
  @RequirePermission('ops.user.manage', 'iam.member.edit')
  auditLogs(@Query('limit') limit?: string, @Query('project') project?: string) {
    return this.audit.list(limit ? Number(limit) : 100, project || undefined);
  }

  // ---- 外部 AI 只读查询 API Key 管理（admin）----

  @Get('api-keys')
  @RequirePermission('ops.apikey.manage')
  listApiKeys() {
    return this.apiKeyService.list();
  }

  @Post('api-keys')
  @RequirePermission('ops.apikey.manage')
  createApiKey(@Body() body: { name?: string; project_name?: string; expires_at?: string | null }) {
    return this.apiKeyService.create({
      name: body?.name,
      project_name: body?.project_name ?? 'clklogapp',
      expires_at: body?.expires_at ?? null,
    });
  }

  @Put('api-keys/:id/revoke')
  @RequirePermission('ops.apikey.manage')
  revokeApiKey(@Param('id') id: string) {
    return this.apiKeyService.revoke(id);
  }

  @Delete('api-keys/:id')
  @RequirePermission('ops.apikey.manage')
  removeApiKey(@Param('id') id: string) {
    return this.apiKeyService.remove(id);
  }
}
