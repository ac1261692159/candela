import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { isAdmin } from '../../common/utils/rbac.util';
import { forbidden } from '../../i18n/domain-error';
import { localeFromRequest } from '../../i18n/locale';
import type { AuthUser } from '../auth/auth.service';
import { AllowWithoutMembership, RequirePermission } from '../iam/require-permission';
import { TimezoneService } from '../time/timezone.service';
import { formatInTz } from '../time/format';
import { AlertingService } from './alerting.service';
import { AlertTemplateService } from './alert-template.service';
import { AlertChannelConfigService } from './channels/channel-config.service';
import { AlertRetentionService } from './alert-retention.service';
import {
  AlertEventListDto,
  CreateAlertRuleDto,
  CreateContactDto,
  CreateMuteDto,
  NotificationListDto,
  PreviewTemplateDto,
  ProbeMetricDto,
  SaveChannelConfigDto,
  SaveRetentionDto,
  TestChannelDto,
  UpdateContactDto,
  UpdateAlertRuleDto,
  UpdateTemplateDto,
} from './dto/alerting.dto';

@Controller('sa/api/ops/alerts')
export class AlertingController {
  constructor(
    private readonly service: AlertingService,
    private readonly templates: AlertTemplateService,
    private readonly channelConfigs: AlertChannelConfigService,
    private readonly retention: AlertRetentionService,
    private readonly timezones: TimezoneService,
  ) {}

  private guard(user: AuthUser) {
    if (!isAdmin(user)) {
      throw forbidden({
        code: 'alerting.ops.forbidden',
        messageKey: 'alerting:error.ops.forbidden',
        message: '仅平台超管可访问运维面板',
      });
    }
  }

  @Get('rules')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async listRules(@CurrentUser() user: AuthUser) {
    this.guard(user);
    return this.service.listRules();
  }

  @Put('rules/:code')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async updateRule(
    @Param('code') code: string,
    @Body() body: UpdateAlertRuleDto,
    @CurrentUser() user: AuthUser,
  ) {
    this.guard(user);
    return this.service.updateRule(code, body, user.username);
  }

  @Post('rules')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async createRule(@Body() body: CreateAlertRuleDto, @CurrentUser() user: AuthUser) {
    this.guard(user);
    return this.service.createMetricRule(body, user.username);
  }

  @Delete('rules/:code')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async deleteRule(@Param('code') code: string, @CurrentUser() user: AuthUser) {
    this.guard(user);
    return this.service.deleteRule(code, user.username);
  }

  @Get('channels')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  channels(@CurrentUser() user: AuthUser) {
    this.guard(user);
    return this.service.channels();
  }

  /** 可选指标清单（数据管理 → 指标）；替代 alerting-v2 的 cards 接口 */
  @Get('metrics')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async listMetrics(@Query() query: NotificationListDto, @CurrentUser() user: AuthUser) {
    this.guard(user);
    return this.service.listAlertMetrics(query.project ?? '');
  }

  /** 指标测试取值：按窗口真实求值一次（有界）；数值单位按操作者语言渲染（i18n v1） */
  @Post('metrics/:metricId/probe')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async probeMetric(
    @Param('metricId') metricId: string,
    @Body() body: ProbeMetricDto,
    @Query() query: NotificationListDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    this.guard(user);
    return this.service.probeMetric(
      metricId,
      query.project ?? '',
      body?.window_days,
      body?.time_source,
      localeFromRequest(req),
    );
  }

  /** 通道配置页数据（配置 + 表单结构，密钥脱敏） */
  @Get('channel-configs')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async listChannelConfigs(@CurrentUser() user: AuthUser) {
    this.guard(user);
    return this.channelConfigs.list();
  }

  @Put('channel-configs/:channel')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async saveChannelConfig(
    @Param('channel') channel: string,
    @Body() body: SaveChannelConfigDto,
    @CurrentUser() user: AuthUser,
  ) {
    this.guard(user);
    return this.channelConfigs.save(channel, body, user.username);
  }

  /** 通道发送测试：用真实通道发一条测试消息，失败返回厂商原始错误；消息正文按操作者语言（i18n v1） */
  @Post('channel-configs/:channel/test')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async testChannel(
    @Param('channel') channel: string,
    @Body() body: TestChannelDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    this.guard(user);
    return this.channelConfigs.test(channel, body ?? {}, user.username, localeFromRequest(req));
  }

