import { Body, Controller, Delete, Get, Param, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../auth/auth.service';
import { SchemaService } from './schema.service';
import { SqlReportService } from './sql-report.service';
import { respondWithKeepalive } from '../long-response/query-keepalive';
import { ExecuteSqlDto, SaveSqlReportDto } from './dto/sql-report.dto';
import { CurrentIam } from '../iam/current-iam.decorator';
import type { IamContext } from '../iam/iam.types';
import { RequirePermission } from '../iam/require-permission';

@Controller('sa/api/report')
export class SqlReportController {
  constructor(
    private readonly sqlReportService: SqlReportService,
    private readonly schemaService: SchemaService,
  ) {}

  @Get('schema')
  @RequirePermission('model.sql')
  schema(@CurrentProject() project: string, @CurrentIam() iam: IamContext) {
    return this.schemaService.getSchema(project, iam.data_scope);
  }

  /**
   * 执行自定义 SQL。走库直写响应（`@Res()` 非 passthrough）：查询可能跑满 ClickHouse
   * 300 秒墙钟，期间靠心跳字节保住连接，而心跳一旦写出响应头就定型，Nest 的响应
   * 拦截器无法再改状态码，因此这里自行落信封（形状与 ResponseInterceptor 一致）。
   */
  @Post('sql/execute')
  @RequirePermission('model.sql')
  async execute(
    @Body() dto: ExecuteSqlDto,
    @CurrentProject() project: string,
    @CurrentIam() iam: IamContext,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    // 201 = Nest 对 POST 的默认状态（库直写模式下需自行给出）
    await respondWithKeepalive(res, 201, (signal) =>
      this.sqlReportService.execute(dto, project, undefined, iam.data_scope, user?.timezone ?? null, signal),
    );
  }

  @Post('sql/save')
  @RequirePermission('model.card_save')
  save(@Body() dto: SaveSqlReportDto, @CurrentProject() project: string, @CurrentUser() user: AuthUser) {
    return this.sqlReportService.save(dto, project, user);
  }

  @Get('sql')
  @RequirePermission('model.sql')
  list(@CurrentProject() project: string, @CurrentUser() user: AuthUser, @CurrentIam() iam: IamContext) {
    return this.sqlReportService.list(project, user, iam);
  }

  @Get('sql/:id')
  @RequirePermission('model.sql')
  get(
    @Param('id') id: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.sqlReportService.get(id, project, user, iam);
  }

  @Put('sql/:id')
  @RequirePermission('model.card_save')
  update(
    @Param('id') id: string,
    @Body() dto: SaveSqlReportDto,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.sqlReportService.update(id, dto, project, user, iam);
  }

  @Delete('sql/:id')
  @RequirePermission('model.card_save')
  remove(
    @Param('id') id: string,
    @CurrentProject() project: string,
    @CurrentUser() user: AuthUser,
    @CurrentIam() iam: IamContext,
  ) {
    return this.sqlReportService.remove(id, project, user, iam);
  }
}
