import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { AlertAuditService } from './alert-audit.service';
import { badRequest } from '../../i18n/domain-error';
import {
  ALERT_CHANNELS,
  ALERT_KINDS,
  CHANNEL_LABEL,
  KIND_LABEL,
  KIND_LABEL_KEY,
  TEMPLATE_VARS,
  defaultTemplate,
  renderForChannel,
  sampleContext,
  sampleFor,
  validateTemplate,
  type AlertChannel,
  type AlertKind,
  type RenderedTemplate,
  type TemplateContent,
  type TemplateContext,
} from './alert-template';

export interface AlertTemplateItem extends TemplateContent {
  kind: AlertKind;
  kind_label: string;
  /** 事件类型名的前端资源键（前端优先用 key；`kind_label` 仅兜底） */
  kind_label_key: string;
  channel: AlertChannel;
  channel_label: string;
  is_default: boolean;
  updated_by: string | null;
  updated_at: string | null;
}

const CACHE_TTL_MS = 60_000;

/**
 * 告警通知模板（phase: clklog-analytics-alerting-v4）。
 *
 * 解析优先级：项目级自定义（alerttemplate 表）→ 代码内置默认模板（预填充占位符）。
 * 检测器在同一进程内取模板，保存/恢复默认后立即失效缓存（另有 60s TTL 兜底）。
 */
