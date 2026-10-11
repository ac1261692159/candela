import type { AuthMailConfig as EnvAuthMailConfig } from '../../config/configuration';

/**
 * 账号域邮件配置注入令牌（phase: clklog-analytics-account-lifecycle-v2）。
 * 本文件**不得**静态 import configuration——configuration 在模块加载时就读环境变量，
 * 测试进程缺 CLICKHOUSE_PASSWORD 等会直接炸掉所有传递依赖它的 spec（CI 实测教训）。
 */
export const AUTH_MAIL_CONFIG = Symbol('auth-mail-config');
export type { EnvAuthMailConfig };

/** 装配层注入的启动载荷：env 快照 + 凭证主密钥原文（仅服务端使用，不外发） */
export interface AuthMailBoot {
  env: EnvAuthMailConfig;
  configKey: string;
}

/** 生效的运行时 SMTP 配置（DB 优先，env 兜底，增补 v1.1） */
export interface SmtpRuntime {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  publicBaseUrl: string;
}

export const FALLBACK_PUBLIC_BASE_URL = '';
