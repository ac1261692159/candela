/**
 * 通道配置表单结构（phase: clklog-analytics-alert-channels-v1）。
 *
 * 后端校验与前端表单共用同一份定义（接口直接返回它），避免两边各写一套字段。
 * `secretFields` 里的字段只写不读：保存后只回显「已配置 + 末 4 位」。
 */

import type { ValidationIssue } from './channel-types';
import { validationIssue } from './validation-issue';

export type ConfigFieldType = 'text' | 'password' | 'number' | 'boolean';

export interface ConfigField {
  key: string;
  /** 中文标签（兼容兜底：老客户端）；前端优先用 label_key 取本地化名 */
  label: string;
  label_key?: string;
  type: ConfigFieldType;
  required: boolean;
  placeholder?: string;
  /** placeholder 的 i18n 资源键（仅含中文的占位文本需要） */
  placeholder_key?: string;
  hint?: string;
  hint_key?: string;
  defaultValue?: string | number | boolean;
}

export interface ChannelConfigSchema {
  channel: string;
  /** 中文通道名（兼容兜底）；前端优先用 label_key */
  label: string;
  label_key?: string;
  /** 页面上的说明（申请步骤、限流、合规提醒等） */
  hint: string;
  hint_key?: string;
  /**
   * 表头「?」里的**逐步配置方法**（多行文本，前端按原样换行渲染）。
   * 缺省则表头不出现「?」——只有「一步错就报错、报错信息又看不出所以然」的通道才值得写。
   */
  help?: string;
  help_key?: string;
  fields: ConfigField[];
  secretFields: ConfigField[];
}

/** 文本字段构造：labelKey/placeholderKey 为 i18n 资源键（老字段保留作兜底） */
const T = (
  key: string,
  label: string,
  labelKey: string,
  placeholder?: string,
  hint?: string,
  placeholderKey?: string,
): ConfigField => ({
  key,
  label,
  label_key: labelKey,
  type: 'text',
  required: true,
  placeholder,
  placeholder_key: placeholderKey,
  hint,
});

/** 密钥字段构造：只写不读 */
const S = (key: string, label: string, labelKey: string, placeholder?: string, hint?: string): ConfigField => ({
  key,
  label,
  label_key: labelKey,
  type: 'password',
  required: true,
  placeholder,
  hint,
});

