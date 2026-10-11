import { defineTool } from '@deepseek-ai/dsh-tools';
import analysisCases from './analysis-cases.json' with { type: 'json' };

export const inject = ['tools'];

const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_LENGTH = 100;
const MAX_DSL_LENGTH = 65_536;
const OMIT = Symbol('omit-sensitive-value');
const SENSITIVE_KEY = /(?:^|_)(?:project|project_name|distinct_id|user_key|device_id|authorization|auth_token|access_token|refresh_token|token|password|passwd|secret|api_key|apikey|cookie)(?:$|_)/i;
const SENSITIVE_IDENTIFIER = /^(?:distinct_id|user_key|device_id)$/i;

function requiredRuntimeValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`ClkLog Runtime 缺少 ${name}`);
  return value;
}

function prune(value, depth = 0, parentKey = '') {
  if (depth > 8) return '[depth limit]';
  if (typeof value === 'string') {
    const masked = value
      .replace(/\b1[3-9]\d{9}\b/g, (phone) => `${phone.slice(0, 3)}****${phone.slice(-4)}`)
      .replace(/\b([A-Z0-9._%+-])[^\s@]*@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi, '$1***@$2')
      .replace(/\b\d{17}[\dXx]\b/g, (id) => `${id.slice(0, 3)}***********${id.slice(-4)}`);
    const limit = /^(sql|sql_text)$/i.test(parentKey) ? MAX_DSL_LENGTH : MAX_STRING_LENGTH;
    return masked.length > limit
      ? `${masked.slice(0, limit)}…[truncated]`
      : masked;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => prune(item, depth + 1))
      .filter((item) => item !== OMIT);
    if (value.length > MAX_ARRAY_LENGTH) {
      items.push({ _truncated_items: value.length - MAX_ARRAY_LENGTH });
    }
    return items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')))
        .map(([key, child]) => [key, prune(child, depth + 1, key)])
        .filter(([, child]) => child !== OMIT),
    );
  }
  return value === undefined ? OMIT : value;
}

function containsSensitiveIdentifier(value) {
  if (typeof value === 'string') return SENSITIVE_IDENTIFIER.test(value.trim());
  if (Array.isArray(value)) return value.some(containsSensitiveIdentifier);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, child]) => SENSITIVE_IDENTIFIER.test(key) || containsSensitiveIdentifier(child),
    );
  }
  return false;
}

function parseDsl(dslJson) {
  if (dslJson.length > MAX_DSL_LENGTH) throw new Error('DSL 超过 64 KiB');
  let dsl;
  try {
    dsl = JSON.parse(dslJson);
  } catch {
    throw new Error('dsl_json 必须是合法 JSON');
  }
  if (!dsl || Array.isArray(dsl) || typeof dsl !== 'object') {
    throw new Error('dsl_json 必须包含 JSON 对象');
  }
  if (containsSensitiveIdentifier(dsl)) {
    throw new Error('DSL 不允许查询或分组用户身份字段');
  }
  delete dsl.project;
  delete dsl.project_name;
  return dsl;
}

