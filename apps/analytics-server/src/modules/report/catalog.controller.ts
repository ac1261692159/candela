import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiKeyIdentity,
  CurrentApiKey,
  RequireApiKey,
} from '../../common/decorators/api-key.decorator';
import { catalogIamContext } from '../iam/catalog-iam';
import { AuthUser } from '../auth/auth.service';
import { CardService } from './card.service';
import { DashboardService } from './dashboard.service';
import { CatalogExecuteCardDto } from './dto/catalog.dto';

/**
 * API Key 目录：列出绑定项目下的看板/卡片，并对 SQL 卡执行。
 * 认证与 `/sa/api/ai/query` 相同（X-API-Key / Bearer）。
 * Key 无 user_id，按绑定 project 列出该项目全部资产（不跨项目）。
 */
@RequireApiKey()
@Controller('sa/api/catalog')
export class CatalogController {
  constructor(
    private readonly dashboards: DashboardService,
    private readonly cards: CardService,
  ) {}

  /** GET /sa/api/catalog/dashboards */
  @Get('dashboards')
  listDashboards(@CurrentApiKey() identity: ApiKeyIdentity) {
    return this.dashboards.list(identity.project_name, this.catalogUser(identity), catalogIamContext());
  }

  /** GET /sa/api/catalog/dashboards/:dbId 卡片元数据，不含未执行结果 */
  @Get('dashboards/:dbId')
  getDashboard(@Param('dbId') dbId: string, @CurrentApiKey() identity: ApiKeyIdentity) {
    return this.dashboards.getDetail(dbId, identity.project_name, this.catalogUser(identity), catalogIamContext());
  }

  /** GET /sa/api/catalog/cards?type=sql */
  @Get('cards')
  listCards(
    @Query('type') type: string | undefined,
    @CurrentApiKey() identity: ApiKeyIdentity,
  ) {
    return this.cards.list(identity.project_name, this.catalogUser(identity), catalogIamContext(), type || undefined);
  }

  /** GET /sa/api/catalog/cards/:cardId */
  @Get('cards/:cardId')
  getCard(@Param('cardId') cardId: string, @CurrentApiKey() identity: ApiKeyIdentity) {
    return this.cards.get(cardId, identity.project_name, this.catalogUser(identity), catalogIamContext());
  }

  /** POST /sa/api/catalog/cards/:cardId/execute 仅 type=sql */
  @Post('cards/:cardId/execute')
  executeCard(
    @Param('cardId') cardId: string,
    @Body() dto: CatalogExecuteCardDto,
    @CurrentApiKey() identity: ApiKeyIdentity,
  ) {
    return this.cards.executeSql(cardId, identity.project_name, this.catalogUser(identity), catalogIamContext(), {
      time_range: dto.time_range,
      limit: dto.limit,
    });
  }

  private catalogUser(identity: ApiKeyIdentity): AuthUser {
    return {
      id: `apikey:${identity.id}`,
      username: identity.name,
      display_name: identity.name,
      platform_role: 'none',
    };
  }
}
