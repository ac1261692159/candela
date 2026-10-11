import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { AuthService } from '../auth/auth.service';
import { IamService, IAM_DEMO_USERS } from './iam.service';
import { RequirePermission } from './require-permission';
import { badRequest } from '../../i18n/domain-error';
import { ProjectTimeRegistry } from '../time/project-time-registry';

@Controller('sa/api/iam/ops')
export class IamOpsController {
  constructor(
    private readonly iam: IamService,
    private readonly auth: AuthService,
    private readonly projectTimes: ProjectTimeRegistry,
  ) {}

  @Get('user-directory')
  @RequirePermission('ops.owner.assign')
  userDirectory() {
    return this.iam.listUserDirectory();
  }

  @Get('projects')
  @RequirePermission('ops.owner.assign')
  listProjects() {
    return this.iam.listRegistryProjects();
  }

  @Post('projects')
  @RequirePermission('ops.owner.assign')
  createProject(@Body() body: { name: string; display_name?: string; owner_user_id: string }) {
    if (!body?.name || !body?.owner_user_id) {
      throw badRequest({
        code: 'iam.project.fieldsRequired',
        messageKey: 'iam:error.project.fieldsRequired',
        message: 'name 与 owner_user_id 必填',
      });
    }
    return this.iam.createProject(body);
  }

  /** 项目时区设置/清除（IANA；null = 跟随平台，phase: clklog-analytics-timezone-v2） */
  @Put('projects/:name/timezone')
  @RequirePermission('ops.owner.assign')
  async setProjectTimezone(@Param('name') name: string, @Body() body: { timezone?: string | null }) {
    const result = await this.iam.setProjectTimezone(name, body?.timezone ?? null);
    this.projectTimes.invalidate(name);
    return result;
  }

  @Get('owners/:project')
  @RequirePermission('ops.owner.assign')
  getOwner(@Param('project') project: string) {
    return this.iam.getOwner(project);
  }

  @Put('owners/:project')
  @RequirePermission('ops.owner.assign')
  assignOwner(@Param('project') project: string, @Body() body: { user_id: string }) {
    return this.iam.assignOwner(project, body.user_id);
  }

  /** 超管填入密码后创建演示登录账号并加入当前项目成员组（Jest 夹具不会写入生产库） */
  @Post('demo-seed')
  @RequirePermission('ops.user.manage')
  async demoSeed(@CurrentProject() project: string, @Body() body: { password?: string }) {
    const password = body?.password ?? '';
    if (password.length < 6) {
      throw badRequest({
        code: 'iam.demo.passwordTooShort',
        messageKey: 'iam:error.demo.passwordTooShort',
        message: '演示账号密码至少 6 位',
      });
    }
    const existing = new Set((await this.iam.listUserDirectory()).map((u) => u.username));
    for (const acc of IAM_DEMO_USERS) {
      if (existing.has(acc.username)) continue;
      await this.auth.createUser('system', {
        username: acc.username,
        password,
        display_name: acc.display_name,
      });
    }
    // 演示账号是共享夹具而非真人：清除强制首登改密，否则首个演示者改密后共享密码即失效
    await this.iam.clearMustChangePassword(IAM_DEMO_USERS.map((u) => u.username));
    await this.iam.seedDemoMembership(project);
    return { ok: true };
  }
}
