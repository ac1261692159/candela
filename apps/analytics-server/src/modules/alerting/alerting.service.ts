import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../shared/prisma.service';
import { maskAddress, resolveMuteWindow, type Comparator, type Severity } from './alert-eval';
import { channelDescriptor, isKnownChannel } from './channels/channel-registry';
import { validationError } from './channels/validation-issue';
import { MAX_METRIC_RULES, WINDOW_DAYS_OPTIONS } from './alert-metric-eval';
import { AlertMetricEvalService } from './alert-metric-eval.service';
import { AlertAuditService } from './alert-audit.service';
import { epochOfDayStart } from '../time/calendar';
import { TimezoneService } from '../time/timezone.service';
import { AlertNotifyService } from './alert-notify.service';
import type {
  CreateAlertRuleDto,
  CreateContactDto,
  CreateMuteDto,
  UpdateAlertRuleDto,
  UpdateContactDto,
} from './dto/alerting.dto';
import { badRequest, notFound } from '../../i18n/domain-error';
import { normalizeLocaleTag } from '../../i18n/locales';
import { contactLocale, contactTimezone } from './contact-normalize';

/** 规则健康状态（alerting-v4）：判定优先级见设计文档 §3.4 */
export type RuleHealth = 'ok' | 'metric_missing' | 'metric_eval_failed' | 'no_contact';

export const RULE_HEALTH_LABEL: Record<RuleHealth, string> = {
  ok: '正常',
  metric_missing: '引用失效：指标已删除',
  metric_eval_failed: '求值失败：连续多轮取不到指标值',
  no_contact: '无联系人：规则未绑定联系人，且系统里没有启用中的联系人',
};

/**
 * 健康标签与详情的中文兜底之外，另给 i18n 资源键（前端优先用 key 渲染）。
 * 标签 key 的取值与前端既有的简短展示口径一致（zh 界面逐字不变）。
 */
export const RULE_HEALTH_LABEL_KEY: Record<RuleHealth, string> = {
  ok: 'alerting:ruleHealth.ok',
  metric_missing: 'alerting:ruleHealth.metricMissing',
  metric_eval_failed: 'alerting:ruleHealth.evalFailed',
  no_contact: 'alerting:ruleHealth.noContact',
};

/** 健康详情（Tooltip）的资源键；带参数时参数一并下发，前端 t(key, params) 渲染 */
const RULE_HEALTH_DETAIL_KEY: Record<RuleHealth, string | null> = {
  ok: null,
  metric_missing: 'alerting:ruleHealth.detailMetricDeleted',
  metric_eval_failed: 'alerting:ruleHealth.detailEvalFailed',
  no_contact: 'alerting:ruleHealth.detailNoContact',
};

@Injectable()
export class AlertingService {
  private readonly logger = new Logger(AlertingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: AlertNotifyService,
    private readonly metricEval: AlertMetricEvalService,
    private readonly auditLog: AlertAuditService,
    // 缺省构造兜底纯单测；生产由 DI 注入
    private readonly timezones: TimezoneService = new TimezoneService(undefined),
  ) {}

  /** 配置变更审计（红线 6）：写 ops_action_log，失败只记日志不影响业务结果 */
  private async audit(action: string, target: string, detail: Record<string, unknown>, operator: string): Promise<void> {
    await this.auditLog.write(action, target, detail, operator);
  }

  /** 校验联系人存在（支持多联系人）：外键报错对用户不可读，这里提前给 400（验收 F3） */
  private async resolveContactIds(values: (string | null | undefined)[]): Promise<bigint[]> {
    const ids = values
      .filter((value): value is string => value !== null && value !== undefined && value !== '')
      .map((value) => {
        if (!/^\d+$/.test(String(value))) {
          throw badRequest({
            code: 'alerting.contact.idInvalid',
            messageKey: 'alerting:error.contact.idInvalid',
            message: 'contact_id 非法',
          });
        }
        return BigInt(value);
      });
    if (ids.length === 0) return [];
    const found = await this.prisma.alertContact.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    if (found.length !== new Set(ids.map(String)).size) {
      // 冻结的 spec（test/alerting/alert-contact-multi.spec.ts）断言 instanceof BadRequestException，
      // 不能用 i18n 的 DomainError 工厂；载荷按 DomainError 形状给（messageKey + params）。
      throw new BadRequestException({
        code: 'alerting.contact.notFound',
        message: '联系人不存在',
        messageKey: 'alerting:error.contact.notFound',
      });
    }
    return found.map((contact) => contact.id);
  }

