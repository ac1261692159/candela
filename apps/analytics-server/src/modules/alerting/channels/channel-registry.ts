import type { ChannelDescriptor, ChannelGroup, ContactTarget } from './channel-types';
import {
  buildChatPayload,
  validateDingtalk,
  validateFeishu,
  validateWecom,
} from './senders/sender-chat-webhook';
import { sendTelegramFromContext, validateTelegram } from './senders/sender-telegram';
import { sendEmailFromContext, validateEmailContact, type SmtpSettings } from './senders/sender-email';
import { buildEmailFallback } from './platform-mail';
import { sendSmsFromContext, validateSmsContact, type SmsProviderKey } from './senders/sender-sms';
import { sendWhatsAppFromContext, validateWhatsApp } from './senders/sender-whatsapp';
import { sendGenericWebhook, validateGenericWebhook } from './senders/sender-generic-webhook';
import { appConfig } from '../../../config/configuration';

/**
 * 告警通道注册表（phase: clklog-analytics-alert-channels-v1）。
 *
 * 一处定义「通道元数据 + 联系人字段 + 依赖的平台配置 + 官方限流 + 发送实现」，
 * 后端分派、前端表单、能力位、限流默认值都从这里取，避免多处硬编码。
 */

export type { ChannelDescriptor, ChannelGroup, ContactTarget } from './channel-types';
export type { SmtpSettings, SmsProviderKey };

/** SMS 厂商配置键（sms 联系人的凭证来源，取第一个已启用的） */
export const SMS_PROVIDER_KEYS: SmsProviderKey[] = ['sms_aliyun', 'sms_tencent', 'sms_aws', 'sms_twilio'];
export const SMS_PROVIDER_LABEL: Record<SmsProviderKey, string> = {
  sms_aliyun: '阿里云短信',
  sms_tencent: '腾讯云短信',
  sms_aws: 'AWS SNS',
  sms_twilio: 'Twilio',
};

/** 需要平台级凭证的通道（配置页里逐个展示） */
export const CONFIG_CHANNELS = ['smtp', 'telegram', 'whatsapp', ...SMS_PROVIDER_KEYS];

function chatSend(channel: string): ChannelDescriptor['send'] {
  return buildChatPayload(channel);
}

export const CHANNELS: Record<string, ChannelDescriptor> = {
  feishu_webhook: {
    key: 'feishu_webhook',
    label: '飞书',
    label_key: 'alerting:channel.feishu',
    group: 'chat',
    kind: 'chat',
    contactFields: ['webhook_url', 'secret'],
    ratePerMinute: 60,
    hint: '群机器人 webhook；HTTP 200 也可能带错误码，已按飞书规范校验 code。机器人开了「签名校验」时把签名密钥也填上（否则报 19021）。',
    validateContact: validateFeishu,
    send: chatSend('feishu_webhook'),
  },
  dingtalk: {
    key: 'dingtalk',
    label: '钉钉',
    label_key: 'alerting:channel.dingtalk',
    group: 'chat',
    kind: 'chat',
    contactFields: ['webhook_url', 'secret'],
    ratePerMinute: 20,
    hint: '官方限流 20 条/分钟（超限限流 10 分钟，已由通道限流保护）。填了加签密钥就走加签（毫秒时间戳 + HmacSHA256 + URL 编码）。',
    validateContact: validateDingtalk,
    send: chatSend('dingtalk'),
  },
  wecom: {
    key: 'wecom',
    label: '企业微信',
    label_key: 'alerting:channel.wecom',
    group: 'chat',
    kind: 'chat',
    contactFields: ['webhook_url'],
    ratePerMinute: 20,
    hint: '群机器人 webhook（key 即凭证）；官方限流 20 条/分钟，正文上限 2048 字节（超出自动截断）。',
    validateContact: validateWecom,
    send: chatSend('wecom'),
  },
  telegram: {
    key: 'telegram',
    label: 'Telegram',
    label_key: 'alerting:channel.telegram',
    group: 'chat',
    kind: 'chat',
    contactFields: ['address'],
    requiredConfig: ['telegram'],
    ratePerMinute: 20,
    hint: '联系人填 chat_id；Bot Token 在「通道配置」里填。大陆需代理出口，可在配置里改 api_base。',
    validateContact: validateTelegram,
    send: sendTelegramFromContext,
  },
  webhook: {
    key: 'webhook',
    label: '通用 Webhook',
    label_key: 'alerting:channel.webhook',
    group: 'chat',
    kind: 'webhook',
    contactFields: ['webhook_url', 'headers', 'body_template'],
    ratePerMinute: 60,
    hint: '自定义 URL / 请求头 / body 模板（占位符同告警模板，另有 {{.text}} 与 {{.text_json}}），可对接 PagerDuty、自建系统等。',
    validateContact: validateGenericWebhook,
    send: sendGenericWebhook,
  },
  email: {
    key: 'email',
    label: '邮件',
    label_key: 'alerting:channel.email',
    group: 'email',
    kind: 'email',
    contactFields: ['address'],
    requiredConfig: ['smtp'],
    ratePerMinute: 60,
    hint: 'SMTP 发信账号在「通道配置 → 邮件」里填；未配置时回退 ALERT_SMTP_*，再回退平台邮件通道（用户管理 → 邮件通道）。',
    validateContact: validateEmailContact,
    // 平台配置优先，未配置回退环境变量 ALERT_SMTP_*（升级不中断）
    send: async (ctx) => sendEmailFromContext(ctx, await buildEmailFallback(appConfig.alerting.smtp)),
  },
  sms: {
    key: 'sms',
    label: '短信',
    label_key: 'alerting:channel.sms',
    group: 'sms',
    kind: 'sms',
    contactFields: ['address', 'secret'],
    requiredConfig: [...SMS_PROVIDER_KEYS],
    ratePerMinute: 60,
    hint: '短信正文受模板约束，只发一行摘要；厂商（阿里云/腾讯云/AWS/Twilio）在「通道配置」里分别启用，联系人可用「厂商」覆盖。',
    validateContact: validateSmsContact,
    // 默认腾讯云（历史行为），联系人可用 options.provider 覆盖，未配置时自动挑第一个已启用厂商
    send: (ctx) => sendSmsFromContext(ctx, 'sms_tencent'),
  },
  whatsapp: {
    key: 'whatsapp',
    label: 'WhatsApp',
    label_key: 'alerting:channel.whatsapp',
    group: 'chat',
    kind: 'chat',
    contactFields: ['address'],
    requiredConfig: ['whatsapp'],
    ratePerMinute: 60,
    hint: '官方 Cloud API：需 Business 验证 + 预审模板；窗口外只能发模板消息，正文以模板参数传递（规则/当前值/条件/项目）。',
    validateContact: validateWhatsApp,
    send: sendWhatsAppFromContext,
  },
};