export const CONFIG_SCHEMAS: Record<string, ChannelConfigSchema> = {
  smtp: {
    channel: 'smtp',
    label: '邮件（SMTP）',
    label_key: 'alerting:channelConfig.smtp.label',
    hint: '建议用专用发信账号 + 授权码；保存后「发送测试」会先做连通性校验再实发一封。',
    hint_key: 'alerting:channelConfig.smtp.hint',
    // 「?」里的逐步配置方法（增补 v1.1）：只写「要准备什么 / 要填什么 / 怎么验证」三件事，
    // 不写未经核实的控制台路径与错误码清单——把猜测写成产品文案比不写更糟。
    help: [
      '1. 准备：用一个专用发信邮箱，在服务商后台开启 SMTP 并生成授权码——多数服务商不允许用登录密码发信。',
      '2. 填写：主机 + 端口（465 配「SSL/TLS 开」；587 配 STARTTLS）；「发件人」必须与 SMTP 用户名一致，否则会被服务商拒信。',
      '3. 验证：「发送测试」先做连通性校验再实发一封，失败会显示服务商原始错误（认证失败 / 发件人不一致 / 被限流）。只配一次可全站复用：填到「设置 → 用户管理 → 邮件通道」，告警侧会自动回落到它。',
    ].join('\n'),
    help_key: 'alerting:channelConfig.smtp.help',
    fields: [
      T('host', 'SMTP 服务器', 'alerting:channelConfig.smtp.field.host', 'smtp.example.com'),
      {
        key: 'port',
        label: '端口',
        label_key: 'alerting:channelConfig.smtp.field.port',
        type: 'number',
        required: true,
        defaultValue: 465,
      },
      {
        key: 'secure',
        label: 'SSL/TLS（465 通常开启）',
        label_key: 'alerting:channelConfig.smtp.field.secure',
        type: 'boolean',
        required: false,
        defaultValue: true,
      },
      T('user', '用户名', 'alerting:channelConfig.smtp.field.user', 'alerts@example.com'),
      T(
        'from',
        '发件人',
        'alerting:channelConfig.smtp.field.from',
        'Candela 告警 <alerts@example.com>',
        undefined,
        'alerting:channelConfig.smtp.field.fromPlaceholder',
      ),
    ],
    secretFields: [S('pass', '密码 / 授权码', 'alerting:channelConfig.smtp.field.pass')],
  },
  telegram: {
    channel: 'telegram',
    label: 'Telegram',
    label_key: 'alerting:channelConfig.telegram.label',
    hint: '用 @BotFather 建机器人拿 Token；联系人侧只填 chat_id。大陆需代理出口，可把 api_base 指到自建 Bot API 服务。',
    hint_key: 'alerting:channelConfig.telegram.hint',
    // 逐步配置方法（2026-10-09 真实排障得来：第 2 步漏做就会得到一句看不出所以然的 chat not found）
    help: [
      '1. 准备：在 Telegram 里搜 @BotFather → 发送 /newbot（用户名必须以 bot 结尾）→ 把它返回的 Token 填到下面「Bot Token」并保存；再用你自己的 Telegram 打开这个机器人点「START」——机器人不能主动发起会话，漏了这步发送测试会报 chat not found。',
      '2. 填写：联系人的 chat_id 填 @userinfobot 回给你的数字 ID（私聊即你的用户 ID）；要发到群，先把机器人拉进群，再用 BotFather 的 /setprivacy 关掉隐私模式，否则它收不到群消息。',
      '3. 验证：「发送测试」会真发一条，失败显示 Telegram 原始错误（如 chat not found）；服务器出海受限时把「API 地址」指向自建 Bot API 服务，留空即官方 api.telegram.org。',
    ].join('\n'),
    help_key: 'alerting:channelConfig.telegram.help',
    fields: [
      {
        key: 'api_base',
        label: 'API 地址（可空，默认官方）',
        label_key: 'alerting:channelConfig.telegram.field.apiBase',
        type: 'text',
        required: false,
        placeholder: 'https://api.telegram.org',
      },
    ],
    secretFields: [S('bot_token', 'Bot Token', 'alerting:channelConfig.telegram.field.botToken', '123456:ABC-DEF…')],
  },
  whatsapp: {
    channel: 'whatsapp',
    label: 'WhatsApp（Cloud API）',
    label_key: 'alerting:channelConfig.whatsapp.label',
    hint: '需 Meta Business 验证 + 号码注册 + 模板审核；告警属 business-initiated，窗口外只能发模板消息，模板需含 1~4 个变量（规则/当前值/条件/项目）。',
    hint_key: 'alerting:channelConfig.whatsapp.hint',
    // 「?」里的逐步配置方法（增补 v1.1）：只写「要准备什么 / 要填什么 / 怎么验证」三件事，
    // 不写未经核实的控制台路径与错误码清单——把猜测写成产品文案比不写更糟。
    help: [
      '1. 准备：Meta Business 账号完成验证，并有一个已注册的 WhatsApp Business 号码；在 Meta 后台取到 Phone Number ID。',
      '2. 填写：Phone Number ID、模板名、模板语言（如 zh_CN）、模板变量个数（1~4）。告警属「业务主动发起」：对方 24 小时内回过消息才能发自由文本，否则只能发已审核的模板。',
      '3. 验证：联系人号码填 E.164（不含「+」）；「发送测试」会带示例变量真发一条，失败显示 Meta 原始错误码（模板未审核 / 变量个数不符 / 号码未在测试名单）。',
    ].join('\n'),
    help_key: 'alerting:channelConfig.whatsapp.help',
    fields: [
      T('phone_number_id', 'Phone Number ID', 'alerting:channelConfig.whatsapp.field.phoneNumberId'),
      T('template_name', '模板名称', 'alerting:channelConfig.whatsapp.field.templateName', 'clklog_alert'),
      {
        key: 'template_lang',
        label: '模板语言',
        label_key: 'alerting:channelConfig.whatsapp.field.templateLang',
        type: 'text',
        required: true,
        defaultValue: 'zh_CN',
      },
      {
        key: 'param_count',
        label: '模板变量个数（1~4）',
        label_key: 'alerting:channelConfig.whatsapp.field.paramCount',
        type: 'number',
        required: true,
        defaultValue: 4,
      },
      {
        key: 'api_version',
        label: 'Graph API 版本',
        label_key: 'alerting:channelConfig.whatsapp.field.apiVersion',
        type: 'text',
        required: false,
        defaultValue: 'v21.0',
      },
    ],
    secretFields: [S('access_token', 'System User Token', 'alerting:channelConfig.whatsapp.field.accessToken')],
  },
  sms_aliyun: {
    channel: 'sms_aliyun',
    label: '阿里云短信',
    label_key: 'alerting:channelConfig.smsAliyun.label',
    hint: '签名与模板必须先在阿里云控制台报备审核通过；模板里需要一个变量接收摘要（示例 ${content}）。',
    hint_key: 'alerting:channelConfig.smsAliyun.hint',
    // 「?」里的逐步配置方法（增补 v1.1）：只写「要准备什么 / 要填什么 / 怎么验证」三件事，
    // 不写未经核实的控制台路径与错误码清单——把猜测写成产品文案比不写更糟。
    help: [
      '1. 准备：开通阿里云短信服务，并报备签名与模板（两者都要审核通过）；建议在 RAM 建一对只授短信权限的 AccessKey。',
      '2. 填写：AccessKey ID / Secret、签名名称、模板 CODE（形如 SMS_xxxxxxx）、区域。短信正文受模板约束，平台只发一行摘要。',
      '3. 验证：接收号码填 E.164（如 8613800138000）；「发送测试」失败会显示阿里云原始错误码（签名未审核 / 参数不符 / 余额不足），按码在阿里云文档可查。',
    ].join('\n'),
    help_key: 'alerting:channelConfig.smsAliyun.help',
    fields: [
      T('sign_name', '签名名称', 'alerting:channelConfig.smsAliyun.field.signName'),
      T('template_code', '模板 Code', 'alerting:channelConfig.smsAliyun.field.templateCode', 'SMS_123456789'),
      {
        key: 'endpoint',
        label: '接入点（可空）',
        label_key: 'alerting:channelConfig.smsAliyun.field.endpoint',
        type: 'text',
        required: false,
        placeholder: 'dysmsapi.aliyuncs.com',
      },
    ],
    secretFields: [
      S('access_key_id', 'AccessKey ID', 'alerting:channelConfig.smsAliyun.field.accessKeyId'),
      S('access_key_secret', 'AccessKey Secret', 'alerting:channelConfig.smsAliyun.field.accessKeySecret'),
    ],
  },
  sms_tencent: {
    channel: 'sms_tencent',
    label: '腾讯云短信',
    label_key: 'alerting:channelConfig.smsTencent.label',
    hint: '需要控制台应用（SmsSdkAppId）+ 已审核的签名与模板；模板里需要一个变量接收摘要。',
    hint_key: 'alerting:channelConfig.smsTencent.hint',
    // 「?」里的逐步配置方法（增补 v1.1）：只写「要准备什么 / 要填什么 / 怎么验证」三件事，
    // 不写未经核实的控制台路径与错误码清单——把猜测写成产品文案比不写更糟。
    help: [
      '1. 准备：开通腾讯云短信，创建签名与正文模板并等待审核通过；建议用子账号的最小权限密钥。',
      '2. 填写：SDK AppID、SecretId / SecretKey、签名内容、模板 ID、区域（如 ap-guangzhou）。平台只发一行摘要。',
      '3. 验证：「发送测试」失败会显示腾讯云原始错误码（签名或模板未审核 / 参数个数不符 / 余额不足），按码在腾讯云文档可查。',
    ].join('\n'),
    help_key: 'alerting:channelConfig.smsTencent.help',
    fields: [
      T('sdk_app_id', 'SmsSdkAppId', 'alerting:channelConfig.smsTencent.field.sdkAppId'),
      T('sign_name', '签名名称', 'alerting:channelConfig.smsTencent.field.signName'),
      T('template_id', '模板 ID', 'alerting:channelConfig.smsTencent.field.templateId'),
      {
        key: 'region',
        label: '地域',
        label_key: 'alerting:channelConfig.smsTencent.field.region',
        type: 'text',
        required: true,
        defaultValue: 'ap-guangzhou',
      },
    ],
    secretFields: [
      S('secret_id', 'SecretId', 'alerting:channelConfig.smsTencent.field.secretId'),
      S('secret_key', 'SecretKey', 'alerting:channelConfig.smsTencent.field.secretKey'),
    ],
  },
  sms_aws: {
    channel: 'sms_aws',
    label: 'AWS SNS',
    label_key: 'alerting:channelConfig.smsAws.label',
    hint: 'SNS 短信没有 cn-* 区域（大陆不可发）；发中国号码需先向 AWS Support 报备；默认沙箱只能发已验证号码。',
    hint_key: 'alerting:channelConfig.smsAws.hint',
    // 「?」里的逐步配置方法（增补 v1.1）：只写「要准备什么 / 要填什么 / 怎么验证」三件事，
    // 不写未经核实的控制台路径与错误码清单——把猜测写成产品文案比不写更糟。
    help: [
      '1. 准备：AWS 账号开通 SNS；SNS 默认处于沙箱，需先把接收号码加入沙箱白名单或申请解除限制。注意 SNS 没有 cn-* 区域，发给中国号码需另行申请。',
      '2. 填写：AccessKey / Secret、区域（如 ap-southeast-1）、Sender ID（部分区域要求）。',
      '3. 验证：「发送测试」失败会显示 SNS 原始错误（沙箱未放行 / 区域不支持 / 权限不足 / 号码未验证）。',
    ].join('\n'),
    help_key: 'alerting:channelConfig.smsAws.help',
    fields: [
      {
        key: 'region',
        label: 'Region',
        label_key: 'alerting:channelConfig.smsAws.field.region',
        type: 'text',
        required: true,
        defaultValue: 'ap-southeast-1',
      },
    ],
    secretFields: [
      S('access_key_id', 'AccessKey ID', 'alerting:channelConfig.smsAws.field.accessKeyId'),
      S('secret_access_key', 'Secret Access Key', 'alerting:channelConfig.smsAws.field.secretAccessKey'),
    ],
  },
  sms_twilio: {
    channel: 'sms_twilio',
    label: 'Twilio',
    label_key: 'alerting:channelConfig.smsTwilio.label',
    hint: '海外/容灾通道，无区域限制；From 号码需在 Twilio 侧验证或购买。',
    hint_key: 'alerting:channelConfig.smsTwilio.hint',
    // 「?」里的逐步配置方法（增补 v1.1）：只写「要准备什么 / 要填什么 / 怎么验证」三件事，
    // 不写未经核实的控制台路径与错误码清单——把猜测写成产品文案比不写更糟。
    help: [
      '1. 准备：Twilio 账号购号或申请一个发信号码（Sender）；试用账号只能发到已验证的号码。',
      '2. 填写：Account SID、Auth Token、From 号码（E.164，带「+」）。',
      '3. 验证：「发送测试」失败会显示 Twilio 错误码与说明（号码不支持该目的地 / 收件号码未验证 / 余额不足）。',
    ].join('\n'),
    help_key: 'alerting:channelConfig.smsTwilio.help',
    fields: [
      T(
        'from_number',
        'From 号码（E.164）',
        'alerting:channelConfig.smsTwilio.field.fromNumber',
        '+12025550123',
      ),
    ],
    secretFields: [
      S('account_sid', 'Account SID', 'alerting:channelConfig.smsTwilio.field.accountSid'),
      S('auth_token', 'Auth Token', 'alerting:channelConfig.smsTwilio.field.authToken'),
    ],
  },
};

