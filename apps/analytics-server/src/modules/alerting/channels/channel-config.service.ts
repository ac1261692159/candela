import { Injectable } from '@nestjs/common';
import { Optional } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma.service';
import { bindPlatformSmtpResolver } from './platform-mail';
// 必须是**值导入**：`import type` 会让 emitDecoratorMetadata 退化成 Function，Nest 解析不到该 provider，
// `@Optional()` 静默注入 undefined —— v3.2 的平台邮件回落因此在生产里从未生效（2026-10-09 修复）。
import { AuthMailService } from '../../auth/auth-mail.service';
import { appConfig } from '../../../config/configuration';
import { AlertAuditService } from '../alert-audit.service';
import { decryptSecret, encryptSecret, maskSecret, parseMasterKey, SECRET_KEY_ENV } from './channel-crypto';
import {
  CHANNELS,
  CONFIG_CHANNELS,
  SMS_PROVIDER_KEYS,
  channelDescriptor,
  envTencentFallback,
  isKnownChannel,
  requiredConfigKeys,
  type ContactTarget,
} from './channel-registry';
import { CONFIG_SCHEMAS, validateConfigInput, type ChannelConfigSchema } from './channel-config-schema';
import { validationError } from './validation-issue';
import type { ChannelConfigView, SendContext } from './channel-types';
import type { SmtpSettings } from './senders/sender-email';
import { sampleContext } from '../alert-template';
import { describeError } from './http';
import { badRequest, notFound } from '../../../i18n/domain-error';
import { serverT } from '../../../i18n/messages';

/** 通道配置的对外视图（密钥只回显「已配置 + 末 4 位」） */
export interface ChannelConfigItem {
  channel: string;
  /** 中文名（兼容兜底）；前端优先用 label_key */
  label: string;
  label_key: string | null;
  enabled: boolean;
  /** 暂停投递：保留配置与密钥，但此通道不参与任何投递（含平台邮件兜底） */
  muted: boolean;
  config: Record<string, unknown>;
  secret: { configured: boolean; hint: string; keys: Record<string, string> };
  updated_by: string | null;
  updated_at: string | null;
  /** 环境变量回退是否可用（SMTP / 腾讯云短信） */
  env_fallback: boolean;
  /** 告警侧未启用、但平台邮件通道可用：邮件将由「用户管理 → 邮件通道」的账号发出（仅 smtp） */
  platform_fallback: boolean;
}

export interface ChannelCapability {
  available: boolean;
  reason: string | null;
  /** 不可用原因的 i18n 资源键（names 参数由 reason_configs 本地化后拼出） */
  reason_key: string | null;
  /** 不可用原因涉及的平台配置键（前端按 channelConfig.<key>.label 本地化） */
  reason_configs: string[];
  /** 可用性来自平台邮件通道（告警侧 smtp 未启用时的第三级回落）；仅 email 可能为 true */
  platform_fallback: boolean;
  /** 该通道被暂停投递（requiredConfig 全部 muted）；true 时 available 必为 false */
  muted: boolean;
  /** 通道元数据一并返回，前端表单与文案直接消费（避免两边各写一份） */
  label: string;
  label_key: string | null;
  group: string;
  kind: string;
  contact_fields: string[];
  required_config: string[];
  hint: string | null;
}

const CACHE_TTL_MS = 30_000;

