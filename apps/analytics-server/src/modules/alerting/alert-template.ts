/**
 * 告警通知模板引擎（phase: clklog-analytics-alerting-v4）。
 *
 * 实现 Go template 的**子集**：`{{.变量}}`、`{{if 表达式}}…{{else}}…{{end}}`、
 * 空白裁剪 `{{-` / `-}}`，条件函数 eq/ne/or/and/not/gt/ge/lt/le/contains。
 * 明确不支持 range/with/define/管道/变量赋值——超集写法在保存时报错，不做猜测渲染。
 *
 * 未定义变量渲染为空串（不是报错，也不是 Go 的 `<no value>`），保证模板改动不会阻断告警投递。
 */
import { serverT } from '../../i18n/messages';

export type AlertKind = 'fire' | 'resolve';
/**
 * 模板按**通道组**维护（phase: clklog-analytics-alert-channels-v1）：
 * 十几个通道各自一份模板既无必要也会组合爆炸，分三组即可覆盖：
 * chat = 群机器人 / IM / 通用 Webhook / Telegram / WhatsApp；email、sms 各自一组。
 */
export type AlertChannel = 'chat' | 'email' | 'sms';

export const ALERT_KINDS: AlertKind[] = ['fire', 'resolve'];
export const ALERT_CHANNELS: AlertChannel[] = ['chat', 'email', 'sms'];

export const KIND_LABEL: Record<AlertKind, string> = { fire: '告警触发', resolve: '告警恢复' };
/** 事件类型名的前端资源键（前端优先用 key，label 只作兜底） */
export const KIND_LABEL_KEY: Record<AlertKind, string> = {
  fire: 'alerting:kind.fire',
  resolve: 'alerting:kind.resolve',
};
export const CHANNEL_LABEL: Record<AlertChannel, string> = {
  chat: '群聊 / Webhook',
  email: '邮件',
  sms: '短信',
};

/** 模板可用变量（编辑器占位符清单；sample 仅用于预览） */
export interface TemplateVar {
  name: string;
  /** 中文名（兼容兜底）；前端优先用 label_key */
  label: string;
  label_key: string;
  /** 中文示例值（兼容兜底）；非中文语言用 sample_key 取服务端文案 */
  sample: string;
  /**
   * 示例值的服务端文案键（`messages/*.json` 里的点路径，不带命名空间）。
   * 中文路径不读它（保持 sample 原值逐字不变）；缺失时也回退 sample。
   */
  sample_key?: string;
}