  /**
   * 通知模板：六个组合（触发/恢复 × 群聊/邮件/短信）的有效内容 + 占位符清单。
   * 未自定义的默认模板按**操作者**请求语言返回（x-locale / Accept-Language）；
   * 项目自定义模板原样返回，不翻译。
   */
  @Get('templates')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async listTemplates(
    @Query() query: NotificationListDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    this.guard(user);
    return this.templates.list(query.project ?? '', localeFromRequest(req));
  }

  @Put('templates/:kind/:channel')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async updateTemplate(
    @Param('kind') kind: string,
    @Param('channel') channel: string,
    @Body() body: UpdateTemplateDto,
    @Query() query: NotificationListDto,
    @CurrentUser() user: AuthUser,
  ) {
    this.guard(user);
    return this.templates.update(query.project ?? '', kind, channel, body, user.username);
  }

  @Delete('templates/:kind/:channel')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async resetTemplate(
    @Param('kind') kind: string,
    @Param('channel') channel: string,
    @Query() query: NotificationListDto,
    @CurrentUser() user: AuthUser,
  ) {
    this.guard(user);
    return this.templates.reset(query.project ?? '', kind, channel, user.username);
  }

  @Post('templates/preview')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async previewTemplate(
    @Body() body: PreviewTemplateDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    this.guard(user);
    // contact_id 为收件人预览：时间按该联系人时区渲染（timezone-v2；不存在的联系人由服务 404）
    let contextOverride: { time?: string } | undefined;
    if (body.contact_id != null) {
      const contact = await this.service.findContactForPreview(body.contact_id);
      contextOverride = { time: formatInTz(new Date(), contact.timezone ?? this.timezones.platformTz) };
    }
    return this.templates.preview(
      body.kind,
      body.channel,
      { subject: body.subject, body: body.body },
      localeFromRequest(req),
      contextOverride,
    );
  }

  @Get('events')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async listEvents(@Query() query: AlertEventListDto, @CurrentUser() user: AuthUser) {
    this.guard(user);
    return this.service.listEvents(query.status ?? 'all', query.limit ?? 50);
  }

  @Get('contacts')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async listContacts(@CurrentUser() user: AuthUser) {
    this.guard(user);
    return this.service.listContacts();
  }

  @Post('contacts')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async createContact(@Body() body: CreateContactDto, @CurrentUser() user: AuthUser) {
    this.guard(user);
    return this.service.createContact(body, user.username);
  }

  @Put('contacts/:id')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async updateContact(
    @Param('id') id: string,
    @Body() body: UpdateContactDto,
    @CurrentUser() user: AuthUser,
  ) {
    this.guard(user);
    return this.service.updateContact(id, body, user.username);
  }

  /** 数据保留策略：历史 / 通知记录 / 变更记录可分别设置（留空 = 永久） */
  @Get('retention')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async listRetention(@CurrentUser() user: AuthUser) {
    this.guard(user);
    return { items: await this.retention.list() };
  }

  @Put('retention/:scope')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async saveRetention(
    @Param('scope') scope: string,
    @Body() body: SaveRetentionDto,
    @CurrentUser() user: AuthUser,
  ) {
    this.guard(user);
    return this.retention.save(scope, body.retain_days ?? null, user.username);
  }

  @Delete('contacts/:id')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async deleteContact(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    this.guard(user);
    return this.service.deleteContact(id, user.username);
  }

  @Get('mutes')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async listMutes(@CurrentUser() user: AuthUser) {
    this.guard(user);
    return this.service.listMutes();
  }

  @Post('mutes')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async createMute(@Body() body: CreateMuteDto, @CurrentUser() user: AuthUser) {
    this.guard(user);
    return this.service.createMute(body, user.username);
  }

  @Delete('mutes/:id')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async deleteMute(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    this.guard(user);
    return this.service.deleteMute(id, user.username);
  }

  @Get('notifications')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async listNotifications(@Query() query: NotificationListDto, @CurrentUser() user: AuthUser) {
    this.guard(user);
    return this.service.listNotifications(query.limit ?? 50);
  }

  @Get('overview')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async overview(@CurrentUser() user: AuthUser) {
    this.guard(user);
    return this.service.overview();
  }

  /** 配置变更审计（alerting-v3）：规则/联系人/屏蔽的增删改 */
  @Get('audits')
  @AllowWithoutMembership()
  @RequirePermission('ops.runtime.access')
  async listAudits(@Query() query: NotificationListDto, @CurrentUser() user: AuthUser) {
    this.guard(user);
    return this.service.listAudits(query.limit ?? 50);
  }
}
