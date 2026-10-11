import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { domainError } from '../../i18n/domain-error';
import { AuthUser } from '../auth/auth.service';
import { HarnessRuntimeManagerService } from './harness-runtime-manager.service';
import { HarnessWebProxyService } from './harness-web-proxy.service';

import { RequireMember } from '../iam/require-permission';

@Controller('sa/api/assistant')
@RequireMember()
export class AiAssistantController {
  constructor(private readonly runtimes: HarnessRuntimeManagerService, private readonly proxy: HarnessWebProxyService) {}

  @Post('connection/renew')
  renewConnection(@CurrentUser() user: AuthUser, @CurrentProject() project: string,
    @Body() body: { runtime_id: string; tab_id: string }) {
    return this.proxy.renewConnection(user.id, project, body?.tab_id, body?.runtime_id);
  }

  @Post('host-ticket')
  issueHostTicket(
    @Body() body: { tab_id: string; workspace_id?: string },
    @CurrentUser() user: AuthUser,
    @CurrentProject() project: string,
    @Headers('authorization') authorization?: string,
  ) {
    const token = this.bearerToken(authorization);
    return this.runtimes.issueHostTicket({
      user,
      project,
      userToken: token,
      tabId: body?.tab_id,
      workspaceId: body?.workspace_id,
    });
  }

  @Get('catalog')
  catalog() {
    return this.runtimes.modelCatalog();
  }

  private bearerToken(authorization?: string): string {
    if (!authorization?.startsWith('Bearer ')) {
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'ai.session.required',
        messageKey: 'ai:error.session.required',
        message: '未登录',
      });
    }
    const token = authorization.slice('Bearer '.length).trim();
    if (!token) {
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'ai.session.required',
        messageKey: 'ai:error.session.required',
        message: '未登录',
      });
    }
    return token;
  }
}