export const TEMPLATE_VARS: TemplateVar[] = [
  {
    name: 'rule_name',
    label: '规则名',
    label_key: 'alerting:templateVar.ruleName',
    sample: '今日上报量过低',
    sample_key: 'alert.varSample.ruleName',
  },
  {
    name: 'rule_code',
    label: '规则码',
    label_key: 'alerting:templateVar.ruleCode',
    sample: 'metric_ab12cd34',
    sample_key: 'alert.varSample.ruleCode',
  },
  {
    name: 'level',
    label: '级别（英文）',
    label_key: 'alerting:templateVar.level',
    sample: 'critical',
    sample_key: 'alert.varSample.level',
  },
  {
    name: 'level_fmt',
    label: '级别（中文）',
    label_key: 'alerting:templateVar.levelFmt',
    sample: '紧急',
    sample_key: 'alert.varSample.levelFmt',
  },
  {
    name: 'status',
    label: '状态（中文）',
    label_key: 'alerting:templateVar.status',
    sample: '触发',
    sample_key: 'alert.varSample.status',
  },
  {
    name: 'status_code',
    label: '状态码（fire/repeat/resolve）',
    label_key: 'alerting:templateVar.statusCode',
    sample: 'fire',
    sample_key: 'alert.varSample.statusCode',
  },
  {
    name: 'value',
    label: '当前值（带单位）',
    label_key: 'alerting:templateVar.value',
    sample: '1,204次',
    sample_key: 'alert.varSample.value',
  },
  {
    name: 'value_raw',
    label: '当前值（原始数字）',
    label_key: 'alerting:templateVar.valueRaw',
    sample: '1204',
    sample_key: 'alert.varSample.valueRaw',
  },
  {
    name: 'unit',
    label: '单位',
    label_key: 'alerting:templateVar.unit',
    sample: '次',
    sample_key: 'alert.varSample.unit',
  },
  {
    name: 'comparator',
    label: '比较符（英文）',
    label_key: 'alerting:templateVar.comparator',
    sample: 'gt',
    sample_key: 'alert.varSample.comparator',
  },
  {
    name: 'comparator_fmt',
    label: '比较符（中文）',
    label_key: 'alerting:templateVar.comparatorFmt',
    sample: '大于',
    sample_key: 'alert.varSample.comparatorFmt',
  },
  {
    name: 'threshold',
    label: '阈值（带单位）',
    label_key: 'alerting:templateVar.threshold',
    sample: '1,000次',
    sample_key: 'alert.varSample.threshold',
  },
  {
    name: 'metric_name',
    label: '指标名',
    label_key: 'alerting:templateVar.metricName',
    sample: '今日上报次数',
    sample_key: 'alert.varSample.metricName',
  },
  {
    name: 'metric_kind',
    label: '指标类型',
    label_key: 'alerting:templateVar.metricKind',
    sample: '事件指标',
    sample_key: 'alert.varSample.metricKind',
  },
  {
    name: 'window_days',
    label: '窗口天数',
    label_key: 'alerting:templateVar.windowDays',
    sample: '1',
    sample_key: 'alert.varSample.windowDays',
  },
  {
    name: 'window_fmt',
    label: '窗口（中文）',
    label_key: 'alerting:templateVar.windowFmt',
    sample: '今天',
    sample_key: 'alert.varSample.windowFmt',
  },
  {
    name: 'project',
    label: '项目名',
    label_key: 'alerting:templateVar.project',
    sample: 'clklogapp',
    sample_key: 'alert.varSample.project',
  },
  {
    name: 'time',
    label: '触发/恢复时间',
    label_key: 'alerting:templateVar.time',
    sample: '2026-09-15 21:03:11',
    sample_key: 'alert.varSample.time',
  },
  {
    name: 'detect_interval',
    label: '检测周期',
    label_key: 'alerting:templateVar.detectInterval',
    sample: '60s',
    sample_key: 'alert.varSample.detectInterval',
  },
  {
    name: 'contact_name',
    label: '联系人',
    label_key: 'alerting:templateVar.contactName',
    sample: '运维群',
    sample_key: 'alert.varSample.contactName',
  },
];

export type TemplateContext = Record<string, string | number | boolean | null | undefined>;

export interface RenderedTemplate {
  subject: string;
  body: string;
}

export class TemplateError extends Error {}

/* ------------------------------- 解析（AST） ------------------------------- */

type Expr =
  | { type: 'var'; name: string }
  | { type: 'lit'; value: string }
  | { type: 'num'; value: number }
  | { type: 'call'; fn: string; args: Expr[] };

type Node =
  | { type: 'text'; value: string }
  | { type: 'var'; name: string }
  | { type: 'if'; cond: Expr; then: Node[]; otherwise: Node[] };

const FUNCTIONS = new Set(['eq', 'ne', 'or', 'and', 'not', 'gt', 'ge', 'lt', 'le', 'contains']);
/** 各函数最少参数个数（Go 模板的 arity） */
const ARITY: Record<string, number> = { eq: 2, ne: 2, gt: 2, ge: 2, lt: 2, le: 2, contains: 2, not: 1, or: 1, and: 1 };
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 递归下降解析条件表达式。
 * 参数按 Go 模板习惯以**空格**分隔（`or (eq .a "x") (eq .b "y")`），逗号可选；
 * 函数调用自行吃掉右括号，括号分组再校验一次，避免两处都消费同一个 `)`。
 */