@Injectable()
export class AlertTemplateService {
  private readonly cache = new Map<string, { at: number; content: TemplateContent; isDefault: boolean }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AlertAuditService,
  ) {}

  static isKind(value: string): value is AlertKind {
    return (ALERT_KINDS as string[]).includes(value);
  }

  static isChannel(value: string): value is AlertChannel {
    return (ALERT_CHANNELS as string[]).includes(value);
  }

  variables() {
    return TEMPLATE_VARS;
  }

  /**
   * 六个组合的有效模板（自定义 + 默认），供编辑器展示。
   * `locale` 为**操作者**语言（i18n v1 漏网点补齐）：未自定义时返回该语言的默认模板，
   * 与投递侧「按收件人语言取默认模板」口径一致；**项目自定义模板原样返回、不翻译**。
   * 占位符清单的 `sample` 同步本地化（前端 Tooltip 直接展示它）。
   */
  async list(project: string, locale?: string | null): Promise<{ items: AlertTemplateItem[]; variables: typeof TEMPLATE_VARS }> {
    const rows = await this.prisma.alertTemplate.findMany({ where: { project_name: project } });
    const byKey = new Map(rows.map((row) => [`${row.kind}:${row.channel}`, row]));
    const items: AlertTemplateItem[] = [];
    for (const kind of ALERT_KINDS) {
      for (const channel of ALERT_CHANNELS) {
        const row = byKey.get(`${kind}:${channel}`);
        const fallback = defaultTemplate(kind, channel, locale);
        items.push({
          kind,
          kind_label: KIND_LABEL[kind],
          kind_label_key: KIND_LABEL_KEY[kind],
          channel,
          channel_label: CHANNEL_LABEL[channel],
          subject: row?.subject || fallback.subject,
          body: row?.body ?? fallback.body,
          is_default: !row,
          updated_by: row?.updated_by ?? null,
          updated_at: row?.updated_at?.toISOString() ?? null,
        });
      }
    }
    const variables = TEMPLATE_VARS.map((item) => ({ ...item, sample: sampleFor(item, locale) }));
    return { items, variables };
  }

  /** 保存自定义模板（语法非法 → 400，不落库） */
  async update(
    project: string,
    kind: string,
    channel: string,
    input: { subject?: string; body: string },
    operator: string,
  ): Promise<{ ok: boolean }> {
    const target = this.assertKindChannel(kind, channel);
    const body = typeof input?.body === 'string' ? input.body : '';
    const error = validateTemplate(body);
    if (error) {
      throw badRequest({
        code: 'alerting.template.syntaxError',
        messageKey: 'alerting:error.template.syntaxError',
        params: { error },
        message: `模板语法错误：${error}`,
      });
    }
    const subject = typeof input?.subject === 'string' ? input.subject : '';
    if (subject) {
      const subjectError = validateTemplate(subject);
      if (subjectError) {
        throw badRequest({
          code: 'alerting.template.subjectSyntaxError',
          messageKey: 'alerting:error.template.subjectSyntaxError',
          params: { error: subjectError },
          message: `邮件主题语法错误：${subjectError}`,
        });
      }
    }
    await this.prisma.alertTemplate.upsert({
      where: {
        project_name_kind_channel: { project_name: project, kind: target.kind, channel: target.channel },
      },
      create: {
        project_name: project,
        kind: target.kind,
        channel: target.channel,
        subject,
        body,
        updated_by: operator,
      },
      update: { subject, body, updated_by: operator },
    });
    this.cache.delete(`${project}:${target.kind}:${target.channel}`);
    await this.audit.write(
      'alert_template_update',
      'alerttemplate',
      { project, kind: target.kind, channel: target.channel, body_length: body.length, subject },
      operator,
    );
    return { ok: true };
  }

  /** 恢复默认：删除自定义覆盖 */
  async reset(project: string, kind: string, channel: string, operator: string): Promise<{ ok: boolean }> {
    const target = this.assertKindChannel(kind, channel);
    const deleted = await this.prisma.alertTemplate.deleteMany({
      where: { project_name: project, kind: target.kind, channel: target.channel },
    });
    this.cache.delete(`${project}:${target.kind}:${target.channel}`);
    await this.audit.write(
      'alert_template_reset',
      'alerttemplate',
      { project, kind: target.kind, channel: target.channel, deleted: deleted.count },
      operator,
    );
    return { ok: true };
  }

  /**
   * 预览：用示例数据渲染（不发送任何通知）。
   * `locale` 为操作者语言：未传正文时用该语言的默认模板渲染，与列表口径一致。
   */
  preview(
    kind: string,
    channel: string,
    input?: { subject?: string; body?: string },
    locale?: string | null,
    contextOverride?: TemplateContext,
  ): RenderedTemplate & { is_default: boolean } {
    const target = this.assertKindChannel(kind, channel);
    const fallback = defaultTemplate(target.kind, target.channel, locale);
    const content: TemplateContent = {
      subject: input?.subject?.trim() ? input.subject : fallback.subject,
      body: input?.body?.trim() ? input.body : fallback.body,
    };
    const error = validateTemplate(content.body);
    if (error) {
      throw badRequest({
        code: 'alerting.template.syntaxError',
        messageKey: 'alerting:error.template.syntaxError',
        params: { error },
        message: `模板语法错误：${error}`,
      });
    }
    if (content.subject) {
      const subjectError = validateTemplate(content.subject);
      if (subjectError) {
        throw badRequest({
          code: 'alerting.template.subjectSyntaxError',
          messageKey: 'alerting:error.template.subjectSyntaxError',
          params: { error: subjectError },
          message: `邮件主题语法错误：${subjectError}`,
        });
      }
    }
    return {
      ...renderForChannel(target.kind, target.channel, content, sampleContext(contextOverride ?? {}, locale)),
      is_default: !input?.body?.trim(),
    };
  }

  /**
   * 投递侧入口：取有效模板并渲染。
   * `locale` 为**收件人**语言（i18n v1）：用户自定义模板原样使用，未自定义时取该语言的默认模板。
   */
  async render(
    project: string,
    kind: AlertKind,
    channel: AlertChannel,
    ctx: TemplateContext,
    locale?: string | null,
  ): Promise<RenderedTemplate> {
    const content = await this.effective(project, kind, channel, locale);
    return renderForChannel(kind, channel, content, ctx);
  }

  private async effective(
    project: string,
    kind: AlertKind,
    channel: AlertChannel,
    locale?: string | null,
  ): Promise<TemplateContent> {
    const key = `${project}:${kind}:${channel}:${locale ?? ''}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.content;
    const row = await this.prisma.alertTemplate.findUnique({
      where: { project_name_kind_channel: { project_name: project, kind, channel } },
    });
    const content: TemplateContent = row
      ? { subject: row.subject || defaultTemplate(kind, channel, locale).subject, body: row.body }
      : defaultTemplate(kind, channel, locale);
    this.cache.set(key, { at: Date.now(), content, isDefault: !row });
    return content;
  }

  private assertKindChannel(kind: string, channel: string): { kind: AlertKind; channel: AlertChannel } {
    if (!AlertTemplateService.isKind(kind)) {
      throw badRequest({
        code: 'alerting.template.kindInvalid',
        messageKey: 'alerting:error.template.kindInvalid',
        message: '事件类型非法（fire / resolve）',
      });
    }
    if (!AlertTemplateService.isChannel(channel)) {
      throw badRequest({
        code: 'alerting.template.channelInvalid',
        messageKey: 'alerting:error.template.channelInvalid',
        message: '通道非法（chat / email / sms）',
      });
    }
    return { kind, channel };
  }
}
