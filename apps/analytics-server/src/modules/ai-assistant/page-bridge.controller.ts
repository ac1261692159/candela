import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/auth.service';
import { PageBridgeService } from './page-bridge.service';
import {
  PageBridgeDecisionInput,
  PageBridgeSnapshotInput,
} from './page-bridge.types';

@Controller('sa/api/assistant/page-bridge')
export class PageBridgeController {
  constructor(private readonly bridge: PageBridgeService) {}

  @Post('disconnect')
  disconnect(@CurrentUser() user: AuthUser, @CurrentProject() project: string,
    @Body() body: { tab_id: string; revision: number }) {
    return this.bridge.disconnect(user, project, body.tab_id, body.revision);
  }

  @Post('snapshot')
  snapshot(
    @CurrentUser() user: AuthUser,
    @CurrentProject() project: string,
    @Body() body: PageBridgeSnapshotInput,
  ) {
    return this.bridge.updateSnapshot(user, project, body);
  }

  @Get('events')
  events(
    @CurrentUser() user: AuthUser,
    @CurrentProject() project: string,
    @Query('tab_id') tabId: string,
    @Query('after') after = '0',
  ) {
    return this.bridge.events(user, project, tabId, Number(after));
  }

  @Post('proposals/:id/decision')
  decision(
    @CurrentUser() user: AuthUser,
    @CurrentProject() project: string,
    @Param('id') id: string,
    @Body() body: PageBridgeDecisionInput,
  ) {
    return this.bridge.decide(user, project, id, body);
  }
}