function parseExpr(source: string): Expr {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseAtom(): Expr {
    const token = next();
    if (token === undefined) throw new TemplateError('条件表达式不完整');
    if (token === '(') {
      const inner = parseAtom();
      if (next() !== ')') throw new TemplateError('条件表达式缺少右括号');
      return inner;
    }
    if (token.startsWith('"')) {
      if (token.length < 2 || !token.endsWith('"')) throw new TemplateError('字符串字面量未闭合');
      return { type: 'lit', value: token.slice(1, -1) };
    }
    if (token.startsWith('.')) {
      const name = token.slice(1);
      if (!IDENT_RE.test(name)) {
        throw new TemplateError(
          `不支持的动作: {{${token}}}（变量只支持 {{.名称}}，不支持管道 / 函数调用 / 下标）`,
        );
      }
      return { type: 'var', name };
    }
    if (/^-?\d+(\.\d+)?$/.test(token)) return { type: 'num', value: Number(token) };
    if (FUNCTIONS.has(token)) {
      // Go 模板的函数调用**不写括号**：`eq .a "b"`；括号只用于分组 `(eq .a "b")`。
      // 参数按空白分隔（逗号可选），遇到当前分组的 `)` 或表达式结束即停止。
      const args: Expr[] = [];
      while (peek() !== undefined && peek() !== ')') {
        args.push(parseAtom());
        if (peek() === ',') next();
      }
      const minArgs = ARITY[token] ?? 1;
      if (args.length < minArgs) {
        throw new TemplateError(`函数 ${token} 至少需要 ${minArgs} 个参数，当前 ${args.length} 个`);
      }
      return { type: 'call', fn: token, args };
    }
    throw new TemplateError(`无法识别的表达式片段: ${token}`);
  }

  const expr = parseAtom();
  if (pos !== tokens.length) {
    throw new TemplateError(`条件表达式存在多余内容: ${tokens.slice(pos).join(' ')}`);
  }
  return expr;
}

/** 词法：括号、逗号、函数名、变量、带引号字符串、数字 */
function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',') {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += 1;
      tokens.push(source.slice(i, Math.min(j + 1, source.length)));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < source.length && !' \t\n(),"'.includes(source[j])) j += 1;
    tokens.push(source.slice(i, j));
    i = j;
  }
  return tokens;
}

/**
 * 文本切片进 AST。
 * 空白裁剪方向遵循 Go：`{{-` 裁掉**前文**的尾部空白，`-}}` 裁掉**后文**的首部空白；
 * 因此 `-}}` 只是置一个标记，由下一个文本片段消费。
 */
function parseNodes(text: string, stack: Node[][]): void {
  let i = 0;
  let pending = '';
  let trimLeading = false;
  const current = () => stack[stack.length - 1];
  const flush = (chunk: string) => {
    let value = chunk;
    if (trimLeading) {
      value = value.replace(/^[ \t]*\n?[ \t]*/, '');
      trimLeading = false;
    }
    if (value) current().push({ type: 'text', value });
  };

  while (i < text.length) {
    const open = text.indexOf('{{', i);
    if (open === -1) {
      flush(pending + text.slice(i));
      pending = '';
      break;
    }
    let chunk = pending + text.slice(i, open);
    const close = text.indexOf('}}', open);
    if (close === -1) throw new TemplateError('存在未闭合的 {{ 动作');
    let action = text.slice(open + 2, close);
    const trimBefore = action.startsWith('-');
    const trimAfter = action.endsWith('-');
    if (trimBefore) action = action.slice(1);
    if (trimAfter) action = action.slice(0, -1);
    action = action.trim();
    if (trimBefore) chunk = chunk.replace(/[ \t]*\n?[ \t]*$/, '');
    flush(chunk);
    pending = '';

    if (action.startsWith('if ') || action === 'if') {
      const condSource = action.slice(2).trim();
      if (!condSource) throw new TemplateError('{{if}} 缺少条件表达式');
      const node: Node = { type: 'if', cond: parseExpr(condSource), then: [], otherwise: [] };
      current().push(node);
      stack.push(node.then);
    } else if (action === 'else') {
      if (stack.length < 2) throw new TemplateError('{{else}} 没有对应的 {{if}}');
      stack.pop();
      const siblings = stack[stack.length - 1];
      const node = siblings[siblings.length - 1];
      if (node?.type !== 'if') throw new TemplateError('{{else}} 没有对应的 {{if}}');
      stack.push(node.otherwise);
    } else if (action === 'end') {
      if (stack.length < 2) throw new TemplateError('{{end}} 没有对应的 {{if}}');
      stack.pop();
    } else if (action.startsWith('.')) {
      const name = action.slice(1);
      if (!IDENT_RE.test(name)) {
        throw new TemplateError(
          `不支持的动作: {{${action}}}（变量只支持 {{.名称}}，不支持管道 / 函数调用）`,
        );
      }
      current().push({ type: 'var', name });
    } else {
      throw new TemplateError(`不支持的动作: {{${action}}}（仅支持 变量 / if / else / end）`);
    }
    i = close + 2;
    if (trimAfter) trimLeading = true;
  }
  if (stack.length !== 1) throw new TemplateError('存在未闭合的 {{if}}（缺少 {{end}}）');
}

function parse(text: string): Node[] {
  const root: Node[] = [];
  parseNodes(text, [root]);
  return root;
}