export const CHANNEL_KEYS = Object.keys(CHANNELS);

/** 前端分组的展示顺序与文案 */
export const CHANNEL_GROUP_LABEL: Record<ChannelGroup, string> = {
  chat: '群机器人与 IM',
  email: '邮件',
  sms: '短信',
};

/** 分组名的 i18n 资源键（与 CHANNEL_GROUP_LABEL 一一对应，前端优先用 key） */
export const CHANNEL_GROUP_LABEL_KEY: Record<ChannelGroup, string> = {
  chat: 'alerting:channelGroup.chat',
  email: 'alerting:channelGroup.email',
  sms: 'alerting:channelGroup.sms',
};

export function channelDescriptor(key: string): ChannelDescriptor {
  const descriptor = CHANNELS[key];
  if (!descriptor) throw new Error(`unknown_channel_${key}`);
  return descriptor;
}

export function isKnownChannel(key: string): boolean {
  return Boolean(CHANNELS[key]);
}

/** 通道组列表（模板编辑与前端分组用） */
export function channelsByGroup(): {
  group: ChannelGroup;
  label: string;
  label_key: string;
  channels: ChannelDescriptor[];
}[] {
  return (Object.keys(CHANNEL_GROUP_LABEL) as ChannelGroup[]).map((group) => ({
    group,
    label: CHANNEL_GROUP_LABEL[group],
    label_key: CHANNEL_GROUP_LABEL_KEY[group],
    channels: CHANNEL_KEYS.map((key) => CHANNELS[key]).filter((descriptor) => descriptor.group === group),
  }));
}

/** 联系人是否需要平台凭证（决定能力位是否可用） */
export function requiredConfigKeys(descriptor: ChannelDescriptor): string[] {
  return descriptor.requiredConfig ?? [];
}

/** 环境变量回退（升级不中断）：SMTP 与腾讯云短信沿用旧变量 */
export function envSmtpFallback(config: {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
}): SmtpSettings | null {
  if (!config.host || !config.from) return null;
  return { ...config };
}

export function envTencentFallback(config: {
  secretId: string;
  secretKey: string;
  sdkAppId: string;
  signName: string;
  templateId: string;
  region: string;
}): { config: Record<string, unknown>; secret: Record<string, unknown> } | null {
  if (!config.secretId || !config.secretKey || !config.sdkAppId || !config.signName || !config.templateId) {
    return null;
  }
  return {
    config: {
      sdk_app_id: config.sdkAppId,
      sign_name: config.signName,
      template_id: config.templateId,
      region: config.region,
    },
    secret: { secret_id: config.secretId, secret_key: config.secretKey },
  };
}