  /** 规则的绑定联系人目标（去重后的字符串 id 列表） */
  private contactIdsOf(input: { contact_ids?: string[]; contact_id?: string | null }): string[] {
    const merged = [...(input.contact_ids ?? [])];
    if (input.contact_id) merged.push(input.contact_id);
    return Array.from(new Set(merged.filter((value) => Boolean(value))));
  }

  /** 写入规则的多联系人绑定（先清后建，保持幂等） */
  private async bindContacts(ruleCode: string, ids: bigint[]): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.alertRuleContact.deleteMany({ where: { rule_code: ruleCode } }),
      ...(ids.length > 0
        ? [
            this.prisma.alertRuleContact.createMany({
              data: ids.map((contactId) => ({ rule_code: ruleCode, contact_id: contactId })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);
  }

  /** 只取发生变化的字段，记「旧值 → 新值」，避免把整条规则写进审计 */
  private static diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [field, to] of Object.entries(after)) {
      const from = before[field];
      if (String(from ?? '') !== String(to ?? '')) changes[field] = { from: from ?? null, to: to ?? null };
    }
    return changes;
  }

  async listRules() {
    const rules = await this.prisma.alertRule.findMany({
      orderBy: { id: 'asc' },
      include: { contacts: { include: { contact: { select: { id: true, name: true, enabled: true } } } } },
    });
    const firing = await this.prisma.alertEvent.findMany({ where: { status: 'firing' } });
    const firingByCode = new Map(firing.map((event) => [event.rule_code, event]));
    // 健康度判定：一次批量查指标与启用联系人，避免逐条查库
    const metricIds = rules
      .filter((rule) => rule.source === 'metric' && rule.metric_id)
      .map((rule) => rule.metric_id as string);
    const metrics = metricIds.length
      ? await this.prisma.metaSavedMetric.findMany({
          where: { metric_id: { in: metricIds } },
          select: { metric_id: true, project_name: true, display_name: true, name: true },
        })
      : [];
    const metricBy = new Map(metrics.map((metric) => [metric.metric_id, metric]));
    // 「可达联系人」= 任意启用中的联系人（未绑定联系人的规则会发给全部启用联系人）
    const enabledContactCount = await this.prisma.alertContact.count({ where: { enabled: true } });
    return {
      items: rules.map((rule) => {
        const contacts = (rule.contacts ?? [])
          .map((link) => link.contact)
          .filter((contact): contact is { id: bigint; name: string; enabled: boolean } => Boolean(contact));
        const reachable = contacts.filter((contact) => contact.enabled);
        const { health, detail, detailKey, detailParams } = this.ruleHealth(
          rule,
          metricBy,
          enabledContactCount > 0,
          reachable.length,
        );
        const metric = rule.metric_id ? metricBy.get(rule.metric_id) : undefined;
        return {
          code: rule.code,
          name: rule.name,
          threshold: rule.threshold,
          enabled: rule.enabled,
          severity: rule.severity as Severity,
          comparator: rule.comparator as Comparator,
          unit: rule.unit,
          window_minutes: rule.window_minutes,
          for_windows: rule.for_windows,
          repeat_minutes: rule.repeat_minutes,
          notify_on_resolve: rule.notify_on_resolve,
          contact_id: reachable[0] ? String(reachable[0].id) : null,
          contact_ids: reachable.map((contact) => String(contact.id)),
          contact_names: reachable.map((contact) => contact.name),
          contact_name: reachable.length > 0 ? reachable.map((contact) => contact.name).join('、') : null,
          source: rule.source,
          metric_id: rule.metric_id,
          metric_name: metric ? metric.display_name || metric.name : null,
          window_days: rule.window_days,
          time_source: rule.time_source,
          project_name: rule.project_name,
          firing: firingByCode.has(rule.code),
          firing_value: firingByCode.get(rule.code)?.value ?? null,
          health,
          health_label_key: RULE_HEALTH_LABEL_KEY[health],
          health_detail: detail,
          health_detail_key: detailKey,
          health_detail_params: detailParams,
        };
      }),
    };
  }

  /**
   * 规则健康度（alerting-v4）：指标引用是否有效、求值是否持续失败、有没有可达的联系人。
   * 优先级 metric_missing > metric_eval_failed > no_contact > ok（设计文档 §3.4）。
   */
  private ruleHealth(
    rule: { code: string; source: string; metric_id: string | null; enabled: boolean },
    metricBy: Map<string, { metric_id: string; project_name: string; display_name: string; name: string }>,
    hasEnabledContact: boolean,
    boundContactCount = 0,
  ): {
    health: RuleHealth;
    detail: string;
    detailKey: string | null;
    detailParams: Record<string, string | number> | null;
  } {
    if (rule.source === 'metric') {
      if (!rule.metric_id) {
        return {
          health: 'metric_missing',
          detail: '规则未绑定指标',
          detailKey: 'alerting:ruleHealth.detailNoMetric',
          detailParams: null,
        };
      }
      const metric = metricBy.get(rule.metric_id);
      if (!metric) {
        return {
          health: 'metric_missing',
          detail: `指标 ${rule.metric_id} 已删除`,
          detailKey: RULE_HEALTH_DETAIL_KEY.metric_missing,
          detailParams: { metricId: rule.metric_id },
        };
      }
      if (this.metricEval.isBroken(rule.code)) {
        const failure = this.metricEval.failureOf(rule.code);
        const times = failure?.count ?? 0;
        const message = failure?.message ?? '未知原因';
        return {
          health: 'metric_eval_failed',
          detail: `连续 ${times} 轮求值失败：${message}`,
          detailKey: RULE_HEALTH_DETAIL_KEY.metric_eval_failed,
          detailParams: { times, message },
        };
      }
      return { health: 'ok', detail: '', detailKey: null, detailParams: null };
    }
    if (rule.enabled && boundContactCount === 0 && !hasEnabledContact) {
      return {
        health: 'no_contact',
        detail: RULE_HEALTH_LABEL.no_contact,
        detailKey: RULE_HEALTH_DETAIL_KEY.no_contact,
        detailParams: null,
      };
    }
    return { health: 'ok', detail: '', detailKey: null, detailParams: null };
  }

  async updateRule(code: string, input: UpdateAlertRuleDto, operator: string) {
    const existing = await this.prisma.alertRule.findUnique({ where: { code } });
    if (!existing) {
      throw notFound({
        code: 'alerting.rule.notFound',
        messageKey: 'alerting:error.rule.notFound',
        params: { code },
        message: `规则不存在: ${code}`,
      });
    }
    const data: Record<string, unknown> = {};
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.threshold !== undefined) data.threshold = input.threshold;
    if (input.severity !== undefined) data.severity = input.severity;
    if (input.comparator !== undefined) data.comparator = input.comparator;
    if (input.window_minutes !== undefined) data.window_minutes = input.window_minutes;
    if (input.window_days !== undefined) data.window_days = input.window_days;
    if (input.time_source !== undefined) data.time_source = input.time_source;
    if (input.for_windows !== undefined) data.for_windows = input.for_windows;
    if (input.repeat_minutes !== undefined) data.repeat_minutes = input.repeat_minutes;
    if (input.notify_on_resolve !== undefined) data.notify_on_resolve = input.notify_on_resolve;
    // 多联系人绑定与其它字段分开处理（绑定在规则更新后整体替换）
    const wantsContacts = input.contact_ids !== undefined || input.contact_id !== undefined;
    if (Object.keys(data).length === 0 && !wantsContacts) {
      throw badRequest({
        code: 'alerting.rule.noFields',
        messageKey: 'alerting:error.rule.noFields',
        message: '没有需要更新的字段',
      });
    }
    const beforeContacts = wantsContacts
      ? (
          await this.prisma.alertRuleContact.findMany({
            where: { rule_code: code },
            select: { contact_id: true },
          })
        ).map((row) => String(row.contact_id))
      : [];
    if (Object.keys(data).length > 0) await this.prisma.alertRule.update({ where: { code }, data });
    const changes = AlertingService.diff(existing as unknown as Record<string, unknown>, data);
    if (wantsContacts) {
      const ids = this.contactIdsOf(input);
      await this.bindContacts(code, await this.resolveContactIds(ids));
      if ([...beforeContacts].sort().join(',') !== [...ids].sort().join(',')) {
        changes.contact_ids = {
          from: beforeContacts.length > 0 ? beforeContacts : null,
          to: ids.length > 0 ? ids : null,
        };
      }
    }
    if (Object.keys(changes).length > 0) {
      await this.audit('alert_rule_update', 'alertrule', { code, name: existing.name, changes }, operator);
    }
    return { ok: true };
  }

