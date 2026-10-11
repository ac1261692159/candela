import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { appConfig } from '../config/configuration';

/**
 * ClickHouse 幂等迁移入口。
 *
 * 由 `scripts/server-upgrade.sh` 在 `prisma migrate deploy` 之后、服务重启之前调用；
 * **任一步失败即非 0 退出，升级中止**（不允许"服务起来了但表结构不对"）。
 *
 * 设计原则（见 docs/architecture/clklog-analytics-design-user-property-path-v1.md）：
 * 1. 只做结构对齐，**不删业务数据**；
 * 2. 幂等：已对齐则 no-op；
 * 3. 需要换排序键的表（无法 ALTER）用"建暂存表 → 回填 → RENAME 原子切换 → 旧表改名保留"，
 *    保留期内可反向 RENAME 回滚。
 */

const DB = appConfig.clickhouse.write.database || 'clklog_sa';
/** 与 DDL DEFAULT 一致：现网单项目，历史无 project_name 的行回填该值 */
const DEFAULT_PROJECT = 'clklogapp';
const USER_PROFILE_TABLE = 'sa_user_profiles';
const USER_PROFILE_STAGING = 'sa_user_profiles_v2';
/** 数据治理·清洗：备份库 / 演练库 / 清洗账号 */
const CLEANUP_BAK_DB = 'clklog_sa_bak';
const CLEANUP_STAGING_DB = 'clklog_sa_staging';
const CLEANUP_USER = 'sa_cleanup';

const DDL_USER_PROFILES = `CREATE TABLE IF NOT EXISTS ${DB}.${USER_PROFILE_TABLE}
(
    project_name LowCardinality(String) DEFAULT '${DEFAULT_PROJECT}',
    distinct_id  String,
    user_key     String DEFAULT '',
    properties   String CODEC(ZSTD(3)),
    updated_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (project_name, distinct_id)`;

const DDL_USER_PROFILES_STAGING = `CREATE TABLE IF NOT EXISTS ${DB}.${USER_PROFILE_STAGING}
(
    project_name LowCardinality(String) DEFAULT '${DEFAULT_PROJECT}',
    distinct_id  String,
    user_key     String DEFAULT '',
    properties   String CODEC(ZSTD(3)),
    updated_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (project_name, distinct_id)`;

function createWriteClient(withDatabase: boolean): ClickHouseClient {
  return createClient({
    host: `${appConfig.clickhouse.write.protocol}://${appConfig.clickhouse.write.host}:${appConfig.clickhouse.write.port}`,
    username: appConfig.clickhouse.write.username,
    password: appConfig.clickhouse.write.password,
    ...(withDatabase ? { database: DB } : {}),
  });
}

/**
 * 数据治理·敏感数据清洗的基础设施（`docs/architecture/clklog-analytics-design-data-governance.md` §5）。
 *
 * - 备份库 `clklog_sa_bak`：清洗前把受影响行快照进来（红线 6）。
 * - 演练库 `clklog_sa_staging`：清洗 SQL 先在它上面跑通并核对结果（PRD G-C3）。
 * - 清洗账号 `sa_cleanup`：**SQL 建权**（不使用 users.d XML —— 实测 XML 的 `<grants>`
 *   会被 ClickHouse 扩展成含 `INSERT/DROP/CREATE DATABASE` 的宽权限，且该文件有
 *   「挂载源被未知机制还原」的历史）；口令经环境变量注入（红线 3），未注入则跳过本步。
 *
 * 建权语句显式关闭 `log_queries`：否则带明文口令的 CREATE/ALTER USER 会落进 `system.query_log`。
 */
