import { assertJsonOk, clampText, postJson } from '../http';
import type { ContactTarget, SendContext, ValidationIssue } from '../channel-types';
import { validationIssue } from '../validation-issue';

/**
 * Telegram Bot（phase: clklog-analytics-alert-channels-v1）。
 *
 * 官方限流：群 20 条/分钟、单聊约 1 条/秒（超限 429）；正文上限 4096 字符。
 * 大陆需代理出口：因此 `api_base` 可配（默认 https://api.telegram.org），
 * 使用者可指向自建 Bot API server 或网关。
 */

export function telegramApiBase(config: Record<string, unknown>): string {
  const base = typeof config.api_base === 'string' ? config.api_base.trim() : '';
  return (base || 'https://api.telegram.org').replace(/\/+$/, '');
}

export async function sendTelegram(
  ctx: SendContext,
  botToken: string,
  apiBase: string,
): Promise<void> {
  const chatId = ctx.contact.address.trim();
  const result = await postJson(`${apiBase}/bot${botToken}/sendMessage`, {
    chat_id: chatId,
    text: clampText(ctx.text, 4000),
    disable_web_page_preview: true,
  });
  assertJsonOk(result, 'telegram', (parsed) =>
    parsed.ok === false ? `error_${String(parsed.error_code ?? 'unknown')}` : null,
  );
}

export async function sendTelegramFromContext(ctx: SendContext): Promise<void> {
  const config = await ctx.readConfig('telegram');
  if (!config?.enabled) throw new Error('telegram_not_configured');
  const botToken = String(config.secret.bot_token ?? '').trim();
  if (!botToken) throw new Error('telegram_bot_token_missing');
  await sendTelegram(ctx, botToken, telegramApiBase(config.config));
}

export function validateTelegram(contact: ContactTarget): ValidationIssue | null {
  const chatId = (contact.address ?? '').trim();
  if (!chatId) {
    return validationIssue(
      '请填写 chat_id（群或私聊的会话 ID，可通过 @userinfobot 获取）',
      'alerting:error.validate.telegramChatIdRequired',
    );
  }
  if (!/^-?\d{5,20}$/.test(chatId)) {
    return validationIssue('chat_id 应为数字（群 ID 以 -100 开头）', 'alerting:error.validate.telegramChatIdFormat');
  }
  return null;
}
