import type { Transporter } from 'nodemailer';
import type { ContactTarget, SendContext, ValidationIssue } from '../channel-types';
import { validationIssue } from '../validation-issue';

/**
 * 邮件通道（phase: clklog-analytics-alert-channels-v1）。
 *
 * 用 `nodemailer` 替代原先手写的 SMTP 客户端（协议细节、STARTTLS、认证、MIME 编码都交给它）。
 * 凭证来自平台配置（`smtp`），未配置时回退到环境变量 `ALERT_SMTP_*`（升级不中断）。
 */

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export function smtpReady(settings: SmtpSettings): boolean {
  return Boolean(settings.host && settings.from);
}

/** 惰性加载 nodemailer：启动不付代价，未装时给出可读错误 */
async function loadNodemailer(): Promise<typeof import('nodemailer')> {
  try {
    return await import('nodemailer');
  } catch {
    throw new Error('nodemailer_not_installed');
  }
}

export async function createTransport(settings: SmtpSettings): Promise<Transporter> {
  const nodemailer = await loadNodemailer();
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: settings.user ? { user: settings.user, pass: settings.pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}

export async function sendSmtp(settings: SmtpSettings, to: string, subject: string, text: string): Promise<void> {
  if (!smtpReady(settings)) throw new Error('smtp_not_configured');
  const transport = await createTransport(settings);
  try {
    await transport.sendMail({
      from: settings.from,
      to,
      subject: subject || 'Candela 告警',
      text,
    });
  } finally {
    transport.close();
  }
}

/** 连通性 + 认证校验（发送测试先跑它，错误更可读） */
export async function verifySmtp(settings: SmtpSettings): Promise<void> {
  if (!smtpReady(settings)) throw new Error('smtp_not_configured');
  const transport = await createTransport(settings);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

export async function sendEmailFromContext(
  ctx: SendContext,
  fallback: SmtpSettings,
): Promise<void> {
  const configured = await ctx.readConfig('smtp');
  const own: SmtpSettings = {
    host: String(configured?.config.host ?? ''),
    port: Number(configured?.config.port ?? 465),
    secure: configured?.config.secure !== false,
    user: String(configured?.config.user ?? ''),
    pass: String(configured?.secret.pass ?? ''),
    from: String(configured?.config.from ?? ''),
  };
  // 只有告警侧**真的可用**（enabled 且 host/from 齐备）才用它。缺字段的空配置行若被当成可用，
  // 会在发送时抛 smtp_not_configured 并让投递失败——此时应当回落到平台邮件通道/ALERT_SMTP_*
  // （2026-10-09 生产实测踩到：暂停再恢复在无配置通道上留了一行 enabled 空配置）
  const settings = configured?.enabled && smtpReady(own) ? own : fallback;
  await sendSmtp(settings, ctx.contact.address.trim(), ctx.subject, ctx.text);
}

export function validateEmailContact(contact: ContactTarget): ValidationIssue | null {
  const address = (contact.address ?? '').trim();
  if (!address) return validationIssue('请填写收件邮箱', 'alerting:error.validate.emailRequired');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return validationIssue('邮箱格式不正确', 'alerting:error.validate.emailFormat');
  }
  return null;
}