export async function ensureCleanupSchema(ch: ClickHouseClient): Promise<string> {
  const steps: string[] = [];
  for (const db of [CLEANUP_BAK_DB, CLEANUP_STAGING_DB]) {
    await ch.command({ query: `CREATE DATABASE IF NOT EXISTS ${db}` });
  }
  steps.push(`${CLEANUP_BAK_DB} / ${CLEANUP_STAGING_DB} 就绪`);

  const password = (process.env.CLICKHOUSE_CLEANUP_PASSWORD ?? '').trim();
  if (!password) {
    steps.push(`${CLEANUP_USER} 跳过（未注入 CLICKHOUSE_CLEANUP_PASSWORD）`);
    return steps.join('；');
  }
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(password)) {
    throw new Error('CLICKHOUSE_CLEANUP_PASSWORD 格式非法（16-64 位 [A-Za-z0-9_-]）');
  }
  const noLog = { clickhouse_settings: { log_queries: 0 } as never };
  await ch.command({ query: `CREATE USER IF NOT EXISTS ${CLEANUP_USER} IDENTIFIED BY '${password}'`, ...noLog });
  await ch.command({ query: `ALTER USER ${CLEANUP_USER} IDENTIFIED BY '${password}'`, ...noLog });
  // 生产旁路库：只读 + 只能 ALTER DELETE/UPDATE（无 INSERT/DROP/TRUNCATE）
  await ch.command({ query: `GRANT SELECT, ALTER DELETE, ALTER UPDATE ON ${DB}.* TO ${CLEANUP_USER}` });
  // 备份库：建表 + 写入（快照 INSERT ... SELECT）
  await ch.command({
    query: `GRANT SELECT, INSERT, CREATE TABLE, DROP TABLE ON ${CLEANUP_BAK_DB}.* TO ${CLEANUP_USER}`,
  });
  // 演练库：建表/写入/演练删除与掩码/清理
  await ch.command({
    query: `GRANT SELECT, INSERT, CREATE TABLE, DROP TABLE, TRUNCATE, ALTER DELETE, ALTER UPDATE ON ${CLEANUP_STAGING_DB}.* TO ${CLEANUP_USER}`,
  });
  steps.push(`${CLEANUP_USER} 已授权（仅 ${DB}* 库）`);
  return steps.join('；');
}

export async function tableExists(ch: ClickHouseClient, table: string): Promise<boolean> {
  const rs = await ch.query({
    query: `SELECT count() AS c FROM system.tables WHERE database = {db: String} AND name = {table: String}`,
    query_params: { db: DB, table },
    format: 'JSONEachRow',
  });
  const rows = await rs.json<{ c: string | number }>();
  return Number(rows[0]?.c ?? 0) > 0;
}

export async function columnExists(
  ch: ClickHouseClient,
  table: string,
  column: string,
): Promise<boolean> {
  const rs = await ch.query({
    query: `SELECT count() AS c FROM system.columns WHERE database = {db: String} AND table = {table: String} AND name = {column: String}`,
    query_params: { db: DB, table, column },
    format: 'JSONEachRow',
  });
  const rows = await rs.json<{ c: string | number }>();
  return Number(rows[0]?.c ?? 0) > 0;
}

export async function countRows(ch: ClickHouseClient, table: string): Promise<number> {
  const rs = await ch.query({
    query: `SELECT count() AS c FROM ${DB}.${table}`,
    format: 'JSONEachRow',
  });
  const rows = await rs.json<{ c: string | number }>();
  return Number(rows[0]?.c ?? 0);
}

