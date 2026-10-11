// Execute generated SQL against isolated synthetic data; never contacts a server.
// Usage: npm run build && node test/ai-workspace/run-local-cases.cjs /absolute/path/to/clickhouse
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { EventSqlGeneratorService } = require('../../dist/src/modules/query/event-sql-generator.service');
const { FunnelSqlGeneratorService } = require('../../dist/src/modules/query/funnel-sql-generator.service');
const { RetentionSqlGeneratorService } = require('../../dist/src/modules/query/retention-sql-generator.service');
const { DslValidatorService } = require('../../dist/src/modules/query/dsl-validator.service');
const cases = require('../../../analytics-harness-host/plugins/analytics-tools/analysis-cases.json');
const binary = process.argv[2];
if (!binary || !require('node:path').isAbsolute(binary)) throw new Error('Pass an absolute local ClickHouse binary path');
const project = 'workspace_fixture';
const rows = [];
function event(day, user, name, props = {}, time = '10:00:00', projectName = project) {
  rows.push([projectName, name, JSON.stringify(props), `2026-08-${String(day).padStart(2, '0')} ${time}`, `2026-08-${String(day).padStart(2, '0')}`, user, user, day === 1 ? 1 : 0]);
}
const sourceType = cases.event.filters.items[0].value;
event(1, 'A', cases.event.event, { amount: 10, source_type: sourceType });
event(1, 'A', cases.event.event, { amount: 20, source_type: sourceType });
event(1, 'B', cases.event.event, { amount: 5, source_type: sourceType });
event(1, 'A', cases.event.event, { amount: 99, source_type: 'other' });
event(1, 'X', cases.event.event, { amount: 9999, source_type: sourceType }, '10:00:00', 'other_project');
const [buy, draw, show] = cases.funnel.steps.map((s) => s.event);
for (const user of ['A', 'B', 'C', 'D']) event(1, user, buy);
event(1, 'A', draw, {}, '10:01:00'); event(1, 'A', show, {}, '10:02:00');
event(1, 'C', draw, {}, '09:00:00');
event(1, 'D', draw, {}, '10:01:00'); event(3, 'D', show);
const enter = cases.retention.start_event.event;
const moduleName = cases.retention.start_event.filters.items[0].value;
for (const user of ['A', 'B', 'C', 'D']) event(1, user, enter, { module_name: moduleName });
for (const [day, users] of [[2, ['A', 'B']], [4, ['A']], [8, ['A', 'C']]]) {
  for (const user of users) event(day, user, enter, { module_name: moduleName });
}
event(2, 'D', enter, { module_name: 'other' });
const literal = (value) => typeof value === 'number' ? String(value) : `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const setup = `CREATE DATABASE clklog_sa;
CREATE TABLE clklog_sa.sa_events (project_name String, event String, properties String, log_time DateTime, stat_date Date, distinct_id String, user_key String, is_first_day UInt8) ENGINE=Memory;
INSERT INTO clklog_sa.sa_events VALUES ${rows.map((row) => `(${row.map(literal).join(',')})`).join(',')};`;
const attributes = {
  inferDataType: async (prop) => prop === 'amount' ? 'number' : 'string',
  resolve: async (prop) => `JSONExtract${prop === 'amount' ? 'Float' : 'String'}(properties, '${prop}')`,
};
const args = [attributes, { findDefinition: async () => null }, {}, {}, { resolve: async () => ({ kind: 'preset' }) }];
function execute(sql, params = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'clklog-cases-'));
  try {
    const output = execFileSync(resolve(binary), ['local', '--path', directory, '--multiquery',
      '--max_execution_time=30', '--max_memory_usage=1073741824', '--query', `${setup}\n${sql} FORMAT JSONEachRow`,
      ...Object.entries(params).map(([key, value]) => `--param_${key}=${Array.isArray(value) ? `[${value.map(literal).join(',')}]` : value}`)],
    { encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024 });
    return output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
(async () => {
  const validator = new DslValidatorService();
  const eventQuery = { ...structuredClone(cases.event), project };
  validator.validateEventQuery(eventQuery);
  const e = await new EventSqlGeneratorService(...args).generate(eventQuery);
  const er = execute(e.sql, e.params);
  assert.equal(er.length, 1);
  assert.deepEqual([Number(er[0].m_0), Number(er[0].m_1), Number(er[0].m_2)], [3, 2, 35]);
  const f = await new FunnelSqlGeneratorService(...args).generate({ ...cases.funnel, project });
  const fr = execute(f.sql, f.params);
  const counts = [1, 2, 3].map((step) => fr.reduce((sum, row) => sum + (Number(row.level) >= step ? Number(row.users) : 0), 0));
  assert.deepEqual(counts, [4, 2, 1]);
  const r = await new RetentionSqlGeneratorService(...args).generate({ ...cases.retention, project });
  const rr = execute(r.sql, r.params);
  assert.equal(rr.length, 1);
  assert.deepEqual([Number(rr[0].cohort_size), Number(rr[0].n_1), Number(rr[0].n_3), Number(rr[0].n_7)], [4, 2, 1, 2]);
  assert.deepEqual([rr[0].n_1_rate, rr[0].n_3_rate, rr[0].n_7_rate], [0.5, 0.25, 0.5]);
  const sr = execute(`SELECT count() AS times, uniqExactIf(if(user_key != '', user_key, distinct_id), if(user_key != '', user_key, distinct_id) != '') AS users,
sum(JSONExtractFloat(properties, 'amount')) AS amount FROM clklog_sa.sa_events
WHERE project_name = {project:String} AND stat_date BETWEEN {start:String} AND {end:String}
AND event = {event:String} AND JSONExtractString(properties, 'source_type') = {source:String} LIMIT 100`,
  { project, start: '2026-08-01', end: '2026-08-07', event: cases.event.event, source: sourceType });
  assert.deepEqual([Number(sr[0].times), Number(sr[0].users), Number(sr[0].amount)], [3, 2, 35]);
  console.log(JSON.stringify({ mode: 'isolated synthetic ClickHouse, not production', event: er, funnel_steps: counts, retention: rr, sql: sr }, null, 2));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