  /**
   * 新建指标告警（alerting-v4）：观测源 = 数据管理里的已保存指标。
   * 与卡片刻度告警相比：不再依赖卡片缓存（不会因缓存过期静默失效），求值口径与工作台一致。
   */
  async createMetricRule(input: CreateAlertRuleDto, operator: string) {
    const metric = await this.prisma.metaSavedMetric.findUnique({
      where: { metric_id: input.metric_id },
    });
    if (!metric) {
      throw badRequest({
        code: 'alerting.rule.metricMissing',
        messageKey: 'alerting:error.rule.metricMissing',
        message: '指标不存在（请在「数据管理 → 指标」中先创建）',
      });
    }
    const windowDays = input.window_days ?? WINDOW_DAYS_OPTIONS[0];
    const count = await this.prisma.alertRule.count({ where: { source: 'metric' } });
    if (count >= MAX_METRIC_RULES) {
      throw badRequest({
        code: 'alerting.rule.metricLimit',
        messageKey: 'alerting:error.rule.metricLimit',
        params: { max: MAX_METRIC_RULES },
        message: `指标告警最多 ${MAX_METRIC_RULES} 条`,
      });
    }
    const code = `metric_${randomBytes(6).toString('hex')}`;
    const created = await this.prisma.alertRule.create({
      data: {
        code,
        name: input.name.trim(),
        threshold: input.threshold,
        enabled: true,
        severity: input.severity ?? 'warning',
        comparator: input.comparator ?? 'gt',
        unit: input.unit?.trim() ?? '',
        window_minutes: input.window_minutes ?? 1,
        window_days: windowDays,
        // 指标自带查询时间时跟随指标；显式 rule = 由本规则窗口指定（存量规则默认 rule，行为不变）
        time_source: input.time_source ?? 'rule',
        for_windows: input.for_windows ?? 1,
        repeat_minutes: input.repeat_minutes ?? 60,
        notify_on_resolve: input.notify_on_resolve ?? true,
        source: 'metric',
        metric_id: metric.metric_id,
        project_name: metric.project_name,
      },
    });
    const contactIds = await this.resolveContactIds(this.contactIdsOf(input));
    await this.bindContacts(created.code, contactIds);
    await this.audit(
      'alert_rule_create',
      'alertrule',
      {
        code: created.code,
        name: created.name,
        contact_ids: contactIds.map(String),
        metric_id: metric.metric_id,
        metric_name: metric.display_name || metric.name,
        window_days: windowDays,
        time_source: created.time_source,
        threshold: created.threshold,
        comparator: created.comparator,
        unit: created.unit,
      },
      operator,
    );
    return { code: created.code };
  }