@Injectable()
export class AlertChannelConfigService {
  private readonly cache = new Map<string, { at: number; view: ChannelConfigView | null }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AlertAuditService,
    @Optional() private readonly platformMail?: AuthMailService,
  ) {
    // 告警 email 通道的第三级回退：平台邮件通道（v3.2 UX-7）
    bindPlatformSmtpResolver(() => this.platformSmtp());
  }

  /** 发送侧读取配置（DB 优先 → 环境变量回退）；未配置返回 null */
  async readConfig(channel: string): Promise<ChannelConfigView | null> {
    const cached = this.cache.get(channel);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.view;
    const row = await this.prisma.alertChannelConfig.findUnique({ where: { channel } });
    const view = row ? this.toView(row) : this.envView(channel);
    this.cache.set(channel, { at: Date.now(), view });
    return view;
  }

  invalidate(channel?: string): void {
    if (channel) this.cache.delete(channel);
    else this.cache.clear();
  }

  /** 平台配置页数据：各通道配置（脱敏）+ 表单结构 */
  async list(): Promise<{ items: ChannelConfigItem[]; schemas: ChannelConfigSchema[] }> {
    const rows = await this.prisma.alertChannelConfig.findMany();
    const byChannel = new Map(rows.map((row) => [row.channel, row]));
    const platformSmtp = await this.platformSmtp();
    const items: ChannelConfigItem[] = [];
    for (const key of CONFIG_CHANNELS) {
      const schema = CONFIG_SCHEMAS[key];
      const row = byChannel.get(key);
      const env = this.envView(key);
      const secret = row ? this.decodeSecret(row.secret_cipher) : (env?.secret ?? {});
      // 告警侧这一级是否启用（库内行优先，其次环境变量）——平台回落不改变它的语义
      const configuredHere = row ? row.enabled : Boolean(env);
      // 暂停只可能来自库内行（环境变量回退没有对应行，也就没有暂停开关）
      const muted = row ? row.muted : false;
      items.push({
        channel: key,
        label: schema?.label ?? key,
        label_key: schema?.label_key ?? null,
        enabled: configuredHere,
        muted,
        config: row ? this.parseJson(row.config_json) : (env?.config ?? {}),
        secret: {
          configured: Object.keys(secret).length > 0,
          hint: maskSecret(Object.values(secret).find((value) => typeof value === 'string') as string | undefined),
          keys: Object.fromEntries(
            Object.entries(secret).map(([field, value]) => [field, maskSecret(String(value))]),
          ),
        },
        updated_by: row?.updated_by ?? null,
        updated_at: row?.updated_at?.toISOString() ?? null,
        env_fallback: Boolean(env),
        platform_fallback: !configuredHere && key === 'smtp' && Boolean(platformSmtp),
      });
    }
    return {
      items,
      schemas: CONFIG_CHANNELS.map((key) => CONFIG_SCHEMAS[key]).filter(Boolean),
    };
  }

  /** 保存配置：合并非密字段、密钥留空表示不修改；审计只记字段名 */
  async save(
    channel: string,
    input: { enabled?: boolean; muted?: boolean; config?: Record<string, unknown>; secret?: Record<string, unknown> },
    operator: string,
  ): Promise<{ ok: true }> {
    const schema = CONFIG_SCHEMAS[channel];
    if (!schema) {
      throw notFound({
        code: 'alerting.channelConfig.unsupported',
        messageKey: 'alerting:error.channelConfig.unsupported',
        params: { channel },
        message: `不支持的通道配置：${channel}`,
      });
    }
    const existing = await this.prisma.alertChannelConfig.findUnique({ where: { channel } });
    // 没有 DB 行但有环境变量回退（ALERT_SMTP_* / ALERT_SMS_*）时，以 env 值作为基线：
    // 这样「只把开关打开」也能通过校验，不必先把 env 里的值抄一遍
    const envView = existing ? null : this.envView(channel);
    const existingConfig = existing ? this.parseJson(existing.config_json) : (envView?.config ?? {});
    const existingSecret = existing ? this.decodeSecret(existing.secret_cipher) : (envView?.secret ?? {});
    const incomingSecret = this.pickSecret(input.secret ?? {});
    const mergedSecret = { ...existingSecret, ...incomingSecret };

    const issue = validateConfigInput(
      channel,
      { ...existingConfig, ...(input.config ?? {}) },
      mergedSecret,
      Object.keys(existingSecret).length > 0,
    );
    // 纯「暂停/恢复」不校验字段：走平台邮件兜底的通道本来就没有库内配置（暂停它是合法操作，
    // 不该因为「SMTP 服务器」为空而 400）；只有真正在写配置时才校验
    const pureMuteToggle = input.muted !== undefined && input.config === undefined && input.secret === undefined;
    // 校验失败：message 中文逐字兜底 + messageKey/params 由前端按当前语言渲染（i18n v1）
    if (issue && !pureMuteToggle) throw validationError('alerting.channelConfig.invalid', issue);

    const key = this.masterKey();
    if (Object.keys(mergedSecret).length > 0 && !key) {
      throw badRequest({
        code: 'alerting.channelConfig.masterKeyMissing',
        messageKey: 'alerting:error.channelConfig.masterKeyMissing',
        params: { env: SECRET_KEY_ENV },
        message: `缺少主密钥：请设置环境变量 ${SECRET_KEY_ENV}（32 字节 base64），用于加密保存通道凭证`,
      });
    }

    const config = { ...existingConfig, ...this.pickConfig(schema, input.config ?? {}) };
    const cipher = key && Object.keys(mergedSecret).length > 0 ? encryptSecret(JSON.stringify(mergedSecret), key) : null;
    // muted 默认沿用库内值：只改字段不动暂停状态；只在显式传入时改写
    const muted = input.muted ?? existing?.muted ?? false;
    // 纯暂停**新建**行时 enabled 必须为 false：那一行只是暂停开关的载体，没有凭证。
    // 若按旧默认写成 true，这道空配置行会被当成「告警侧已启用」，既挡住平台邮件兜底，
    // 又会在发送时抛 smtp_not_configured（2026-10-09 生产实测踩到，见 PRD 增补 v1.1）
    const enabled = input.enabled ?? existing?.enabled ?? !pureMuteToggle;
    await this.prisma.alertChannelConfig.upsert({
      where: { channel },
      create: {
        channel,
        enabled,
        muted,
        config_json: JSON.stringify(config),
        secret_cipher: cipher,
        updated_by: operator,
      },
      update: {
        enabled,
        muted,
        config_json: JSON.stringify(config),
        ...(cipher ? { secret_cipher: cipher } : {}),
        updated_by: operator,
      },
    });
    this.invalidate(channel);
    await this.audit.write(
      'alert_channel_config_update',
      'alertchannelconfig',
      {
        channel,
        enabled,
        muted,
        fields: Object.keys(this.pickConfig(schema, input.config ?? {})),
        secret_updated: Object.keys(incomingSecret).length > 0,
      },
      operator,
    );
    return { ok: true };
  }

  /**
   * 发送测试：用给定目标走一次真实投递，失败返回厂商原始错误。
   * `locale` 为**操作者**语言（i18n v1）：测试消息正文、通道名与返回的 detail 都按它渲染，
   * 中文路径逐字不变（serverT 的 zh 文案与迁移前一致）。
   */
  async test(
    channel: string,
    target: { address?: string; webhook_url?: string; chat_id?: string; options?: Record<string, unknown> },
    operator: string,
    locale?: string | null,
  ): Promise<{
    ok: boolean;
    error?: string;
    /** 校验失败原因的文案键与插值参数（加法式）：前端优先按它渲染，缺省回退 error（中文原文） */
    error_key?: string | null;
    error_params?: Record<string, unknown> | null;
    detail: string;
  }> {
    // 「通道配置」页测的是凭证级通道（smtp / sms_* / telegram / whatsapp），
    // 它们对应的联系人通道是 email / sms / telegram / whatsapp；短信厂商用 options.provider 指定
    const mapping: Record<string, { kind: string; provider?: string }> = {
      smtp: { kind: 'email' },
      telegram: { kind: 'telegram' },
      whatsapp: { kind: 'whatsapp' },
      sms_aliyun: { kind: 'sms', provider: 'sms_aliyun' },
      sms_tencent: { kind: 'sms', provider: 'sms_tencent' },
      sms_aws: { kind: 'sms', provider: 'sms_aws' },
      sms_twilio: { kind: 'sms', provider: 'sms_twilio' },
    };
    const mapped = mapping[channel] ?? (isKnownChannel(channel) ? { kind: channel } : null);
    if (!mapped) {
      throw notFound({
        code: 'alerting.channel.unknown',
        messageKey: 'alerting:error.channel.unknown',
        params: { channel },
        message: `未知通道：${channel}`,
      });
    }
    const descriptor = channelDescriptor(mapped.kind);
    const contact: ContactTarget = {
      kind: mapped.kind,
      webhook_url: (target.webhook_url ?? '').trim(),
      address: (target.chat_id ?? target.address ?? '').trim(),
      options: { ...(mapped.provider ? { provider: mapped.provider } : {}), ...(target.options ?? {}) },
    };
    const validation = descriptor.validateContact(contact);
    if (validation) {
      return {
        ok: false,
        // error 仍是中文原文（兼容旧前端）；新前端优先用 error_key/error_params 按界面语言渲染
        error: validation.message,
        error_key: validation.message_key ?? null,
        error_params: validation.params ?? null,
        detail: serverT(locale, 'alert.channelTest.detailTargetInvalid'),
      };
    }

    const now = new Date().toISOString();
    // 通道名按**联系人通道**取服务端文案（如 email/sms/telegram）：中文回退 descriptor.label 逐字不变
    const channelName = localizedChannelName(mapped.kind, descriptor.label, locale);
    const ctx: SendContext = {
      contact,
      text: serverT(locale, 'alert.channelTest.text', { channel: channelName, time: now }),
      subject: serverT(locale, 'alert.channelTest.subject', { channel: channelName }),
      vars: {
        ...sampleContext({}, locale),
        rule_name: serverT(locale, 'alert.channelTest.ruleName'),
        status: serverT(locale, 'alert.status.fire'),
        status_code: 'fire',
        level_fmt: serverT(locale, 'alert.level.info'),
        project: 'clklogapp',
        time: now.replace('T', ' ').slice(0, 19),
      },
      readConfig: (key: string) => this.readConfig(key),
    };
    try {
      await descriptor.send(ctx);
    } catch (error) {
      const message = describeError(error);
      await this.audit.write(
        'alert_channel_test',
        'alertchannelconfig',
        { channel, ok: false, error: message },
        operator,
      );
      return {
        ok: false,
        error: message,
        detail: serverT(locale, 'alert.channelTest.detailSendFailed'),
      };
    }
    await this.audit.write('alert_channel_test', 'alertchannelconfig', { channel, ok: true }, operator);
    return { ok: true, detail: serverT(locale, 'alert.channelTest.detailSent') };
  }

  /** 联系人通道可用性（未配置凭证 或 已暂停 → 不可用并给出原因） */
  async capabilities(): Promise<Record<string, ChannelCapability>> {
    const result: Record<string, ChannelCapability> = {};
    // 平台的第三级回落只对 email（requiredConfig 含 smtp）有意义；sms 无平台级凭证
    const platformSmtpAvailable = Boolean(await this.platformSmtp());
    // 暂停一次查完：循环里逐通道查会把 7 个通道变成 7 次查询
    const mutedKeys = await this.mutedConfigKeys();
    for (const key of Object.keys(CHANNELS)) {
      const descriptor = CHANNELS[key];
      const required = requiredConfigKeys(descriptor);
      const base = {
        label: descriptor.label,
        label_key: descriptor.label_key ?? null,
        group: descriptor.group,
        kind: descriptor.kind,
        contact_fields: descriptor.contactFields,
        required_config: required,
        hint: descriptor.hint ?? null,
      };
      if (required.length === 0) {
        result[key] = {
          ...base,
          available: true,
          reason: null,
          reason_key: null,
          reason_configs: [],
          platform_fallback: false,
          muted: false,
        };
        continue;
      }
      let available = false;
      for (const configKey of required) {
        const view = await this.readConfig(configKey);
        if (view?.enabled) available = true;
      }
      // 暂停：该 kind 需要的凭证通道**全部**被暂停 → 不可用（平台邮件兜底同样被挡住）
      const muted = required.every((configKey) => mutedKeys.has(configKey));
      if (muted) available = false;
      // 告警侧未配置时回落到平台邮件通道（v3.2 UX-7 收尾）：与发送侧同一判定口径
      const platformFallback = !muted && !available && required.includes('smtp') && platformSmtpAvailable;
      if (platformFallback) available = true;
      result[key] = {
        ...base,
        available,
        reason: available
          ? null
          : muted
            ? '该通道已暂停投递'
            : `未配置：${required.map((k) => CONFIG_SCHEMAS[k]?.label ?? k).join(' / ')}`,
        reason_key: available ? null : muted ? 'alerting:channel.muted' : 'alerting:channel.configMissing',
        reason_configs: available || muted ? [] : [...required],
        platform_fallback: platformFallback,
        muted,
      };
    }
    return result;
  }

  /**
   * 投递守卫：该联系人通道是否已被暂停（不可投递）。
   * 口径 = 其 `requiredConfig` 全部 muted；无凭证要求的群机器人通道恒不 muted。
   * 供 `AlertNotifyService` 在重试循环**之前**判定：确定性失败不重试。
   */
  async isMutedForKind(kind: string): Promise<boolean> {
    const descriptor = CHANNELS[kind];
    if (!descriptor) return false;
    const required = requiredConfigKeys(descriptor);
    if (required.length === 0) return false;
    for (const configKey of required) {
      const view = await this.readConfig(configKey);
      if (!view?.muted) return false;
    }
    return true;
  }

  /** 已被暂停的配置通道键集合（一次查完，供 capabilities 判定） */
  private async mutedConfigKeys(): Promise<Set<string>> {
    const rows = await this.prisma.alertChannelConfig.findMany({ where: { muted: true } });
    return new Set(rows.map((row) => row.channel));
  }

  /** 短信当前可用的厂商（前端下拉用） */
  async smsProviders(): Promise<{ key: string; label: string; enabled: boolean }[]> {
    const out: { key: string; label: string; enabled: boolean }[] = [];
    for (const key of SMS_PROVIDER_KEYS) {
      const view = await this.readConfig(key);
      out.push({ key, label: CONFIG_SCHEMAS[key]?.label ?? key, enabled: Boolean(view?.enabled) });
    }
    return out;
  }

  /** 主密钥来自 src/config（env 读取只允许在配置模块内） */
  private masterKey(): Buffer | null {
    return parseMasterKey(appConfig.alerting.configKey);
  }

  /**
   * 平台邮件通道的生效配置（设置 → 用户管理 → 邮件通道）。
   * 判定口径与发送侧回落的 `smtpReady` 一致（`enabled && host && from`），避免「显示可用却发不出去」；
   * 未注入 / 未启用 / 读取失败一律返回 null。
   */
  private async platformSmtp(): Promise<SmtpSettings | null> {
    if (!this.platformMail) return null;
    const cfg = await this.platformMail.effectiveConfig().catch(() => null);
    if (!cfg?.enabled || !cfg.host || !cfg.from) return null;
    return { host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, pass: cfg.pass, from: cfg.from };
  }

  private pickConfig(schema: ChannelConfigSchema, input: Record<string, unknown>): Record<string, unknown> {
    const allowed = new Set(schema.fields.map((field) => field.key));
    return Object.fromEntries(Object.entries(input).filter(([key]) => allowed.has(key)));
  }

  private pickSecret(input: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== ''),
    );
  }

  private decodeSecret(cipher: string | null): Record<string, unknown> {
    if (!cipher) return {};
    const key = this.masterKey();
    if (!key) return {};
    try {
      return JSON.parse(decryptSecret(cipher, key)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private parseJson(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private toView(row: {
    channel: string;
    enabled: boolean;
    muted: boolean;
    config_json: string;
    secret_cipher: string | null;
  }): ChannelConfigView {
    return {
      channel: row.channel,
      enabled: row.enabled,
      muted: row.muted,
      config: this.parseJson(row.config_json),
      secret: this.decodeSecret(row.secret_cipher),
    };
  }

  /** 环境变量回退：SMTP（ALERT_SMTP_*）与腾讯云短信（ALERT_SMS_*）——升级后不中断（无库内行＝无暂停开关） */
  private envView(channel: string): ChannelConfigView | null {
    if (channel === 'smtp') {
      const smtp = appConfig.alerting.smtp;
      if (!smtp.host || !smtp.from) return null;
      return {
        channel,
        enabled: true,
        muted: false,
        config: { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, from: smtp.from },
        secret: { pass: smtp.pass },
      };
    }
    if (channel === 'sms_tencent') {
      const fallback = envTencentFallback(appConfig.alerting.sms);
      if (!fallback) return null;
      return { channel, enabled: true, muted: false, config: fallback.config, secret: fallback.secret };
    }
    return null;
  }
}

/**
 * 测试消息里的通道名（i18n v1）：按**联系人通道**取服务端文案（`alert.channelName.*`）。
 * 中文返回调用方给的中文名（逐字不变），缺键时同样回退——不会把键名发出去。
 */
function localizedChannelName(kind: string, fallback: string, locale?: string | null): string {
  if (!locale || locale.startsWith('zh')) return fallback;
  const key = `alert.channelName.${kind}`;
  const rendered = serverT(locale, key);
  return rendered === key ? fallback : rendered;
}
