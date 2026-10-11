import { createClient, DataFormat } from '@clickhouse/client';
import { appConfig } from '../config/configuration';

/**
 * 初始化 ClickHouse 分析库和表
 * 运行方式：APP_CONFIG_PATH=./config_dev.yaml npx ts-node src/scripts/init-clickhouse.ts
 */

const DDL = `
CREATE DATABASE IF NOT EXISTS clklog_sa;

CREATE TABLE IF NOT EXISTS clklog_sa.sa_events
(
    project_name      LowCardinality(String),
    event             LowCardinality(String),
    log_time          DateTime64(3),
    stat_date         Date,
    stat_hour         UInt8 MATERIALIZED toHour(log_time),
    distinct_id       String,
    user_key          String DEFAULT '',
    device_id         String DEFAULT '',
    url_path          String DEFAULT '',
    utm_source        LowCardinality(String) DEFAULT '',
    utm_medium        LowCardinality(String) DEFAULT '',
    utm_campaign      LowCardinality(String) DEFAULT '',
    country           LowCardinality(String) DEFAULT '',
    province          LowCardinality(String) DEFAULT '',
    city              LowCardinality(String) DEFAULT '',
    os                LowCardinality(String) DEFAULT '',
    browser           LowCardinality(String) DEFAULT '',
    model             String DEFAULT '',
    app_version       LowCardinality(String) DEFAULT '',
    lib               LowCardinality(String) DEFAULT '',
    is_first_day      UInt8 DEFAULT 0,
    event_session_id  String DEFAULT '',
    properties        String CODEC(ZSTD(3)),
    crc               String,
    ingest_time       DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingest_time)
PARTITION BY toYYYYMM(stat_date)
ORDER BY (event, stat_date, distinct_id, crc)
TTL stat_date + INTERVAL 18 MONTH;

CREATE TABLE IF NOT EXISTS clklog_sa.sa_user_profiles
(
    project_name LowCardinality(String) DEFAULT 'clklogapp',
    distinct_id  String,
    user_key     String DEFAULT '',
    properties   String CODEC(ZSTD(3)),
    updated_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (project_name, distinct_id);

CREATE TABLE IF NOT EXISTS clklog_sa.sa_cohort_members
(
    project_name LowCardinality(String),
    cohort_id    String,
    batch_id     String,
    uid          String,
    computed_at  DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY project_name
ORDER BY (cohort_id, batch_id, uid)
TTL computed_at + INTERVAL 180 DAY DELETE;

CREATE TABLE IF NOT EXISTS clklog_sa.sa_tag_members
(
    project_name LowCardinality(String),
    tag_id       String,
    batch_id     String,
    uid          String,
    tag_value    String,
    computed_at  DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY project_name
ORDER BY (tag_id, batch_id, uid)
TTL computed_at + INTERVAL 180 DAY DELETE;
`

async function createDatabase() {
  // 创建数据库时不指定 database，避免 UNKNOWN_DATABASE
  const client = createClient({
    host: `${appConfig.clickhouse.write.protocol}://${appConfig.clickhouse.write.host}:${appConfig.clickhouse.write.port}`,
    username: appConfig.clickhouse.write.username,
    password: appConfig.clickhouse.write.password,
  });

  console.log('创建数据库 clklog_sa...');
  await client.command({ query: 'CREATE DATABASE IF NOT EXISTS clklog_sa;' });
  await client.close();
}

async function createTables() {
  const client = createClient({
    host: `${appConfig.clickhouse.write.protocol}://${appConfig.clickhouse.write.host}:${appConfig.clickhouse.write.port}`,
    username: appConfig.clickhouse.write.username,
    password: appConfig.clickhouse.write.password,
    database: appConfig.clickhouse.write.database,
  });

  for (const statement of DDL.split(';').map((s) => s.trim()).filter((s) => s && !s.toLowerCase().includes('create database'))) {
    console.log(`执行: ${statement.substring(0, 60)}...`);
    await client.command({ query: statement + ';' });
  }

  await client.close();
}

async function main() {
  await createDatabase();
  await createTables();
  console.log('ClickHouse 初始化完成');
}

main().catch((err) => {
  console.error('初始化失败', err);
  process.exit(1);
});
