import test from 'node:test';
import assert from 'node:assert/strict';
import { __test, apply } from './index.mjs';
import { createServer } from 'node:http';
import cases from './analysis-cases.json' with { type: 'json' };

test('tool output pruning removes credentials and direct user identifiers', () => {
  const value = __test.prune({
    event: 'purchase',
    authorization: 'Bearer secret',
    nested: { api_key: 'secret', count: 12 },
    phone: '13812345678',
  });
  assert.deepEqual(value, {
    event: 'purchase',
    nested: { count: 12 },
    phone: '138****5678',
  });
});

test('analysis DSL cannot select or group identity fields', () => {
  assert.throws(
    () => __test.parseDsl(JSON.stringify({ groups: [{ prop: 'distinct_id' }] })),
    /身份字段/,
  );
});

test('project fields are stripped because the gateway binds the project', () => {
  assert.deepEqual(
    __test.parseDsl(JSON.stringify({ project: 'other', event: 'purchase' })),
    { event: 'purchase' },
  );
});

test('all query tools and proposals use the real gateway transport, with bounded failure behavior', async () => {
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    calls.push({ url: request.url, body: body ? JSON.parse(body) : undefined });
    response.writeHead(request.url.includes('unauthorized') ? 401 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, message: 'fixture', sql_text: 'SELECT ' + 'x'.repeat(4000) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = [process.env.CLKLOG_GATEWAY_BASE_URL, process.env.CLKLOG_MODEL_CAPABILITY];
  process.env.CLKLOG_GATEWAY_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.CLKLOG_MODEL_CAPABILITY = 'synthetic-test-only';
  try {
    const registered = new Map();
    apply({ tools: { register: (tool) => registered.set(tool.name, tool) } });
    for (const [page, dsl] of Object.entries(cases)) {
      await registered.get(`clklog_run_${page}_analysis`).execute({ dsl_json: JSON.stringify({ ...dsl, project: 'must-strip' }) });
      assert.equal(calls.at(-1).url, `/tools/query/${page}`);
      assert.equal(calls.at(-1).body.project, undefined);
      await registered.get('clklog_propose_analysis').execute({ page, dsl_json: JSON.stringify(dsl), expected_revision: 7, reason: 'fixture' });
      assert.equal(calls.at(-1).body.expected_revision, 7);
    }
    await registered.get('clklog_get_schema').execute({ keyword: 'currency', page: 3, event_key: 'pay' });
    assert.match(calls.at(-1).url, /page=3/);
    await registered.get('clklog_propose_sql_chart').execute({
      chart_json: JSON.stringify({ chart_type: 'line', bindings: { x: 'd', metrics: ['收入金额'] } }),
      expected_revision: 9,
      reason: '收入趋势',
    });
    assert.equal(calls.at(-1).url, '/tools/page/propose-sql-chart');
    assert.equal(calls.at(-1).body.expected_revision, 9);
    assert.equal(calls.at(-1).body.chart.chart_type, 'line');
    await registered.get('clklog_propose_event_chart').execute({
      chart_json: JSON.stringify({
        chart_type: 'line',
        bindings: { x: 'g_0', metrics: ['m_0', 'm_1'] },
        options: { metric_axis: { m_1: 'right' } },
      }),
      expected_revision: 9,
      reason: '付费率被 DAU 压平，建议拆到右轴',
    });
    assert.equal(calls.at(-1).url, '/tools/page/propose-event-chart');
    assert.equal(calls.at(-1).body.chart.options.metric_axis.m_1, 'right');
    assert.equal(calls.at(-1).body.reason, '付费率被 DAU 压平，建议拆到右轴');
    const card = JSON.parse(await registered.get('clklog_get_card').execute({ card_id: 'fixture' }));
    assert.equal(card.sql_text.length, 4007);
    const before = calls.length;
    await assert.rejects(registered.get('clklog_get_card').execute({ card_id: 'unauthorized' }), /HTTP 401/);
    assert.equal(calls.length, before + 1, 'a failed operation must not be replayed');
  } finally {
    for (const [index, key] of ['CLKLOG_GATEWAY_BASE_URL', 'CLKLOG_MODEL_CAPABILITY'].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
    await new Promise((resolve) => server.close(resolve));
  }
});
