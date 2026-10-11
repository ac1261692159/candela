import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { badRequest } from '../../i18n/domain-error';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { EventQueryService } from './event-query.service';
import { EventAnalysisQuery, FunnelQuery, RetentionQuery } from '../../types/dsl.types';
import { DslValidatorService } from './dsl-validator.service';
import { RequirePermission } from '../iam/require-permission';
import { respondWithKeepalive } from '../long-response/query-keepalive';
import { CurrentIam } from '../iam/current-iam.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.service';
import type { IamContext } from '../iam/iam.types';

@Controller('sa/api/query')
export class EventQueryController {
  constructor(private readonly service: EventQueryService, private readonly validator: DslValidatorService) {}

  @Get('capabilities')
  @RequirePermission('model.query')
  capabilities() { return this.validator.capabilities(); }

  @Post('validate')
  @RequirePermission('model.query')
  validate(@CurrentProject() project: string, @Body() body: { page: string; dsl: Record<string, unknown> }) {
    if (!body?.dsl || typeof body.dsl !== 'object' || Array.isArray(body.dsl)) {
      throw badRequest({
        code: 'analysis.dsl.notObject',
        messageKey: 'analysis:error.dsl.notObject',
        message: 'dsl 必须是对象',
      });
    }
    const dsl = { ...body.dsl, project };
    if (body.page === 'event') this.validator.validateEventQuery(dsl as unknown as EventAnalysisQuery);
    else if (body.page === 'funnel') this.validator.validateFunnelQuery(dsl as unknown as FunnelQuery);
    else if (body.page === 'retention') this.validator.validateRetentionQuery(dsl as unknown as RetentionQuery);
    else {
      throw badRequest({
        code: 'analysis.dsl.pageInvalid',
        messageKey: 'analysis:error.dsl.pageInvalid',
        message: 'analysis_page_invalid',
      });
    }
    const { project: _project, ...validated } = dsl;
    return validated;
  }

  @Post('event')
  @RequirePermission('model.query')
  async analyze(
    @CurrentProject() project: string,
    @CurrentIam() iam: IamContext,
    @CurrentUser() user: AuthUser,
    @Body() query: EventAnalysisQuery,
    @Query('refresh') refresh: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    await respondWithKeepalive(res, 201, () =>
      this.service.analyze(query, project, refresh === 'true', iam.data_scope, user?.timezone ?? null),
    );
  }
}
