import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';
import {
  DeepseekHarnessConfig,
  parseDeepseekHarnessConfig,
} from './deepseek-harness-config';

export interface AppConfig {
  server: {
    port: number;
    cors: { origin: string };
  };
  /**
   * 平台时区（IANA 名，缺省 Asia/Shanghai；phase: clklog-analytics-timezone-v1）。
   * 统计日历与落库 stat_date 的口径基准；缺失时由 TimeModule 补默认值。
   */
  analytics?: {
    timezone?: string;
  };
  /**
   * 后台定时任务总开关（告警检测 / 指标采样 / 日志清理 / 卡片缓存温热）。
   *
   * ingestor 进程复用 AppModule，若不禁用就会与 server 各跑一份：双倍 ClickHouse
   * 扫描、重复采样与重复清理审计（见 `CODE_HANDOVER.md` AL-02）。由
   * `ENABLE_INGESTOR` 派生，不进 YAML。
   */
  background_workers: boolean;
  deepseek_harness: DeepseekHarnessConfig;
  clickhouse: {
    write: ClickHouseConfig;
    readonly: ClickHouseConfig;
    tcp: ClickHouseConfig;
  };
  /**
   * 数据清洗（定点删除，phase: clklog-data-management-v1.2）。
   * 口令未注入时 enabled=false：接口显式返回「清洗账号未配置」，**不回退高权账号**。
   */
  cleanup: {
    enabled: boolean;
    username: string;
    password: string | null;
    confirmKey: string;
    /** 备份库（写入前快照） */
    backupDatabase: string;
  };
  mysql: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    url: string;
  };
  redis: {
    host: string;
    port: number;
    db: number;
    password: string | null;
    keyPrefix: string;
    queryCache: {
      prefix: string;
      ttlSeconds: number;
    };
  };
  kafka: {
    brokers: string[];
    clientId: string;
    consumerGroupId: string;
    topic: string;
    sasl: null | { mechanism: string; username: string; password: string };
    ssl: boolean;
  };
  ingestor: {
    batchSize: number;
    batchFlushMs: number;
    maxRetries: number;
    retryDelayMs: number;
    autoCommit: boolean;
    replayGroupSuffix: string;
  };
  query: {
    maxExecutionTime: number;
    maxResultRows: number;
    defaultGroupLimit: number;
  };
  sqlReport: {
    blacklistedKeywords: string[];
    forceLimit: number;
  };
  log: {
    level: string;
    slowQueryThresholdMs: number;
  };
  alerting: AlertingConfig;
  authMail: AuthMailConfig;
  /**
   * 对拍报告落盘目录（phase: clklog-data-quality-ops-v1）。
   * 缺省 /data/logs/production/clklog_manager/reconcile；写不进只记日志，不影响对拍结果。
   */
  reconcile?: { reportDir: string };
}

/**
 * 账号域邮件通道（phase: clklog-analytics-account-lifecycle-v2）。
 * 与告警 ALERT_SMTP_* 完全独立；enabled=false 时忘记密码/设密/邀请邮件整体降级。
 */
export interface AuthMailConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
  /** 对外可访问的站点基址（邮件链接用，如 https://analytics.example.com）；配置了 SMTP 就必须配置 */
  publicBaseUrl: string;
}

export interface AlertingConfig {
  smtp: {
    host: string;
    port: number;
    user: string;
    pass: string;
    from: string;
    secure: boolean;
  };
  /** 通道凭证加密主密钥（base64 的 32 字节；缺失时不允许保存凭证） */
  configKey: string;
  sms: {
    secretId: string;
    secretKey: string;
    sdkAppId: string;
    signName: string;
    templateId: string;
    region: string;
  };
}

interface ClickHouseConfig {
  host: string;
  port: number;
  protocol: 'http' | 'https';
  username: string;
  password: string;
  database: string;
}

const ENV_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function resolveValue(value: string, context: string): string {
  if (typeof value !== 'string') return value;
  const match = value.match(ENV_PLACEHOLDER);
  if (!match) return value;
  const envName = match[1];
  const envValue = process.env[envName];
  if (envValue === undefined || envValue === '') {
    throw new Error(`环境变量未设置: ${envName}（用于 ${context}）`);
  }
  return envValue;
}

