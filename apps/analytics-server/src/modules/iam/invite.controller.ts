import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuthUser } from '../auth/auth.service';
import { IamService } from './iam.service';
import { AllowWithoutMembership } from './require-permission';

/**
 * 邀请接受链路（公开路由，phase: clklog-analytics-account-lifecycle-v2）。
 * 挂在 /sa/api/auth 下与忘记密码同族；info/register 无需登录，
 * accept 需要登录态且邮箱匹配（AM-7）。
 */
@Controller('sa/api/auth')
@AllowWithoutMembership()
export class InviteController {
  constructor(private readonly iam: IamService) {}

  @Public()
  @Get('invite/:token')
  inviteInfo(@Param('token') token: string) {
    return this.iam.inviteInfo(token);
  }

  @Public()
  @Post('invite/:token/register')
  register(@Param('token') token: string, @Body() body: { username: string; display_name?: string; password: string }) {
    return this.iam.registerViaInvite(token, body);
  }

  @Post('invite/:token/accept')
  accept(@Param('token') token: string, @CurrentUser() user: AuthUser) {
    return this.iam.acceptInvite(token, user);
  }
}