  /** 删除规则：内置规则不可删（指标规则可删） */
  async deleteRule(code: string, operator: string) {
    const existing = await this.prisma.alertRule.findUnique({ where: { code } });
    if (!existing) {
      throw notFound({
        code: 'alerting.rule.notFound',
        messageKey: 'alerting:error.rule.notFound',
        params: { code },
        message: `规则不存在: ${code}`,
      });
    }
    if (existing.source === 'builtin') {
      throw badRequest({
        code: 'alerting.rule.builtinNotDeletable',
        messageKey: 'alerting:error.rule.builtinNotDeletable',
        message: '内置规则不可删除',
      });
    }
    await this.prisma.alertRule.delete({ where: { code } });
    await this.audit(
      'alert_rule_delete',
      'alertrule',
      { code, name: existing.name, source: existing.source, metric_id: existing.metric_id },
      operator,
    );
    return { ok: true };
  }

  /** 可选指标清单（数据管理 → 指标），供新建告警时选择 */
  async listAlertMetrics(project: string) {
    return { items: await this.metricEval.catalog(project) };
  }

  /** 指标「测试取值」：按窗口真实求值一次（有界：单次查询）；`locale` 为操作者语言（单位本地化） */
  async probeMetric(
    metricId: string,
    project: string,
    windowDays?: number,
    timeSource?: string,
    locale?: string | null,
  ) {
    return this.metricEval.probe(metricId, project, windowDays ?? WINDOW_DAYS_OPTIONS[0], timeSource, locale);
  }

  channels() {
    return this.notify.channels();
  }

