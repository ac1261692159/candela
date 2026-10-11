/**
 * 通道共享类型（phase: clklog-analytics-alert-channels-v1）。
 * 单独成文件避免 registry ↔ senders 循环依赖；senders 只依赖这里的类型。
 */

/** 模板组：决定用哪份通知模板（chat 覆盖群机器人与 IM/Webhook） */
export type ChannelGroup = 'chat' | 'email' | 'sms';

/** 通道大类：前端分组展示 + 能力位语义 */
export type ChannelKind = 'webhook' | 'chat' | 'push' | 'email' | 'sms';

/** 联系人侧需要填写的字段（前端据此渲染表单） */
export type ContactField = 'webhook_url' | 'address' | 'secret' | 'headers' | 'body_template';

export interface ContactTarget {
  name?: string;
  kind: string;
  webhook_url: string;
  address: string;
  /** 通道专属选项：{ secret?, headers?, body_template?, provider? } */
  options: Record<string, unknown>;
}

/**
 * 校验失败的结构化负载（i18n v1 补交）。
 *
 * `message` 是**中文原文（逐字保留）**：老客户端 / API Key / Harness 继续读它；
 * `message_key` 指向前端 `alerting:error.*` 资源，由查看者按当前界面语言渲染。
 *
 * 参数里的「显示名」（如字段名「SMTP 服务器」）以**成对**形式下发：
 * `field`（中文兜底）+ `field_key`（资源键），由前端 `resolveParamKeys` 解析成当前语言——
 * 字段名的唯一资源仍是界面文案，避免服务端再抄一份翻译产生漂移。
 */
export interface ValidationIssue {
  message: string;
  message_key?: string;
  params?: Record<string, unknown>;
}

/**
 * 平台级通道配置（凭证，密钥已解密）；未配置时为 null。
 * **全仓唯一定义**：发送侧（`SendContext.readConfig`）与配置服务共用这一份——曾在两处各写一份，
 * 加 `muted` 时只在一边生效、SMS 厂商挑选静默读不到（2026-10-09 合并）。
 */
export interface ChannelConfigView {
  channel: string;
  /** 本通道**自己的凭证**是否启用（与 muted 正交：平台邮件兜底时 enabled=false 仍会发信） */
  enabled: boolean;
  /** 暂停投递：保留配置与密钥，但该通道不参与任何投递（含平台邮件兜底） */
  muted: boolean;
  config: Record<string, unknown>;
  /** 解密后的密钥字段 */
  secret: Record<string, unknown>;
}

export interface SendContext {
  contact: ContactTarget;
  /** 渲染后的正文（按通道组模板） */
  text: string;
  /** 邮件主题 */
  subject: string;
  /** 模板变量（通用 Webhook 模板 / WhatsApp 模板参数用） */
  vars: Record<string, string>;
  readConfig: (channel: string) => Promise<ChannelConfigView | null>;
}

export interface ChannelDescriptor {
  key: string;
  /** 中文展示名（兼容兜底：老客户端 / 通知正文） */
  label: string;
  /** i18n 资源键：前端优先用它取本地化名，取不到再回退 label（i18n v1 漏网点补齐） */
  label_key?: string;
  group: ChannelGroup;
  kind: ChannelKind;
  contactFields: ContactField[];
  /** 依赖的平台级配置键（凭证）；空表示「凭证就在联系人里」 */
  requiredConfig?: string[];
  /** 官方限流（条/分钟），用于令牌桶默认值 */
  ratePerMinute: number;
  /** 前端提示：该通道的注意事项（限流、申请步骤、跨境网络等） */
  hint?: string;
  /** 联系人字段校验：通过返回 null，失败返回结构化负载（message 中文逐字 + message_key/params） */
  validateContact: (contact: ContactTarget) => ValidationIssue | null;
  send: (ctx: SendContext) => Promise<void>;
}
