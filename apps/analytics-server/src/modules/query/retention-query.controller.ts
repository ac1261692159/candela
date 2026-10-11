import { Body, Controller, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { RetentionQueryService } from './retention-query.service';
import { RetentionQuery } from '../../types/dsl.types';
import { RequirePermission } from '../iam/require-permission';
import { respondWithKeepalive } from '../long-response/query-keepalive';
import { CurrentIam } from '../iam/current-iam.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.service';
import type { IamContext } from '../iam/iam.types';

@Controller('sa/api/query')
export class RetentionQueryController {
  constructor(private readonly service: RetentionQueryService) {}

  @Post('retention')
  @RequirePermission('model.query')
  async analyze(
    @CurrentProject() project: string,
    @CurrentIam() iam: IamContext,
    @CurrentUser() user: AuthUser,
    @Body() query: RetentionQuery,
    @Query('refresh') refresh: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    await respondWithKeepalive(res, 201, () =>
      this.service.analyze(query, project, refresh === 'true', iam.data_scope, user?.timezone ?? null),
    );
  }
}