export const CONFIG_CHANNEL_KEYS = Object.keys(CONFIG_SCHEMAS);

/** 字段名参数：中文兜底 + 资源键（前端 resolveParamKeys 按当前语言解析成显示名） */
function fieldParams(field: ConfigField): Record<string, unknown> {
  return field.label_key ? { field: field.label, field_key: field.label_key } : { field: field.label };
}

/**
 * 结构化校验：必填、类型与范围；返回 `ValidationIssue`（null 表示通过）。
 *
 * `message` 与升级前逐字一致（中文兜底），`message_key`/`params` 供前端本地化渲染。
 */
export function validateConfigInput(
  channel: string,
  config: Record<string, unknown>,
  secret: Record<string, unknown>,
  hasStoredSecret: boolean,
): ValidationIssue | null {
  const schema = CONFIG_SCHEMAS[channel];
  if (!schema) {
    return validationIssue(`不支持的通道配置：${channel}`, 'alerting:error.channelConfig.unsupported', { channel });
  }
  for (const field of schema.fields) {
    const value = config[field.key];
    if (field.required && (value === undefined || value === null || String(value).trim() === '')) {
      return validationIssue(`请填写「${field.label}」`, 'alerting:error.validate.required', fieldParams(field));
    }
    if (field.type === 'number' && value !== undefined && value !== null && value !== '') {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        return validationIssue(`「${field.label}」必须是数字`, 'alerting:error.validate.number', fieldParams(field));
      }
      if (field.key === 'port' && (num < 1 || num > 65535)) {
        return validationIssue('端口范围应为 1~65535', 'alerting:error.validate.portRange');
      }
      if (field.key === 'param_count' && (num < 1 || num > 4)) {
        return validationIssue('模板变量个数应为 1~4', 'alerting:error.validate.paramCount');
      }
    }
  }
  for (const field of schema.secretFields) {
    const provided = secret[field.key];
    const missing = provided === undefined || provided === null || String(provided).trim() === '';
    // 已有存量密钥时允许留空（表示不修改）
    if (field.required && missing && !hasStoredSecret) {
      return validationIssue(`请填写「${field.label}」`, 'alerting:error.validate.required', fieldParams(field));
    }
  }
  if (channel === 'telegram') {
    const base = String(config.api_base ?? '').trim();
    if (base && !/^https?:\/\//i.test(base)) {
      return validationIssue('API 地址必须以 http(s):// 开头', 'alerting:error.validate.apiBaseHttp');
    }
  }
  if (channel === 'smtp') {
    const from = String(config.from ?? '').trim();
    if (from && !/^[^\s@]+@[^\s@]+\.[^\s@]+$|^.*<[^\s@]+@[^\s@]+\.[^\s@]+>$/.test(from)) {
      return validationIssue('发件人格式不正确（可写 name <mail@example.com>）', 'alerting:error.validate.fromFormat');
    }
  }
  return null;
}
