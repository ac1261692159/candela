import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuthUser } from '../auth/auth.service';
import { DashboardService } from './dashboard.service';
import { CardService } from './card.service';
import { CreateDashboardDto, UpdateDashboardDto } from './dto/dashboard.dto';
import { SaveDashboardLayoutDto } from './dto/card.dto';
import { CurrentIam } from '../iam/current-iam.decorator';
import type { IamContext } from '../iam/iam.types';
import { RequirePermission } from '../iam/require-permission';
import type { AssetAclGrant } from '../iam/asset-policy.service';

@Controller('sa/api/report/dashboards')
export class DashboardController {
  constructor(
    private readonly service: DashboardService,
    private readonly cards: CardService,
  ) {}

  @Get()
  @RequirePermission('dashboard.view')
  list(@CurrentProject() project: string, @CurrentUser() user: AuthUser, @CurrentIam() iam: IamContext) {
    return this.service.list(project, user, iam);
  }

  @Post()
  @RequirePermission('dashboard.edit')
  create(@Body() dto: CreateDashboardDto, @CurrentProject() project: string, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, project, user);
  }

  @Put(':dbId/layout')
  @RequirePermission('dashboard.edit')
  saveLayout(
    @Param('dbId') dbId: string,
    @Body() dto: SaveDashboardLayoutDto,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.cards.saveLayouts(dbId, project, user, iam, dto);
  }

  @Post(':dbId/lock')
  @RequirePermission('asset.lock')
  lock(
    @Param('dbId') dbId: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Body() body: { locked: boolean; lock_cards?: boolean },
  ) {
    return this.service.lock(dbId, project, user, iam, body);
  }

  @Put(':dbId/acl')
  @RequirePermission('asset.grant')
  putAcl(
    @Param('dbId') dbId: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
    @Body() body: { grants: AssetAclGrant[] },
  ) {
    return this.service.putAcl(dbId, project, user, iam, body.grants ?? []);
  }

  @Get(':dbId/acl')
  @RequirePermission('asset.grant')
  listAcl(@Param('dbId') dbId: string, @CurrentProject() project: string) {
    return this.service.listAcl(dbId, project);
  }

  @Put(':dbId')
  @RequirePermission('dashboard.edit')
  update(
    @Param('dbId') dbId: string,
    @Body() dto: UpdateDashboardDto,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.service.update(dbId, project, user, iam, dto);
  }

  @Delete(':dbId')
  @RequirePermission('dashboard.edit')
  delete(
    @Param('dbId') dbId: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.service.delete(dbId, project, user, iam);
  }

  @Public()
  @Get('share/:token')
  share(@Param('token') token: string) {
    return this.service.getByShareToken(token);
  }

  @Get(':dbId')
  @RequirePermission('dashboard.view')
  detail(
    @Param('dbId') dbId: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.service.getDetail(dbId, project, user, iam);
  }
}