  async listEvents(status: 'all' | 'firing' | 'resolved', limit: number) {
    const events = await this.prisma.alertEvent.findMany({
      where: status === 'all' ? {} : { status },
      orderBy: { fired_at: 'desc' },
      take: limit,
      include: { rule: { select: { name: true, severity: true, unit: true } } },
    });
    return {
      items: events.map((event) => ({
        id: String(event.id),
        rule_code: event.rule_code,
        rule_name: event.rule?.name ?? event.rule_code,
        severity: event.rule?.severity ?? 'warning',
        unit: event.rule?.unit ?? '',
        value: event.value,
        status: event.status,
        fired_at: event.fired_at.toISOString(),
        last_seen_at: event.last_seen_at.toISOString(),
        resolved_at: event.resolved_at?.toISOString() ?? null,
      })),
    };
  }

  /** 模板预览的联系人查询（SC-3：按联系人时区渲染预览时间）；不存在 → 404 */
  async findContactForPreview(id: number) {
    const contact = await this.prisma.alertContact.findUnique({ where: { id: BigInt(id) } });
    if (!contact) {
      throw badRequest({
        code: 'alerting.contact.notFound',
        messageKey: 'alerting:error.contact.notFound',
        params: { id },
        message: `联系人不存在：${id}`,
      });
    }
    return contact;
  }

  async listContacts() {
    const items = await this.prisma.alertContact.findMany({ orderBy: { id: 'asc' } });
    return {
      items: items.map((c) => ({
        id: String(c.id),
        name: c.name,
        kind: c.kind,
        webhook_url: maskAddress(c.kind, c.webhook_url || c.address),
        address: maskAddress(c.kind, c.address || c.webhook_url),
        enabled: c.enabled,
        is_default: c.is_default,
        locale: c.locale ?? null,
        timezone: c.timezone ?? null,
        created_at: c.created_at.toISOString(),
      })),
    };
  }

  async createContact(input: CreateContactDto, operator: string) {
    const kind = input.kind ?? 'feishu_webhook';
    const channels = await this.notify.channels();
    // 通道校验走注册表（每个通道自己的字段与规则），能力位来自平台配置
    if (!isKnownChannel(kind)) {
      throw badRequest({
        code: 'alerting.channel.unsupported',
        messageKey: 'alerting:error.channel.unsupported',
        params: { kind },
        message: `不支持的通道类型：${kind}`,
      });
    }
    const descriptor = channelDescriptor(kind);
    const capability = channels[kind];
    if (capability && !capability.available) {
      // 通道名以 `channel`（中文兜底）+ `channel_key`（资源键）成对下发：英文界面不再露出中文通道名
      throw badRequest({
        code: 'alerting.channel.unavailable',
        messageKey: 'alerting:error.channel.unavailable',
        params: {
          channel: descriptor.label,
          ...(descriptor.label_key ? { channel_key: descriptor.label_key } : {}),
        },
        message: capability.reason ?? `通道 ${descriptor.label} 当前不可用`,
      });
    }
    const webhookUrl = input.webhook_url?.trim() ?? '';
    const address = input.address?.trim() ?? '';
    const options = input.options ?? {};
    const validation = descriptor.validateContact({
      kind,
      webhook_url: webhookUrl,
      address,
      options,
    });
    // 校验失败：message 中文逐字兜底 + messageKey/params 由前端按当前语言渲染（i18n v1）
    if (validation) throw validationError('alerting.contact.invalid', validation);
    const optionsJson = options && Object.keys(options).length > 0 ? JSON.stringify(options) : null;
    const created = await this.prisma.alertContact.create({
      data: {
        name: input.name.trim(),
        kind,
        webhook_url: webhookUrl,
        address,
        options_json: optionsJson,
        enabled: input.enabled ?? true,
        locale: contactLocale(input.locale),
        timezone: contactTimezone(input.timezone),
      },
    });
    // 审计只记脱敏地址，绝不写 webhook / 邮箱 / 手机号明文（红线 3）
    await this.audit(
      'alert_contact_create',
      'alertcontact',
      {
        id: String(created.id),
        name: created.name,
        kind,
        address: maskAddress(kind, webhookUrl || address),
        enabled: created.enabled,
      },
      operator,
    );
    return { id: String(created.id) };
  }

