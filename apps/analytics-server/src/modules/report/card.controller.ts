import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/auth.service';
import { CardService } from './card.service';
import { respondWithKeepalive } from '../long-response/query-keepalive';
import {
  CreateCardDto,
  UpdateCardDto,
  AddCardToDashboardDto,
  UpdateCardLayoutDto,
  UpdateCardDisplayDto,
  ReorderCardsDto,
} from './dto/card.dto';
import { CatalogExecuteCardDto } from './dto/catalog.dto';
import { CurrentIam } from '../iam/current-iam.decorator';
import type { IamContext } from '../iam/iam.types';
import { RequirePermission } from '../iam/require-permission';
import type { AssetAclGrant } from '../iam/asset-policy.service';

@Controller('sa/api/report/cards')
export class GlobalCardController {
  constructor(private readonly service: CardService) {}

  @Get()
  @RequirePermission('model.card_save')
  list(
    @Query('type') type: string | undefined,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.service.list(project, user, iam, type || undefined);
  }

  @Post()
  @RequirePermission('model.card_save')
  create(@Body() dto: CreateCardDto, @CurrentProject() project: string, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, project, user);
  }

  @Get(':cardId')
  @RequirePermission('model.card_save')
  get(
    @Param('cardId') cardId: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.service.get(cardId, project, user, iam);
  }

  @Post(':cardId/execute')
  @RequirePermission('model.sql')
  async executeSql(
    @Param('cardId') cardId: string,
    @Body() dto: CatalogExecuteCardDto,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Res() res: Response,
  ): Promise<void> {
    // 目录执行与 SQL 页面共用同一条执行链路，同样可能跑满墙钟 → 心跳保活
    await respondWithKeepalive(res, 201, () =>
      this.service.executeSql(cardId, project, user, iam, {
        time_range: dto?.time_range,
        limit: dto?.limit,
      }),
    );
  }

  @Post(':cardId/lock')
  @RequirePermission('asset.lock')
  lock(
    @Param('cardId') cardId: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Query('confirm') confirm?: string,
    @Body() body?: { locked?: boolean; confirm?: boolean },
  ) {
    return this.service.lock(
      cardId,
      project,
      user,
      iam,
      body?.locked !== false,
      body?.confirm === true || confirm === '1',
    );
  }

  @Get(':cardId/acl')
  @RequirePermission('asset.grant')
  listAcl(@Param('cardId') cardId: string, @CurrentProject() project: string) {
    return this.service.listAcl(cardId, project);
  }

  @Put(':cardId/acl')
  @RequirePermission('asset.grant')
  putAcl(
    @Param('cardId') cardId: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Body() body: { grants: AssetAclGrant[] },
  ) {
    return this.service.putAcl(cardId, project, user, iam, body.grants ?? []);
  }

  @Put(':cardId')
  @RequirePermission('model.card_save')
  update(
    @Param('cardId') cardId: string,
    @Body() dto: UpdateCardDto,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.service.update(cardId, project, user, iam, dto);
  }

  @Delete(':cardId')
  @RequirePermission('model.card_save')
  delete(
    @Param('cardId') cardId: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.service.delete(cardId, project, user, iam);
  }
}

@Controller('sa/api/report/dashboards/:dbId/cards')
export class CardLinkController {
  constructor(private readonly service: CardService) {}

  @Get()
  @RequirePermission('dashboard.view')
  list(
    @Param('dbId') dbId: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.service.listByDashboard(dbId, project, user, iam);
  }

  @Post()
  @RequirePermission('dashboard.edit')
  addToDashboard(
    @Param('dbId') dbId: string,
    @Body() dto: AddCardToDashboardDto,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.service.addToDashboard(dbId, project, user, iam, dto);
  }

  @Put(':cardId/display')
  @RequirePermission('dashboard.edit')
  updateDisplay(
    @Param('dbId') dbId: string,
    @Param('cardId') cardId: string,
    @Body() dto: UpdateCardDisplayDto,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.service.updateDisplay(cardId, dbId, project, user, iam, dto);
  }

  @Put(':cardId')
  @RequirePermission('dashboard.edit')
  updateLayout(
    @Param('dbId') dbId: string,
    @Param('cardId') cardId: string,
    @Body() dto: UpdateCardLayoutDto,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.service.updateLayout(cardId, dbId, project, user, iam, dto);
  }

  @Delete(':cardId')
  @RequirePermission('dashboard.edit')
  removeFromDashboard(
    @Param('dbId') dbId: string,
    @Param('cardId') cardId: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.service.removeFromDashboard(cardId, dbId, project, user, iam);
  }

  @Post('reorder')
  @RequirePermission('dashboard.edit')
  reorder(
    @Param('dbId') dbId: string,
    @Body() dto: ReorderCardsDto,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.service.reorder(dbId, project, user, iam, dto);
  }

  @Post(':cardId/refresh')
  @RequirePermission('dashboard.view')
  async refresh(
    @Param('dbId') dbId: string,
    @Param('cardId') cardId: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Res() res: Response,
  ): Promise<void> {
    // 卡片刷新可能跑满 ClickHouse 墙钟，走心跳保活（见 long-response/query-keepalive.ts）
    await respondWithKeepalive(res, 201, () => this.service.refresh(cardId, dbId, project, user, iam));
  }
}
