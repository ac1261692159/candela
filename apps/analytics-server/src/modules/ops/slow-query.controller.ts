import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { isAdmin } from '../../common/utils/rbac.util';
import { forbidden } from '../../i18n/domain-error';
import type { AuthUser } from '../auth/auth.service';
import { AllowWithoutMembership, RequirePermission } from '../iam/require-permission';
import { SlowQueryService } from './slow-query.service';
// 必须是值导入：`import type` 会在运行时擦除，Nest 无法从 design:paramtypes
// 解析 DTO，ValidationPipe 的 forbidNonWhitelisted 会把所有参数判为未知属性。
import { SlowQueryListDto } from './dto/slow-query.dto';

/**
 * 运维面板 · 慢 SQL（phase: clklog-analytics-ops-console-v1）。
 *
 * 权限两道闸（PRD §2 / 架构 §4.4）：
 * ① `@RequirePermission('ops.runtime.access')` —— 权限码策略；
 * ② `isAdmin()` 显式校验 —— 身份事实兜底。
 *
 * 之所以要第二道：运维是**平台级**能力，与项目角色无关。`ops.*` 目前只有超管持有，
 * 但权限码是可配置的策略，用身份事实兜底可避免将来误配权限导致越权。
 */
@Controller('sa/api/ops')
export class SlowQueryController {
  constructor(private readonly service: SlowQueryService) {}

  @Get('slow-queries')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  list(@Query() query: SlowQueryListDto, @CurrentUser() user: AuthUser) {
    if (!isAdmin(user)) {
      throw forbidden({
        code: 'ops.admin.forbidden',
        messageKey: 'ops:error.admin.forbidden',
        message: '仅平台超管可访问运维面板',
      });
    }
    return this.service.list(query);
  }
}