function interpolateEnv(obj: unknown, context = 'config'): unknown {
  if (typeof obj === 'string') {
    return resolveValue(obj, context);
  }
  if (Array.isArray(obj)) {
    return obj.map((item, index) => interpolateEnv(item, `${context}[${index}]`));
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateEnv(value, `${context}.${key}`);
    }
    return result;
  }
  return obj;
}

/** loadYamlConfig 解析出的真实路径，供启动摘要展示 */
let resolvedConfigPath = '';

function loadYamlConfig(): AppConfig {
  const configPath =
    process.env.APP_CONFIG_PATH ||
    path.resolve(__dirname, '../../config_dev.yaml');

  if (!fs.existsSync(configPath)) {
    throw new Error(`配置文件不存在: ${configPath}`);
  }
  resolvedConfigPath = configPath;

  const content = fs.readFileSync(configPath, 'utf-8');
  const rawConfig = yaml.load(content) as Record<string, unknown>;
  const interpolated = interpolateEnv(rawConfig, 'config') as Record<string, unknown>;
  const config = {
    ...interpolated,
    deepseek_harness: parseDeepseekHarnessConfig(interpolated.deepseek_harness),
    alerting: parseAlertingConfig(),
    authMail: parseAuthMailConfig(),
    cleanup: parseCleanupConfig(),
    background_workers: resolveBackgroundWorkers(),
  } as AppConfig;

  // 独立 ingestor 复用 AppModule，但不能启动 HTTP/Harness Unix Socket 生命周期。
  if (process.env.ENABLE_INGESTOR === 'true') {
    config.deepseek_harness = { ...config.deepseek_harness, enabled: false };
  }

  // 环境变量覆盖端口
  if (process.env.PORT) {
    config.server.port = parseInt(process.env.PORT, 10);
  }

  return config;
}

