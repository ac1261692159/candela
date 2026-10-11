import { createHmac } from 'crypto';
import { assertHttpOk, assertJsonOk, clampText, postJson } from '../http';
import type { ContactTarget, SendContext, ValidationIssue } from '../channel-types';
import { validationIssue } from '../validation-issue';

/**
 * 群机器人与 IM 类通道（phase: clklog-analytics-alert-channels-v1）：
 * 飞书 / 钉钉（含加签）/ 企业微信（通用 Webhook 见 sender-generic-webhook.ts）。
 *
 * 这些通道的「凭证 = webhook URL」，存在联系人里；只有 Telegram / WhatsApp / 短信 / 邮件
 * 才需要平台级凭证。
 */

/**
 * 飞书加签（官方「设置签名校验」）。⚠️ 与钉钉算法**互为镜像**，抄错就是 19021：
 *   签名字符串 = timestamp + "\n" + secret（timestamp 为**秒**），
 *   把签名字符串当 **key**、对**空串**做 HmacSHA256，再 Base64；
 *   timestamp 与 sign 放在**请求体**里（不是 URL）。时间戳需在 1 小时内。
 */
export function feishuSignature(secret: string, timestampSec: string): string {
  return createHmac('sha256', Buffer.from(`${timestampSec}\n${secret}`, 'utf8'))
    .update(Buffer.alloc(0))
    .digest('base64');
}

/** 飞书：HTTP 200 也可能带 code≠0（既有实现已验证过这个坑） */
export async function sendFeishu(webhookUrl: string, text: string, secret?: string): Promise<void> {
  const body: Record<string, unknown> = { msg_type: 'text', content: { text } };
  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    body.timestamp = timestamp;
    body.sign = feishuSignature(secret, timestamp);
  }
  const result = await postJson(webhookUrl, body);
  assertJsonOk(result, 'feishu', (parsed) =>
    typeof parsed.code === 'number' && parsed.code !== 0
      ? `code_${parsed.code}${typeof parsed.msg === 'string' ? `(${parsed.msg.slice(0, 40)})` : ''}`
      : null,
  );
}

/**
 * 钉钉加签（官方要求把 timestamp 与 sign 拼进 URL；算法由 Apache DolphinScheduler 与
 * prometheus-webhook-dingtalk 两份实现交叉确认）：
 *   sign = base64(HmacSHA256(key=secret, msg=timestamp + "\n" + secret))，timestamp 毫秒，
 *   URL 追加 `&timestamp=<ms>&sign=<urlencode(sign)>`。
 */
export function dingtalkSignedUrl(webhookUrl: string, secret: string, now = Date.now()): string {
  const timestamp = String(now);
  const signature = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(`${timestamp}\n${secret}`, 'utf8'))
    .digest('base64');
  const separator = webhookUrl.includes('?') ? '&' : '?';
  return `${webhookUrl}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(signature)}`;
}

export async function sendDingtalk(webhookUrl: string, text: string, secret?: string): Promise<void> {
  const url = secret ? dingtalkSignedUrl(webhookUrl, secret) : webhookUrl;
  const result = await postJson(url, { msgtype: 'text', text: { content: text } });
  assertJsonOk(result, 'dingtalk', (parsed) =>
    typeof parsed.errcode === 'number' && parsed.errcode !== 0
      ? `errcode_${parsed.errcode}${typeof parsed.errmsg === 'string' ? `(${parsed.errmsg.slice(0, 40)})` : ''}`
      : null,
  );
}

/** 企业微信：官方限流 20 条/分钟，text 上限 2048 字节 */
export async function sendWecom(webhookUrl: string, text: string): Promise<void> {
  const result = await postJson(webhookUrl, { msgtype: 'text', text: { content: clampText(text, 1800) } });
  assertJsonOk(result, 'wecom', (parsed) =>
    typeof parsed.errcode === 'number' && parsed.errcode !== 0
      ? `errcode_${parsed.errcode}${typeof parsed.errmsg === 'string' ? `(${parsed.errmsg.slice(0, 40)})` : ''}`
      : null,
  );
}

function requireWebhook(contact: ContactTarget): ValidationIssue | null {
  const url = (contact.webhook_url ?? '').trim();
  if (!url) return validationIssue('请填写 Webhook 地址', 'alerting:error.validate.webhookRequired');
  if (!/^https:\/\//i.test(url)) {
    return validationIssue('Webhook 地址必须是 https:// 开头', 'alerting:error.validate.webhookHttps');
  }
  return null;
}

export function validateFeishu(contact: ContactTarget): ValidationIssue | null {
  const base = requireWebhook(contact);
  if (base) return base;
  return /open\.feishu\.cn|feishu\.cn\/open-apis\/bot/i.test(contact.webhook_url)
    ? null
    : validationIssue(
        '看起来不是飞书机器人 webhook（应形如 https://open.feishu.cn/open-apis/bot/v2/hook/…）',
        'alerting:error.validate.feishuWebhook',
      );
}

export function validateDingtalk(contact: ContactTarget): ValidationIssue | null {
  const base = requireWebhook(contact);
  if (base) return base;
  if (!/oapi\.dingtalk\.com\/robot\/send/i.test(contact.webhook_url)) {
    return validationIssue(
      '看起来不是钉钉机器人 webhook（应形如 https://oapi.dingtalk.com/robot/send?access_token=…）',
      'alerting:error.validate.dingtalkWebhook',
    );
  }
  const secret = typeof contact.options?.secret === 'string' ? contact.options.secret.trim() : '';
  if (secret && secret.length < 8) {
    return validationIssue('加签密钥过短（钉钉控制台生成的 SEC…）', 'alerting:error.validate.dingtalkSecret');
  }
  return null;
}

export function validateWecom(contact: ContactTarget): ValidationIssue | null {
  const base = requireWebhook(contact);
  if (base) return base;
  return /qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send/i.test(contact.webhook_url)
    ? null
    : validationIssue(
        '看起来不是企业微信群机器人 webhook（应形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…）',
        'alerting:error.validate.wecomWebhook',
      );
}

export function buildChatPayload(channel: string): (ctx: SendContext) => Promise<void> {
  switch (channel) {
    case 'feishu_webhook':
      return ({ contact, text }) =>
        sendFeishu(
          contact.webhook_url,
          text,
          typeof contact.options?.secret === 'string' ? contact.options.secret : undefined,
        );
    case 'dingtalk':
      return ({ contact, text }) =>
        sendDingtalk(
          contact.webhook_url,
          text,
          typeof contact.options?.secret === 'string' ? contact.options.secret : undefined,
        );
    case 'wecom':
      return ({ contact, text }) => sendWecom(contact.webhook_url, text);
    default:
      throw new Error(`unknown_chat_channel_${channel}`);
  }
}