  /** 编辑联系人（名称/通道/地址/选项/启用）；通道变更时校验该通道字段 */
  async updateContact(id: string, input: UpdateContactDto, operator: string) {
    const existing = await this.prisma.alertContact.findUnique({ where: { id: BigInt(id) } });
    if (!existing) throw contactNotFound();
    const kind = input.kind ?? existing.kind;
    if (!isKnownChannel(kind)) {
      throw badRequest({
        code: 'alerting.channel.unsupported',
        messageKey: 'alerting:error.channel.unsupported',
        params: { kind },
        message: `不支持的通道类型：${kind}`,
      });
    }
    const descriptor = channelDescriptor(kind);
    // 列表接口给的是脱敏地址，编辑弹窗不回填；这里再兜一层：空串或与掩码一致都视为「未修改」
    const maskedTarget = maskAddress(existing.kind, existing.webhook_url || existing.address);
    const maskedAddress = maskAddress(existing.kind, existing.address || existing.webhook_url);
    const webhookInput = input.webhook_url?.trim();
    const addressInput = input.address?.trim();
    const webhookUrl =
      !webhookInput || webhookInput === maskedTarget ? existing.webhook_url : webhookInput;
    const address = !addressInput || addressInput === maskedAddress ? existing.address : addressInput;
    const currentOptions = existing.options_json
      ? (JSON.parse(existing.options_json) as Record<string, unknown>)
      : {};
    const options = input.options !== undefined ? input.options : currentOptions;
    const validation = descriptor.validateContact({ kind, webhook_url: webhookUrl, address, options });
    if (validation) throw validationError('alerting.contact.invalid', validation);

    const data: Record<string, unknown> = {
      kind,
      webhook_url: webhookUrl,
      address,
      options_json: Object.keys(options).length > 0 ? JSON.stringify(options) : null,
    };
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.locale !== undefined) data.locale = contactLocale(input.locale);
    if (input.timezone !== undefined) data.timezone = contactTimezone(input.timezone);
    await this.prisma.alertContact.update({ where: { id: existing.id }, data });
    const changes = AlertingService.diff(
      { name: existing.name, kind: existing.kind, enabled: existing.enabled, target: existing.webhook_url || existing.address },
      { name: data.name ?? existing.name, kind, enabled: data.enabled ?? existing.enabled, target: webhookUrl || address },
    );
    const masked: Record<string, unknown> = {};
    for (const [field, pair] of Object.entries(changes)) {
      masked[field] =
        field === 'target'
          ? { from: maskAddress(existing.kind, String(pair.from ?? '')), to: maskAddress(kind, String(pair.to ?? '')) }
          : pair;
    }
    if (Object.keys(masked).length > 0) {
      await this.audit('alert_contact_update', 'alertcontact', { id, name: existing.name, changes: masked }, operator);
    }
    return { ok: true };
  }

  async deleteContact(id: string, operator: string) {
    const contact = await this.prisma.alertContact.findUnique({ where: { id: BigInt(id) } });
    try {
      await this.prisma.alertContact.delete({ where: { id: BigInt(id) } });
    } catch {
      throw contactNotFound();
    }
    await this.audit(
      'alert_contact_delete',
      'alertcontact',
      { id, name: contact?.name ?? '', kind: contact?.kind ?? '' },
      operator,
    );
    return { ok: true };
  }

  async listMutes() {
    const now = new Date();
    const items = await this.prisma.alertMute.findMany({
      where: { ends_at: { gte: now } },
      orderBy: { starts_at: 'asc' },
    });
    return {
      items: items.map((m) => ({
        id: String(m.id),
        rule_code: m.rule_code,
        starts_at: m.starts_at.toISOString(),
        ends_at: m.ends_at.toISOString(),
        reason: m.reason,
      })),
    };
  }

  async createMute(input: CreateMuteDto, operator: string) {
    const window = resolveMuteWindow(input);
    if (!window) {
      throw badRequest({
        code: 'alerting.mute.windowInvalid',
        messageKey: 'alerting:error.mute.windowInvalid',
        message: '屏蔽时间无效',
      });
    }
    const created = await this.prisma.alertMute.create({
      data: {
        rule_code: input.rule_code || null,
        starts_at: window.starts,
        ends_at: window.ends,
        reason: input.reason?.trim() ?? '',
      },
    });
    await this.audit(
      'alert_mute_create',
      'alertmute',
      {
        id: String(created.id),
        rule_code: created.rule_code ?? '(全局)',
        starts_at: created.starts_at.toISOString(),
        ends_at: created.ends_at.toISOString(),
        reason: created.reason,
      },
      operator,
    );
    return { id: String(created.id) };
  }

  async deleteMute(id: string, operator: string) {
    const existing = await this.prisma.alertMute.findUnique({ where: { id: BigInt(id) } });
    try {
      await this.prisma.alertMute.delete({ where: { id: BigInt(id) } });
    } catch {
      throw notFound({
        code: 'alerting.mute.notFound',
        messageKey: 'alerting:error.mute.notFound',
        message: '屏蔽不存在',
      });
    }
    await this.audit(
      'alert_mute_delete',
      'alertmute',
      { id, rule_code: existing?.rule_code ?? '(全局)', reason: existing?.reason ?? '' },
      operator,
    );
    return { ok: true };
  }

  async listNotifications(limit: number) {
    const items = await this.prisma.alertNotification.findMany({
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return {
      items: items.map((n) => ({
        id: String(n.id),
        rule_code: n.rule_code,
        event_id: n.event_id ? String(n.event_id) : null,
        kind: n.kind,
        status: n.status,
        error: n.error,
        contact_id: n.contact_id ? String(n.contact_id) : null,
        contact_name: n.contact_name,
        created_at: n.created_at.toISOString(),
      })),
    };
  }

  async overview() {
    // 「今日」按平台日历零点（ZQ-5：原进程本地零点会随宿主时区漂移）
    const start = new Date(epochOfDayStart(this.timezones.platformTz, this.timezones.todayYmd()));
    const [firedToday, unresolved, notifyFail, top] = await Promise.all([
      this.prisma.alertEvent.count({ where: { fired_at: { gte: start } } }),
      this.prisma.alertEvent.count({ where: { status: 'firing' } }),
      this.prisma.alertNotification.count({ where: { created_at: { gte: start }, status: 'fail' } }),
      this.prisma.alertEvent.groupBy({
        by: ['rule_code'],
        where: { fired_at: { gte: start } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 5,
      }),
    ]);
    const names = await this.prisma.alertRule.findMany({
      where: { code: { in: top.map((t) => t.rule_code) } },
      select: { code: true, name: true },
    });
    const nameBy = new Map(names.map((n) => [n.code, n.name]));

    // 健康度汇总（PRD G1）：无联系人 / 失效规则 / 近 24 小时通知失败
    const [rules, contacts, enabledContacts, notifyFail24h] = await Promise.all([
      this.listRules(),
      this.prisma.alertContact.count(),
      this.prisma.alertContact.count({ where: { enabled: true } }),
      this.prisma.alertNotification.count({
        where: { created_at: { gte: new Date(Date.now() - 86_400_000) }, status: 'fail' },
      }),
    ]);
    const enabledRules = rules.items.filter((rule) => rule.enabled);
    const broken = enabledRules.filter(
      (rule) => rule.health === 'metric_missing' || rule.health === 'metric_eval_failed',
    );

    return {
      fired_today: firedToday,
      unresolved,
      notify_fail_today: notifyFail,
      top_rules: top.map((t) => ({
        rule_code: t.rule_code,
        rule_name: nameBy.get(t.rule_code) ?? t.rule_code,
        count: t._count.id,
      })),
      health: {
        contacts,
        has_enabled_contact: enabledContacts > 0,
        enabled_contacts: enabledContacts,
        broken_rules: broken.length,
        broken_rule_names: broken.map((rule) => rule.name).slice(0, 5),
        no_contact_rules: enabledRules.filter((rule) => rule.health === 'no_contact').length,
        notify_fail_24h: notifyFail24h,
      },
    };
  }

  /** 告警配置变更审计（phase: alerting-v3）：ops_action_log 中 alert_ 前缀的最近记录 */
  async listAudits(limit: number) {
    const take = Math.min(200, Math.max(1, Math.trunc(limit) || 50));
    const rows = await this.prisma.opsActionLog.findMany({
      where: { action: { startsWith: 'alert_' } },
      orderBy: { created_at: 'desc' },
      take,
    });
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        action: row.action,
        target_table: row.target_table,
        detail: row.detail,
        operator: row.operator,
        created_at: row.created_at.toISOString(),
      })),
    };
  }
}

/** 联系人不存在（编辑 / 删除共用；文案逐字不变） */
function contactNotFound() {
  return notFound({
    code: 'alerting.contact.notFound',
    messageKey: 'alerting:error.contact.notFound',
    message: '联系人不存在',
  });
}