function optionalEnv(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function parseAlertingConfig(): AlertingConfig {
  const port = Number.parseInt(optionalEnv('ALERT_SMTP_PORT') || '465', 10);
  return {
    configKey: optionalEnv('ALERT_CONFIG_KEY'),
    smtp: {
      host: optionalEnv('ALERT_SMTP_HOST'),
      port: Number.isFinite(port) && port > 0 ? port : 465,
      user: optionalEnv('ALERT_SMTP_USER'),
      pass: optionalEnv('ALERT_SMTP_PASS'),
      from: optionalEnv('ALERT_SMTP_FROM'),
      secure: optionalEnv('ALERT_SMTP_SECURE') !== '0',
    },
    sms: {
      secretId: optionalEnv('ALERT_SMS_SECRET_ID'),
      secretKey: optionalEnv('ALERT_SMS_SECRET_KEY'),
      sdkAppId: optionalEnv('ALERT_SMS_SDK_APP_ID'),
      signName: optionalEnv('ALERT_SMS_SIGN_NAME'),
      templateId: optionalEnv('ALERT_SMS_TEMPLATE_ID'),
      region: optionalEnv('ALERT_SMS_REGION') || 'ap-guangzhou',
    },
  };
}

function parseAuthMailConfig(): AuthMailConfig {
  const port = Number.parseInt(optionalEnv('AUTH_SMTP_PORT') || '465', 10);
  const host = optionalEnv('AUTH_SMTP_HOST');
  return {
    enabled: Boolean(host),
    host,
    port: Number.isFinite(port) && port > 0 ? port : 465,
    user: optionalEnv('AUTH_SMTP_USER'),
    pass: optionalEnv('AUTH_SMTP_PASS'),
    from: optionalEnv('AUTH_SMTP_FROM'),
    secure: optionalEnv('AUTH_SMTP_SECURE') !== '0',
    publicBaseUrl: optionalEnv('AUTH_PUBLIC_BASE_URL'),
  };
}

/**
 * 数据清洗配置（定点删除用；phase: clklog-data-management-v1.2）。
 *
 * 口令走环境变量注入（ClickHouse 里的 `sa_cleanup` 账号，仅被授权
 * SELECT / ALTER DELETE / ALTER UPDATE 于 clklog_sa.*，见 migrate-clickhouse.ts）。
 * 未注入（或长度不足 16）→ `enabled=false`：接口拒绝执行且不回退高权账号（红线：最小权限）。
 */
function parseCleanupConfig(): AppConfig['cleanup'] {
  // 取值顺序：进程环境 → 凭据文件。文件是**故意**支持的：
  // 生产由 supervisor 直接拉起 node（不走 run.sh），环境变量来自 Puppet 生成的 supervisor ini；
  // 而 CLI 清洗脚本（scripts/cleanup.sh）与运维习惯把凭据放在 /root/.clklog-cleanup.env。
  // 读同一份文件即可让「平台内定点删除」不依赖 Puppet 同步，轮换一次两处同时生效。
  const fromFile = readCleanupFile(process.env.CLEANUP_ENV_FILE);
  const password = ((process.env.CLICKHOUSE_CLEANUP_PASSWORD ?? '').trim() || fromFile.CLICKHOUSE_PASSWORD || '').trim();
  const confirmKey = (process.env.CLEANUP_CONFIRM_KEY ?? '').trim();
  return {
    enabled: password.length >= 16,
    username: ((process.env.CLICKHOUSE_CLEANUP_USER ?? '').trim() || fromFile.CLICKHOUSE_USER || 'sa_cleanup').trim(),
    password: password || null,
    // 未配置确认密钥时用配置值兜底（进程内随机 → 重启失效，属可接受降级）
    confirmKey: confirmKey || `ephemeral-${Math.random().toString(36).slice(2)}`,
    backupDatabase: 'clklog_sa_bak',
  };
}

/** 读清洗凭据文件（KEY=VALUE，忽略注释/空行）；缺省路径与 scripts/cleanup.sh 一致 */
function readCleanupFile(explicitPath?: string): Record<string, string> {
  const path = (explicitPath ?? '/root/.clklog-cleanup.env').trim();
  try {
    if (!fs.existsSync(path)) return {};
    const out: Record<string, string> = {};
    for (const line of fs.readFileSync(path, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (value) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export default loadYamlConfig;
export const appConfig = loadYamlConfig();

/** 实际生效的配置文件路径（启动摘要用，便于一眼看出「我加载的是哪份配置」） */
export const appConfigPath = resolvedConfigPath;

/**
 * 后台调度（卡片缓存刷新 / 告警检测 / 保留期清理 / 日志清理 / 指标采样 / 三个每日 Cron）
 * 只能由生产 server 跑：本地开发经隧道直连生产库，一旦本机实例也跑调度，就多出一个写者
 * （2026-09-24 实际发生过：残留的 nest --watch 进程在生产库上跑了 2 天调度）。
 */
function resolveBackgroundWorkers(): boolean {
  const override = process.env.CLKLOG_BACKGROUND_WORKERS;
  if (override === 'true') return true;
  if (override === 'false') return false;
  if (process.env.ENABLE_INGESTOR === 'true') return false;
  return process.env.NODE_ENV === 'production';
}

/** 判定理由（与 resolveBackgroundWorkers 的分支一一对应），只用于启动摘要 */
function backgroundWorkersReason(): string {
  const override = process.env.CLKLOG_BACKGROUND_WORKERS;
  if (override === 'true' || override === 'false') {
    return `显式覆盖 CLKLOG_BACKGROUND_WORKERS=${override}`;
  }
  if (process.env.ENABLE_INGESTOR === 'true') return 'ingestor 只做消费与写入';
  return `NODE_ENV=${process.env.NODE_ENV ?? '(未设置)'}`;
}

/** 从 DATABASE_URL 取「主机:端口」；绝不外泄用户名与口令 */
function mysqlHostLabel(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return '(未设置)';
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '3306'}`;
  } catch {
    return '(无法解析)';
  }
}

/**
 * 启动摘要：进程角色、调度开关、判据、配置来源与两个库的主机。
 * 只打印主机与端口，不含任何凭据。
 */
export function backgroundWorkerSummary(): string {
  const role = process.env.ENABLE_INGESTOR === 'true' ? 'ingestor' : 'server';
  const clickhouse = appConfig.clickhouse?.readonly;
  const skipped = '卡片缓存刷新/告警检测/告警保留期清理/日志清理/指标采样/分群重算/埋点元数据统计/标签重算';
  return `后台调度：${appConfig.background_workers ? '已启用' : '未启用'}`
    + `（${backgroundWorkersReason()}）｜角色=${role}｜配置=${appConfigPath}`
    + `｜MySQL=${mysqlHostLabel()}｜ClickHouse=${clickhouse ? `${clickhouse.host}:${clickhouse.port}` : '(未配置)'}`
    + `${appConfig.background_workers ? '' : `｜跳过=${skipped}`}`;
}

