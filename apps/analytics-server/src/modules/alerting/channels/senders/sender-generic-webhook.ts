import { renderTemplate } from '../../alert-template';
import { assertHttpOk, postJson, postText } from '../http';
import type { ContactTarget, SendContext, ValidationIssue } from '../channel-types';
import { validationIssue } from '../validation-issue';

/**
 * 通用 Webhook（phase: clklog-analytics-alert-channels-v1，PRD C-4）。
 *
 * 开源项目的长尾覆盖手段：URL / 请求头 / body 全部由使用者配置，body 支持占位符模板
 * （复用告警模板引擎），因此 PagerDuty、Opsgenie、Grafana OnCall、自建系统都能零代码接入。
 */

const DEFAULT_BODY_TEMPLATE = '{"text": "{{.text_json}}"}';

/** JSON 字符串转义后的正文（模板里写进 JSON 用它，避免换行/引号破坏结构） */
export function jsonEscapeText(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

export function parseHeaders(raw: unknown): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string' && key.trim()) out[key.trim()] = value;
    }
    return out;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = JSON.parse(raw) as unknown;
    return parseHeaders(parsed);
  }
  return {};
}

/** body 模板渲染：ctx.vars 基础上补 text / text_json / subject */
export function renderBodyTemplate(template: string, ctx: SendContext): string {
  const vars = {
    ...ctx.vars,
    text: ctx.text,
    text_json: jsonEscapeText(ctx.text),
    subject: ctx.subject,
  };
  return renderTemplate(template || DEFAULT_BODY_TEMPLATE, vars);
}

export async function sendGenericWebhook(ctx: SendContext): Promise<void> {
  const url = ctx.contact.webhook_url.trim();
  let headers: Record<string, string>;
  try {
    headers = parseHeaders(ctx.contact.options?.headers);
  } catch {
    throw new Error('webhook_headers_not_json');
  }
  const body = renderBodyTemplate(
    typeof ctx.contact.options?.body_template === 'string' ? ctx.contact.options.body_template : '',
    ctx,
  );
  const result = await postJson(url, safeParseJson(body), {
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
  assertHttpOk(result, 'webhook');
}

/** body 是 JSON 时按 JSON 发（保持 Content-Type 语义），否则按原文发 */
function safeParseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

export function validateGenericWebhook(contact: ContactTarget): ValidationIssue | null {
  const url = (contact.webhook_url ?? '').trim();
  if (!url) return validationIssue('请填写 Webhook 地址', 'alerting:error.validate.webhookRequired');
  if (!/^https?:\/\//i.test(url)) {
    return validationIssue('Webhook 地址必须以 http(s):// 开头', 'alerting:error.validate.webhookHttp');
  }
  if (contact.options?.headers !== undefined) {
    try {
      parseHeaders(contact.options.headers);
    } catch {
      return validationIssue(
        '自定义请求头必须是合法 JSON（如 {"Authorization":"Bearer xxx"}）',
        'alerting:error.validate.headersJson',
      );
    }
  }
  const template = contact.options?.body_template;
  if (typeof template === 'string' && template.trim()) {
    const error = renderTemplateCheck(template);
    if (error) {
      return validationIssue(`body 模板语法错误：${error}`, 'alerting:error.validate.bodyTemplate', { error });
    }
  }
  return null;
}

function renderTemplateCheck(template: string): string | null {
  // 用空上下文试渲染，语法错误会被抛出（引擎只支持变量/if/else/end）
  try {
    renderTemplate(template, { text: '', text_json: '' });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export { DEFAULT_BODY_TEMPLATE, postJson, postText };
