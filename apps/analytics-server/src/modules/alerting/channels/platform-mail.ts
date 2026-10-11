import type { SmtpSettings } from './senders/sender-email';

/**
 * 平台邮件回落（phase: account-lifecycle-v3 增补 v3.2 / PRD UX-7）。
 * 告警 email 通道的 SMTP 解析三级：通道库内配置 > ALERT_SMTP_* env > 平台邮件通道。
 * 本文件刻意不 import configuration 与 AuthMailService（测试环境约束，装配层注入解析器）。
 */

export type PlatformSmtpResolver = () => Promise<SmtpSettings | null>;

let resolver: PlatformSmtpResolver | null = null;

/** 由装配层（AlertChannelConfigService）启动时注入平台解析器 */
export function bindPlatformSmtpResolver(r: PlatformSmtpResolver | null): void {
  resolver = r;
}

/** 组装告警 email 发送回退：平台已配置优先于告警 env；都缺省返回 env 原样（可能 host 为空交上层报未配置） */
export async function buildEmailFallback(envSmtp: {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}): Promise<SmtpSettings> {
  if (resolver) {
    const platform = await resolver().catch(() => null);
    if (platform && platform.host && platform.from) return platform;
  }
  const env = { host: envSmtp.host, port: envSmtp.port, secure: envSmtp.secure, user: envSmtp.user, pass: envSmtp.pass, from: envSmtp.from };
  return env;
}