/* ------------------------------- 求值（渲染） ------------------------------ */

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function truthy(value: unknown): boolean {
  const str = text(value);
  return str !== '' && str !== 'false' && str !== '0';
}

function evaluate(expr: Expr, ctx: TemplateContext): unknown {
  switch (expr.type) {
    case 'var':
      return ctx[expr.name];
    case 'lit':
      return expr.value;
    case 'num':
      return expr.value;
    case 'call': {
      const args = expr.args.map((arg) => evaluate(arg, ctx));
      const a = args[0];
      const b = args[1];
      switch (expr.fn) {
        case 'eq':
          return text(a) === text(b);
        case 'ne':
          return text(a) !== text(b);
        case 'or':
          return args.some(truthy);
        case 'and':
          return args.length > 0 && args.every(truthy);
        case 'not':
          return !truthy(a);
        case 'gt':
          return Number(text(a)) > Number(text(b));
        case 'ge':
          return Number(text(a)) >= Number(text(b));
        case 'lt':
          return Number(text(a)) < Number(text(b));
        case 'le':
          return Number(text(a)) <= Number(text(b));
        case 'contains':
          return text(a).includes(text(b));
        default:
          throw new TemplateError(`不支持的函数: ${expr.fn}`);
      }
    }
  }
}

function renderNodes(nodes: Node[], ctx: TemplateContext): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') out += node.value;
    else if (node.type === 'var') out += text(ctx[node.name]);
    else out += renderNodes(truthy(evaluate(node.cond, ctx)) ? node.then : node.otherwise, ctx);
  }
  return out;
}

/** 渲染模板；语法错误抛 TemplateError（保存前应先 validateTemplate） */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  if (!template) return '';
  return renderNodes(parse(template), ctx);
}

