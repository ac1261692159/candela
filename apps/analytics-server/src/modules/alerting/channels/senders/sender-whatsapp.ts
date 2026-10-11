import { assertJsonOk, postJson } from '../http';
import type { ContactTarget, SendContext, ValidationIssue } from '../channel-types';
import { validationIssue } from '../validation-issue';

/**
 * WhatsApp（phase: clklog-analytics-alert-channels-v1，P3）。
 *
 * 走**官方 Cloud API**（非官方库违反 ToS，一律不用）：
 *   POST https://graph.facebook.com/v<ver>/<phone_number_id>/messages
 *   Authorization: Bearer <System User token>
 *
 * 关键约束：告警属于 business-initiated，**窗口外只能发预审模板**——
 * 因此配置里要填已审核通过的模板名与语言，正文以模板参数形式传入。
 */

export interface WhatsAppConfig {
  phone_number_id: string;
  api_version: string;
  template_name: string;
  template_lang: string;
  /** 模板里 {{1}}..{{n}} 的个数（默认 4：规则、当前值、条件、项目） */
  param_count: number;
}

export function whatsAppApiVersion(config: Record<string, unknown>): string {
  const version = String(config.api_version ?? 'v21.0').trim();
  return /^v\d+\.\d+$/.test(version) ? version : 'v21.0';
}

/** 模板参数顺序（与文档一致）：规则名 / 当前值 / 触发条件 / 项目 */
export function templateParams(vars: Record<string, string>, count: number): string[] {
  const ordered = [
    `${vars.status ?? ''} ${vars.rule_name ?? ''}`.trim(),
    `${vars.value ?? ''}${vars.unit ?? ''}`,
    `${vars.comparator_fmt ?? ''} ${vars.threshold ?? ''}${vars.unit ?? ''}`.trim(),
    vars.project ?? '',
  ];
  return ordered.slice(0, Math.max(1, Math.min(4, count)));
}

export async function sendWhatsApp(
  config: WhatsAppConfig,
  accessToken: string,
  to: string,
  params: string[],
): Promise<void> {
  const url = `https://graph.facebook.com/${whatsAppApiVersion(config as unknown as Record<string, unknown>)}/${config.phone_number_id}/messages`;
  const result = await postJson(
    url,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: config.template_name,
        language: { code: config.template_lang },
        components: [
          {
            type: 'body',
            parameters: params.map((text) => ({ type: 'text', text })),
          },
        ],
      },
    },
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  assertJsonOk(result, 'whatsapp', (parsed) => {
    const error = parsed.error as { code?: number; message?: string } | undefined;
    return error?.code ? `code_${error.code}(${(error.message ?? '').slice(0, 60)})` : null;
  });
}

export async function sendWhatsAppFromContext(ctx: SendContext): Promise<void> {
  const config = await ctx.readConfig('whatsapp');
  if (!config?.enabled) throw new Error('whatsapp_not_configured');
  const accessToken = String(config.secret.access_token ?? '').trim();
  if (!accessToken) throw new Error('whatsapp_access_token_missing');
  const settings: WhatsAppConfig = {
    phone_number_id: String(config.config.phone_number_id ?? ''),
    api_version: String(config.config.api_version ?? 'v21.0'),
    template_name: String(config.config.template_name ?? ''),
    template_lang: String(config.config.template_lang ?? 'zh_CN'),
    param_count: Number(config.config.param_count ?? 4),
  };
  if (!settings.phone_number_id || !settings.template_name) throw new Error('whatsapp_config_incomplete');
  const to = ctx.contact.address.replace(/[^\d]/g, '');
  await sendWhatsApp(settings, accessToken, to, templateParams(ctx.vars, settings.param_count));
}

export function validateWhatsApp(contact: ContactTarget): ValidationIssue | null {
  const mobile = (contact.address ?? '').replace(/[^\d]/g, '');
  if (!mobile) {
    return validationIssue(
      '请填写接收号码（E.164，如 8613800138000）',
      'alerting:error.validate.whatsappRequired',
    );
  }
  if (mobile.length < 8 || mobile.length > 15) {
    return validationIssue(
      '号码位数不正确（E.164 不含 +，8~15 位）',
      'alerting:error.validate.whatsappFormat',
    );
  }
  return null;
}