/**
 * 对齐 `sa_user_profiles` 结构：补齐 `project_name` 与 `ORDER BY (project_name, distinct_id)`。
 *
 * 线上历史表缺列且排序键不同，而排序键无法 ALTER，因此重建切换。
 */export async function ensureUserProfileSchema(
  ch: ClickHouseClient,
): Promise<'created' | 'migrated' | 'noop'> {
  if (!(await tableExists(ch, USER_PROFILE_TABLE))) {
    await ch.command({ query: DDL_USER_PROFILES });
    console.log(`[migrate] 新建 ${USER_PROFILE_TABLE}`);
    return 'created';
  }
  if (await columnExists(ch, USER_PROFILE_TABLE, 'project_name')) {
    return 'noop';
  }

  const before = await countRows(ch, USER_PROFILE_TABLE);
  const legacy = `${USER_PROFILE_TABLE}_old_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  console.log(`[migrate] ${USER_PROFILE_TABLE} 缺 project_name（当前 ${before} 行），开始重建切换`);

  await ch.command({ query: DDL_USER_PROFILES_STAGING });
  // 幂等：上次中断可能留下半成品暂存表
  await ch.command({ query: `TRUNCATE TABLE ${DB}.${USER_PROFILE_STAGING}` });
  await ch.command({
    query: `INSERT INTO ${DB}.${USER_PROFILE_STAGING} (project_name, distinct_id, user_key, properties, updated_at)
SELECT {project: String} AS project_name, distinct_id, user_key, properties, updated_at
FROM (
    SELECT * FROM ${DB}.${USER_PROFILE_TABLE}
    ORDER BY updated_at DESC
    LIMIT 1 BY distinct_id
)`,
    query_params: { project: DEFAULT_PROJECT },
  });

  const staged = await countRows(ch, USER_PROFILE_STAGING);
  if (before > 0 && staged === 0) {
    throw new Error(`回填 0 行（原表 ${before} 行），中止切换`);
  }
  await ch.command({
    query: `RENAME TABLE ${DB}.${USER_PROFILE_TABLE} TO ${DB}.${legacy}, ${DB}.${USER_PROFILE_STAGING} TO ${DB}.${USER_PROFILE_TABLE}`,
  });

  const after = await countRows(ch, USER_PROFILE_TABLE);
  if (after === 0 && before > 0) {
    throw new Error('切换后行数为 0，请立即回滚：RENAME TABLE 新表 TO 旧表名并恢复 ' + legacy);
  }
  console.log(
    `[migrate] ${USER_PROFILE_TABLE} 迁移完成：${before} → ${after} 行；旧表保留为 ${legacy}（回滚即反向 RENAME）`,
  );
  return 'migrated';
}

const SA_EVENTS_TABLE = 'sa_events';

/**
 * Debug 查询用的跳数索引（phase: clklog-analytics-sa-events-skip-index-v1）。
 * 谓词都是等值 + 高基数列，bloom filter 正合适（minmax 对高基数列无效）。
 */
const SA_EVENTS_SKIP_INDEXES: { name: string; column: string }[] = [
  { name: 'idx_debug_distinct_id', column: 'distinct_id' },
  { name: 'idx_debug_user_key', column: 'user_key' },
];
const BLOOM_FALSE_POSITIVE = 0.01;
const BLOOM_GRANULARITY = 4;

async function skipIndexNames(ch: ClickHouseClient, table: string): Promise<Set<string>> {
  const rs = await ch.query({
    query: `SELECT name FROM system.data_skipping_indices WHERE database = {db: String} AND table = {table: String}`,
    query_params: { db: DB, table },
    format: 'JSONEachRow',
  });
  const rows = await rs.json<{ name: string }[]>();
  return new Set(rows.map((row) => row.name));
}

/**
 * `sa_events` 跳数索引：让「无 event 的 distinct_id / user_key 等值过滤」能跳过 granule。
 *
 * 背景（生产实测）：排序键 `(event, stat_date, distinct_id, crc)` 且此前无任何跳数索引，
 * 设备维度 7 天窗读 9800 万行（6–48s）、账号维度读整表 18 亿行（68.6s，撞穿前端 60s 超时）。
 *
 * 幂等：已存在即 no-op；新增后**异步**触发物化（mutation 立即返回，发版不等几十分钟），
 * 新写入的 part 自带索引、历史 part 逐步物化（进度看 `system.mutations` / `system.parts`）。
 * 回滚：`ALTER TABLE ... DROP INDEX idx_debug_distinct_id`（两枚同理）。
 */
export async function ensureSaEventsSkipIndexes(ch: ClickHouseClient): Promise<string> {
  if (!(await tableExists(ch, SA_EVENTS_TABLE))) return `${SA_EVENTS_TABLE} 不存在，跳过`;
  const existing = await skipIndexNames(ch, SA_EVENTS_TABLE);
  const added: string[] = [];
  for (const index of SA_EVENTS_SKIP_INDEXES) {
    if (existing.has(index.name)) continue;
    await ch.command({
      query: `ALTER TABLE ${DB}.${SA_EVENTS_TABLE} ADD INDEX IF NOT EXISTS ${index.name} ${index.column} TYPE bloom_filter(${BLOOM_FALSE_POSITIVE}) GRANULARITY ${BLOOM_GRANULARITY}`,
    });
    added.push(index.name);
  }
  if (!added.length) return `${SA_EVENTS_TABLE} 跳数索引已就绪（noop）`;
  // CH 23.2 的 MATERIALIZE INDEX 一次只接受**一个**索引名（写 `a, b` 会 SYNTAX_ERROR —— 演练实测），故逐个下发。
  // 不等待物化完成：mutation 异步跑，发版不被几十分钟的物化阻塞。
  for (const name of added) {
    await ch.command({ query: `ALTER TABLE ${DB}.${SA_EVENTS_TABLE} MATERIALIZE INDEX ${name}` });
  }
  return `${SA_EVENTS_TABLE} 新增跳数索引 ${added.join(', ')}（物化后台进行，进度看 system.mutations）`;
}

async function main(): Promise<void> {
  const ch = createWriteClient(true);
  try {
    const result = await ensureUserProfileSchema(ch);
    console.log(`[migrate] 完成：${result}`);
    const skipIndexes = await ensureSaEventsSkipIndexes(ch);
    console.log(`[migrate] 跳数索引：${skipIndexes}`);
    const cleanup = await ensureCleanupSchema(ch);
    console.log(`[migrate] 清洗基础设施：${cleanup}`);
  } finally {
    await ch.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[migrate] 失败：', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