async function gatewayCall(path, body) {
  const baseUrl = requiredRuntimeValue('CLKLOG_GATEWAY_BASE_URL').replace(/\/$/, '');
  const capability = requiredRuntimeValue('CLKLOG_MODEL_CAPABILITY');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60_000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${capability}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error(`ClkLog Gateway 返回无效 JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
      const message = typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`;
      throw new Error(`HTTP ${response.status}: ${message.slice(0, 300)}`);
    }
    return prune(payload);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('ClkLog Gateway 请求超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function jsonOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  };
}

function stringify(value) {
  return JSON.stringify(value);
}

export const __test = Object.freeze({ prune, parseDsl, containsSensitiveIdentifier });

export function apply(ctx) {
  const register = (definition) => ctx.tools.register(defineTool(definition));

  register({
    name: 'clklog_get_analysis_capabilities',
    description: '分析前读取现代 DSL 示例与限制，禁止枚举猜参数。示例事件、属性、日期只是占位候选，须用当前项目字典确认并替换。',
    parameters: {}, output: jsonOutput(),
    async execute() {
      return stringify({ ...await gatewayCall('/tools/query/capabilities'), examples: analysisCases });
    },
  });

  register({
    name: 'clklog_propose_analysis',
    description: '完整填充当前事件、漏斗或留存分析表单。用户确认后写入，不执行、不保存。先读取页面 revision 和能力契约。',
    parameters: {
      page: { type: 'string', required: true, description: 'event / funnel / retention，必须与当前页面相同。' },
      dsl_json: { type: 'string', required: true, description: '该分析的完整 DSL JSON，包含日期、指标/步骤/起始回访条件。' },
      expected_revision: { type: 'integer', required: true, description: '最近 clklog_page_read 返回的 revision。' },
      reason: { type: 'string', required: true, description: '业务口径、依据与填充理由。' },
    },
    output: jsonOutput(),
    async execute(args) {
      return stringify(await gatewayCall('/tools/page/propose-analysis', {
        page: args.page, dsl: parseDsl(args.dsl_json),
        expected_revision: args.expected_revision, reason: args.reason,
      }));
    },
  });

  register({
    name: 'clklog_run_retention_analysis',
    description: '执行受控留存 DSL，项目由网关绑定；区分初始范围和回访观察期，不把未成熟周期解释为流失。',
    parameters: { dsl_json: { type: 'string', required: true, description: '先读取能力工具的 retention 示例，再填入已核验事件、日期和周期。' } },
    output: jsonOutput(),
    async execute(args) {
      return stringify(await gatewayCall('/tools/query/retention', parseDsl(args.dsl_json)));
    },
  });

  register({
    name: 'clklog_page_read',
    description: '读取绑定浏览器标签页的当前分析状态、结果摘要与 revision。',
    parameters: {},
    output: jsonOutput(),
    async execute() {
      return stringify(await gatewayCall('/tools/page/read'));
    },
  });

  register({
    name: 'clklog_propose_sql',
    description: '向当前自定义 SQL 页面提出 SQL 修改。只生成 diff 提案，必须由用户确认后才写回编辑器。',
    parameters: {
      sql: { type: 'string', required: true, description: '完整的新 SQL。' },
      expected_revision: { type: 'integer', required: true, description: 'clklog_page_read 返回的 revision。' },
      reason: { type: 'string', required: true, description: '修改理由和预期影响。' },
    },
    output: jsonOutput(),
    async execute(args) {
      return stringify(await gatewayCall('/tools/page/propose-sql', {
        sql: args.sql,
        expected_revision: args.expected_revision,
        reason: args.reason,
      }));
    },
  });

  register({
    name: 'clklog_request_sql_execution',
    description: '请求浏览器执行当前 SQL。执行与编辑确认分离，仍经过项目、时间、LIMIT、超时和只读账号守卫。',
    parameters: {
      sql: { type: 'string', required: true, description: '准备执行的完整 SQL。' },
      expected_revision: { type: 'integer', required: true, description: '当前编辑器 revision。' },
      reason: { type: 'string', required: true, description: '为什么需要执行。' },
    },
    output: jsonOutput(),
    async execute(args) {
      return stringify(await gatewayCall('/tools/page/request-sql-execution', {
        sql: args.sql,
        expected_revision: args.expected_revision,
        reason: args.reason,
      }));
    },
  });

  register({
    name: 'clklog_propose_sql_chart',
    description: '把自定义 SQL 结果区的图表类型和字段绑定写入当前页。自动推荐只能给明细表时使用。先 page_read 看 result_columns 与 analysis.chart_config（当前绑定、分轴与单位）；折线/趋势最多 5 个指标，其余列放 ignored。量级差太多时用 options.metric_axis（{"列名":"right"}）把小的指标拆到右轴，单位用 options.units（合法值见 capabilities 的 sql_chart.units）。同一根轴上的指标必须同单位，不同单位的指标要用 metric_axis 拆到另一根轴，否则该轴只能有一种量纲、另一个指标会被标错。自动写入字段设置，不执行 SQL、不保存卡片。',
    parameters: {
      chart_json: {
        type: 'string',
        required: true,
        description: 'JSON：{chart_type, bindings:{x?, category?, metrics[], ignored?}, options?:{units?, metric_axis?}}。chart_type 为 table/number/line/bar/pie/funnel/trend。',
      },
      expected_revision: { type: 'integer', required: true, description: 'clklog_page_read 返回的 revision。' },
      reason: { type: 'string', required: true, description: '为何这样绑时间和指标。' },
    },
    output: jsonOutput(),
    async execute(args) {
      return stringify(await gatewayCall('/tools/page/propose-sql-chart', {
        chart: parseDsl(args.chart_json),
        expected_revision: args.expected_revision,
        reason: args.reason,
      }));
    },
  });

  register({
    name: 'clklog_propose_event_chart',
    description:
      '把事件分析结果区的图表类型与字段绑定作为提案送到当前页；用户在页面上点「应用」后才生效'
      + '（与 SQL 侧不同，事件侧不会自动写入）。'
      + '先 page_read 看 analysis.result_columns 与 analysis.chart_config：'
      + '列名是结果列 key（形如 g_0 / m_0），不是列标题；'
      + 'X 轴用 bindings.x（事件侧可以是时间列或维度列），拆分系列用 bindings.series，没有 category。'
      + '分轴用 options.metric_axis（{"m_1":"right"}），单位用 options.units；同一根轴上的指标必须同单位，不同单位的要用 metric_axis 拆开。'
      + '不执行查询、不保存卡片、不接受 roles。'
      + '返回里带 delivered：true = 提案已送达页面（用户有机会看到并点「应用」），'
      + 'false = 页面没取走（页面可能没连上或已切走）。超时后据此判断是「用户没点」还是「根本没送到」，'
      + '不要盲目重发；true 时提醒用户在上方点「应用」即可。',
    parameters: {
      chart_json: {
        type: 'string',
        required: true,
        description:
          'JSON：{chart_type, bindings:{x?, series?, metrics[], ignored?}, options?:{units?, metric_axis?}}。'
          + 'chart_type 为 table/number/line/bar/pie/trend/stack/cumulative/distribution。',
      },
      expected_revision: { type: 'integer', required: true, description: 'clklog_page_read 返回的 revision。' },
      reason: { type: 'string', required: true, description: '为何这样绑定与分轴；会显示给用户，用户据此决定是否应用。' },
    },
    output: jsonOutput(),
    async execute(args) {
      return stringify(await gatewayCall('/tools/page/propose-event-chart', {
        chart: parseDsl(args.chart_json),
        expected_revision: args.expected_revision,
        reason: args.reason,
      }));
    },
  });

  register({
    name: 'clklog_get_schema',
    description: '检索当前项目字典，按集合分页。属性必须先确认属于目标事件；可传 event_key 读取该事件属性。遍历 next_page，不能将被裁剪数据当全量。',
    parameters: {
      keyword: { type: 'string', description: '事件/属性名称关键词。' },
      page: { type: 'integer', description: '页码，从 1 开始，每页最多 50 项。' },
      event_key: { type: 'string', description: '目标事件真实 event_key；返回其属性，仍受权限限制。' },
    },
    output: jsonOutput(),
    async execute(args) {
      const query = new URLSearchParams();
      if (args.keyword) query.set('keyword', args.keyword);
      if (args.page !== undefined) query.set('page', String(args.page));
      if (args.event_key) query.set('event_key', args.event_key);
      return stringify(await gatewayCall(`/tools/report/schema?${query}`));
    },
  });

  register({
    name: 'clklog_run_event_analysis',
    description: '使用受约束 DSL 执行当前项目的事件分析；项目由网关强制绑定。',
    parameters: {
      dsl_json: { type: 'string', required: true, description: '先读能力契约。metrics 每项包含 id/event/kind:"event"/analysis；max/sum 写 analysis，不写 type；带 time_range。' },
    },
    output: jsonOutput(),
    async execute(args) {
      return stringify(await gatewayCall('/tools/query/event', parseDsl(args.dsl_json)));
    },
  });

  register({
    name: 'clklog_run_funnel_analysis',
    description: '使用受约束 DSL 执行当前项目的漏斗分析；项目由网关强制绑定。',
    parameters: {
      dsl_json: { type: 'string', required: true, description: '漏斗分析 DSL JSON。' },
    },
    output: jsonOutput(),
    async execute(args) {
      return stringify(await gatewayCall('/tools/query/funnel', parseDsl(args.dsl_json)));
    },
  });

  register({
    name: 'clklog_list_dashboards',
    description: '列出当前用户在绑定项目下的看板（含卡片数）。',
    parameters: {},
    output: jsonOutput(),
    async execute() {
      return stringify(await gatewayCall('/tools/catalog/dashboards'));
    },
  });

  register({
    name: 'clklog_list_cards',
    description: '列出当前用户在绑定项目下的分析卡片。可按 type 过滤：event / funnel / retention / sql。',
    parameters: {
      type: { type: 'string', description: '可选卡片类型过滤。' },
    },
    output: jsonOutput(),
    async execute(args) {
      const type = typeof args.type === 'string' ? args.type.trim() : '';
      const qs = type ? `?type=${encodeURIComponent(type)}` : '';
      return stringify(await gatewayCall(`/tools/catalog/cards${qs}`));
    },
  });

  register({
    name: 'clklog_get_card',
    description: '读取一张分析卡片的元数据（含 SQL 卡片的 sql_text），不含未执行结果。',
    parameters: {
      card_id: { type: 'string', required: true, description: '卡片 ID。' },
    },
    output: jsonOutput(),
    async execute(args) {
      return stringify(await gatewayCall(`/tools/catalog/cards/${encodeURIComponent(args.card_id)}`));
    },
  });

  register({
    name: 'clklog_execute_sql_card',
    description: '静默执行 type=sql 的卡片。不经浏览器确认，仍走项目、时间、LIMIT、超时和只读守卫。',
    parameters: {
      card_id: { type: 'string', required: true, description: 'SQL 卡片 ID。' },
      time_range: {
        type: 'object',
        additionalProperties: false,
        description: '可选 {start,end}，缺省用卡片内或近 7 天。',
        properties: {
          start: { type: 'string', description: '开始日期 YYYY-MM-DD' },
          end: { type: 'string', description: '结束日期 YYYY-MM-DD' },
        },
      },
      limit: { type: 'integer', description: '可选行数上限。' },
    },
    output: jsonOutput(),
    async execute(args) {
      const body = { card_id: args.card_id };
      if (args.time_range && typeof args.time_range === 'object') body.time_range = args.time_range;
      if (typeof args.limit === 'number') body.limit = args.limit;
      return stringify(await gatewayCall('/tools/catalog/cards/execute', body));
    },
  });

  register({
    name: 'clklog_load_sql_card',
    description: '把已有 SQL 卡片加载到当前自定义 SQL 页编辑器（不执行）。用户可对着看；批量调试请用 clklog_execute_sql_card。',
    parameters: {
      card_id: { type: 'string', required: true, description: 'SQL 卡片 ID。' },
      expected_revision: { type: 'integer', description: '可选；缺省用当前页面 revision。' },
      reason: { type: 'string', description: '切卡原因。' },
    },
    output: jsonOutput(),
    async execute(args) {
      const body = { card_id: args.card_id };
      if (typeof args.expected_revision === 'number') body.expected_revision = args.expected_revision;
      if (typeof args.reason === 'string') body.reason = args.reason;
      return stringify(await gatewayCall('/tools/page/load-sql-card', body));
    },
  });
}