/** 校验模板语法；返回错误信息（null 表示合法） */
export function validateTemplate(template: string): string | null {
  if (!template || !template.trim()) return '模板内容不能为空';
  try {
    parse(template);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/* ------------------------------ 默认模板（预填充） -------------------------- */

export interface TemplateContent {
  subject: string;
  body: string;
}

const FIRE_BODY = [
  '🚨【{{.level_fmt}}】{{.status}} {{.rule_name}}',
  '当前值：{{.value}}（条件：{{.comparator_fmt}} {{.threshold}}）',
  '指标：{{.metric_name}}　窗口：{{.window_fmt}}',
  '项目：{{.project}}　时间：{{.time}}　检测周期：{{.detect_interval}}',
].join('\n');

const RESOLVE_BODY = [
  '✅【恢复】{{.rule_name}}',
  '当前值：{{.value}}（条件：{{.comparator_fmt}} {{.threshold}}）',
  '指标：{{.metric_name}}　窗口：{{.window_fmt}}',
  '项目：{{.project}}　恢复时间：{{.time}}',
].join('\n');

// 注意：{{.value}} / {{.threshold}} 已含单位（渲染时由 formatMetricValue 拼好），
// 这里不能再追加 {{.unit}}，否则会出现「1,204次次」（2026-09-15 界面预览实测发现）。
const SMS_BODY =
  '【{{.level_fmt}}】{{.status}} {{.rule_name}} 当前{{.value}} 条件{{.comparator_fmt}}{{.threshold}}';
const SMS_RESOLVE_BODY = '【恢复】{{.rule_name}} 当前{{.value}}';

const FIRE_SUBJECT = '🚨【{{.level_fmt}}】{{.rule_name}}';
const RESOLVE_SUBJECT = '✅【恢复】{{.rule_name}}';

/* ---- 英文默认模板（i18n v1）：占位符与中文版一一对应，只有固定文案不同 ---- */
const FIRE_BODY_EN = [
  '🚨 [{{.level_fmt}}] {{.status}} {{.rule_name}}',
  'Current value: {{.value}} (condition: {{.comparator_fmt}} {{.threshold}})',
  'Metric: {{.metric_name}}  Window: {{.window_fmt}}',
  'Project: {{.project}}  Time: {{.time}}  Check interval: {{.detect_interval}}',
].join('\n');

const RESOLVE_BODY_EN = [
  '✅ [Resolved] {{.rule_name}}',
  'Current value: {{.value}} (condition: {{.comparator_fmt}} {{.threshold}})',
  'Metric: {{.metric_name}}  Window: {{.window_fmt}}',
  'Project: {{.project}}  Resolved at: {{.time}}',
].join('\n');

const SMS_BODY_EN = '[{{.level_fmt}}] {{.status}} {{.rule_name}} value {{.value}} {{.comparator_fmt}}{{.threshold}}';
const SMS_RESOLVE_BODY_EN = '[Resolved] {{.rule_name}} value {{.value}}';

const FIRE_SUBJECT_EN = '🚨 [{{.level_fmt}}] {{.rule_name}}';
const RESOLVE_SUBJECT_EN = '✅ [Resolved] {{.rule_name}}';

/**
 * 默认模板：**触发与恢复各一份**（2026-09-16 用户反馈修正）。
 *
 * 早期版本让两条共用一份、内部用 `{{if eq .status_code "resolve"}}` 区分两态，
 * 结果模板页两个页签内容完全一样，使用者无法判断改的是哪一条。
 * 现在每种事件类型各有一份独立默认文本；`{{if}}` 语法仍支持，需要"一份管两态"可自己写。
 *
 * i18n v1（2026-09-16）：外层再加**语言**维度——通知按**接收者**语言渲染（设计文档 §7.1）。
 * 解析顺序：项目自定义模板 → 收件人语言默认 → zh-CN 默认。
 */
export const DEFAULT_TEMPLATES: Record<string, Record<AlertKind, Record<AlertChannel, TemplateContent>>> = {
  'zh-CN': {
    fire: {
      chat: { subject: FIRE_SUBJECT, body: FIRE_BODY },
      email: { subject: FIRE_SUBJECT, body: FIRE_BODY },
      sms: { subject: FIRE_SUBJECT, body: SMS_BODY },
    },
    resolve: {
      chat: { subject: RESOLVE_SUBJECT, body: RESOLVE_BODY },
      email: { subject: RESOLVE_SUBJECT, body: RESOLVE_BODY },
      sms: { subject: RESOLVE_SUBJECT, body: SMS_RESOLVE_BODY },
    },
  },
  'en-US': {
    fire: {
      chat: { subject: FIRE_SUBJECT_EN, body: FIRE_BODY_EN },
      email: { subject: FIRE_SUBJECT_EN, body: FIRE_BODY_EN },
      sms: { subject: FIRE_SUBJECT_EN, body: SMS_BODY_EN },
    },
    resolve: {
      chat: { subject: RESOLVE_SUBJECT_EN, body: RESOLVE_BODY_EN },
      email: { subject: RESOLVE_SUBJECT_EN, body: RESOLVE_BODY_EN },
      sms: { subject: RESOLVE_SUBJECT_EN, body: SMS_RESOLVE_BODY_EN },
    },
  },
};

/** 取默认模板：目标语言缺失回退 zh-CN，再回退 chat 触发态 */
export function defaultTemplate(kind: AlertKind, channel: AlertChannel, locale?: string | null): TemplateContent {
  const bundle = DEFAULT_TEMPLATES[locale ?? ''] ?? DEFAULT_TEMPLATES['zh-CN'];
  return bundle[kind]?.[channel] ?? bundle.fire.chat;
}

/**
 * 变量示例值（i18n v1）：中文用 `sample` 原值（逐字不变），
 * 其他语言用 `sample_key` 取服务端文案；缺键或未上线语言回退原值。
 */
export function sampleFor(item: TemplateVar, locale?: string | null): string {
  if (!locale || locale.startsWith('zh') || !item.sample_key) return item.sample;
  return serverT(locale, item.sample_key);
}

/** 预览用示例变量（不依赖真实规则）；`locale` 为操作者语言（i18n v1） */
export function sampleContext(overrides: TemplateContext = {}, locale?: string | null): TemplateContext {
  return {
    ...Object.fromEntries(TEMPLATE_VARS.map((item) => [item.name, sampleFor(item, locale)])),
    ...overrides,
  };
}

export const SMS_MAX_LENGTH = 40;

/** 短信通道整形：压缩空白并截断（与投递侧同一规则，预览所见即所得） */
export function collapseForSms(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, SMS_MAX_LENGTH);
}

/** 按通道渲染：短信通道自动压缩截断 */
export function renderForChannel(
  kind: AlertKind,
  channel: AlertChannel,
  content: TemplateContent,
  ctx: TemplateContext,
): RenderedTemplate {
  const subject = renderTemplate(content.subject, ctx).replace(/\s+/g, ' ').trim();
  const body = renderTemplate(content.body, ctx);
  return { subject, body: channel === 'sms' ? collapseForSms(body) : body };
}
