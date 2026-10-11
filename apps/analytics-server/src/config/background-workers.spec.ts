// @jest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 后台调度的开工判据（phase: clklog-analytics-worker-singleton-v1）。
 *
 * 背景：2026-09-24 事故 —— 本地残留实例经隧道连生产库，跑了两天生产调度。
 * 这里用「不同环境变量组合下重新加载配置」的方式锁住判据，避免再退化回
 * 「只要不是 ingestor 就开工」。
 */
const ENV_KEYS = [
  'NODE_ENV',
  'ENABLE_INGESTOR',
  'CLKLOG_BACKGROUND_WORKERS',
  'APP_CONFIG_PATH',
  'DATABASE_URL',
] as const;

const FIXTURE = path.join(os.tmpdir(), `clklog-config-fixture-${process.pid}.yaml`);

function loadWith(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  jest.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.APP_CONFIG_PATH = FIXTURE;
  Object.assign(process.env, env);
  // 需要真实加载配置模块本身，才能验证判据；夹具 YAML 里不含 ${} 占位符，故不依赖任何密钥。
  return require('./configuration') as typeof import('./configuration');
}

describe('后台调度开工判据', () => {
  beforeAll(() => {
    fs.writeFileSync(FIXTURE, [
      'server:',
      '  port: 3100',
      '  cors:',
      "    origin: '*'",
      'deepseek_harness:',
      '  enabled: false',
      '  runtime:',
      '    linux_user: harness',
      '    home_subdir: clklog-ai',
      '    idle_ttl_ms: 900000',
      '    max_runtimes: 8',
      '    max_tokens: 8192',
      '    container_image: docker.io/library/node:24.20.0-bookworm-slim',
      '  workspace:',
      '    default_kind: persistent',
      '    temporary_ttl_ms: 86400000',
      '    recovery_retention_ms: 604800000',
      '    max_bytes: 1073741824',
      '  defaults:',
      '    permission_preset: workspace_write',
      'clickhouse:',
      '  write: { host: 127.0.0.1, port: 18123, database: clklog_sa, username: w, password: w }',
      '  readonly: { host: 127.0.0.1, port: 18123, database: clklog_sa, username: r, password: r }',
      '  tcp: { host: 127.0.0.1, port: 19000, database: clklog_sa, username: t, password: t }',
      'mysql:',
      '  host: 127.0.0.1',
      '  port: 13306',
      '  database: clklog_sa_meta',
      '  username: u',
      '  password: p',
      '  url: mysql://u:p@127.0.0.1:13306/clklog_sa_meta',
      '',
    ].join('\n'), 'utf-8');
  });

  afterAll(() => {
    fs.rmSync(FIXTURE, { force: true });
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('生产 server 才开工', () => {
    const mod = loadWith({ NODE_ENV: 'production' });
    expect(mod.appConfig.background_workers).toBe(true);
    expect(mod.backgroundWorkerSummary()).toContain('后台调度：已启用');
  });

  it('本地开发不开工（本次事故的直接原因）', () => {
    const mod = loadWith({ NODE_ENV: 'development' });
    expect(mod.appConfig.background_workers).toBe(false);
    const summary = mod.backgroundWorkerSummary();
    expect(summary).toContain('未启用');
    expect(summary).toContain('NODE_ENV=development');
    // 跳过哪些任务要能一眼看到，否则「为什么没跑」还是要翻代码
    expect(summary).toContain('跳过=');
    expect(summary).toContain('分群重算');
  });

  it('NODE_ENV 未设置时按非生产处理', () => {
    const mod = loadWith({});
    expect(mod.appConfig.background_workers).toBe(false);
    expect(mod.backgroundWorkerSummary()).toContain('NODE_ENV=(未设置)');
  });

  it('ingestor 即便在生产也不开工', () => {
    const mod = loadWith({ NODE_ENV: 'production', ENABLE_INGESTOR: 'true' });
    expect(mod.appConfig.background_workers).toBe(false);
    const summary = mod.backgroundWorkerSummary();
    expect(summary).toContain('角色=ingestor');
    expect(summary).toContain('ingestor 只做消费与写入');
  });

  it('显式覆盖优先于环境判定（本地联调用）', () => {
    expect(loadWith({ NODE_ENV: 'development', CLKLOG_BACKGROUND_WORKERS: 'true' })
      .appConfig.background_workers).toBe(true);
    expect(loadWith({ NODE_ENV: 'production', CLKLOG_BACKGROUND_WORKERS: 'false' })
      .appConfig.background_workers).toBe(false);
  });

  it('摘要给出配置来源与库主机，但不含凭据', () => {
    const summary = loadWith({
      NODE_ENV: 'production',
      DATABASE_URL: 'mysql://clklog_sa_app:supersecret@mysql.internal:3306/clklog_sa_meta',
    }).backgroundWorkerSummary();
    expect(summary).toContain('配置=');
    expect(summary).toContain('MySQL=mysql.internal:3306');
    expect(summary).toContain('ClickHouse=127.0.0.1:18123');
    expect(summary).not.toContain('supersecret');
    expect(summary).not.toContain('mysql://');
  });

  it('DATABASE_URL 缺失或不可解析时不抛错', () => {
    expect(loadWith({ NODE_ENV: 'production' }).backgroundWorkerSummary()).toContain('MySQL=(未设置)');
    expect(loadWith({ NODE_ENV: 'production', DATABASE_URL: 'not-a-url' }).backgroundWorkerSummary())
      .toContain('MySQL=(无法解析)');
  });
});
