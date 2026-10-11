import type { MetricTransform } from '../../types/dsl.types';

/**
 * 指标数值变换：**四则运算 + 保留小数位**（phase: clklog-analytics-metric-v3）。
 *
 * 之前只有「乘以系数」，单位换算里常见的 ÷1000（毫秒→秒）、+8（时区补正）、-1（剔除测试流量）
 * 都表达不了。现在统一为 `{op, value, decimals}`：
 * - `op ∈ mul | div | add | sub`，先做四则运算，再 `round(..., decimals)`；
 * - 旧字段 `factor` 等价于 `op='mul'`（读时归一化，写回时升级为 op/value）；
 * - 数据库侧（聚合后计算）与 JS 侧（指标求值）共用这一份语义，避免两处算法漂移。
 */

export type TransformOp = 'mul' | 'div' | 'add' | 'sub';

export const TRANSFORM_OPS: TransformOp[] = ['mul', 'div', 'add', 'sub'];

export interface ResolvedTransform {
  op: TransformOp;
  value: number;
  decimals?: number;
}

const MAX_ABS_VALUE = 1_000_000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 归一化：`factor` → `{op:'mul', value:factor}`；无效返回 null（调用方自行决定是否报错） */
export function resolveTransform(raw: MetricTransform | null | undefined): ResolvedTransform | null {
  if (!raw || typeof raw !== 'object') return null;
  const decimals = Number.isInteger(raw.decimals) && (raw.decimals as number) >= 0 && (raw.decimals as number) <= 6
    ? (raw.decimals as number)
    : undefined;
  if (raw.op !== undefined) {
    if (!TRANSFORM_OPS.includes(raw.op) || !isFiniteNumber(raw.value)) return null;
    if (raw.op === 'div' && raw.value === 0) return null;
    // 乘 1 / 加 0 / 减 0 是无操作，但保留用户意图（decimals 仍可能生效）
    return { op: raw.op, value: raw.value, ...(decimals === undefined ? {} : { decimals }) };
  }
  if (isFiniteNumber(raw.factor)) {
    return { op: 'mul', value: raw.factor, ...(decimals === undefined ? {} : { decimals }) };
  }
  return decimals === undefined ? null : { op: 'mul', value: 1, decimals };
}

/** 无操作变换（乘/除 1、加/减 0 且无小数位）——保存时不该留下这种"配置" */
export function isNoopTransform(resolved: ResolvedTransform | null): boolean {
  if (!resolved) return true;
  if (resolved.decimals !== undefined) return false;
  if (resolved.op === 'mul' || resolved.op === 'div') return resolved.value === 1;
  return resolved.value === 0;
}

/* 注意：数值变换**只在 SQL 侧应用一次**（`buildTransformSql` 由事件分析 SQL 生成器调用，
 * 指标求值走同一查询链路）。JS 侧不再重复计算——重复应用会把 ÷1000 变成 ÷1000000，
 * 而且 JS 的 Math.round 与 ClickHouse 的 round 在半值上结果不同，两处各算一次必然对不上。
 * 见 docs/architecture/clklog-analytics-design-metric-v3.md §1。 */

/** 数据库侧应用（事件分析：聚合后套一层表达式；指标求值与试算复用同一条链路） */
export function buildTransformSql(expr: string, raw: MetricTransform | null | undefined): string {
  const transform = resolveTransform(raw);
  if (!transform) return expr;
  const { op, value, decimals } = transform;
  const operand = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  let wrapped = expr;
  if (op === 'mul' && value !== 1) wrapped = `(${wrapped}) * ${operand}`;
  else if (op === 'div' && value !== 1) wrapped = `(${wrapped}) / ${operand}`;
  else if (op === 'add' && value !== 0) wrapped = `(${wrapped}) + ${operand}`;
  else if (op === 'sub' && value !== 0) wrapped = `(${wrapped}) - ${operand}`;
  if (decimals !== undefined) wrapped = `round(${wrapped}, ${decimals})`;
  return wrapped;
}

/** 校验（保存指标、查询 DSL 校验共用）：返回错误文案，合法返回 null */
export function validateTransform(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return '数值变换格式不合法';
  const { op, value, factor, decimals } = raw as MetricTransform;
  if (op !== undefined && !TRANSFORM_OPS.includes(op)) {
    return `数值变换的运算不合法（可选：${TRANSFORM_OPS.join(' / ')}）`;
  }
  if (op !== undefined) {
    if (!isFiniteNumber(value)) return '数值变换的运算数必须是数字';
    if (Math.abs(value) > MAX_ABS_VALUE) return `数值变换的运算数绝对值不能超过 ${MAX_ABS_VALUE}`;
    if (op === 'div' && value === 0) return '数值变换不能除以 0';
  }
  if (factor !== undefined) {
    if (!isFiniteNumber(factor)) return '数值变换的系数必须是数字';
    if (Math.abs(factor) > MAX_ABS_VALUE) return `数值变换的系数绝对值不能超过 ${MAX_ABS_VALUE}`;
  }
  if (decimals !== undefined && decimals !== null) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
      return '保留小数位必须是 0~6 的整数';
    }
  }
  if (op === undefined && factor === undefined && (decimals === undefined || decimals === null)) return null;
  return null;
}

/** 展示文案：「÷1000，保留 2 位」/「×0.001」/「+8」/「−1」 */
export function describeTransform(raw: MetricTransform | null | undefined): string {
  const transform = resolveTransform(raw);
  if (!transform) return '';
  const symbol = transform.op === 'mul' ? '×' : transform.op === 'div' ? '÷' : transform.op === 'add' ? '+' : '−';
  const parts = [`${symbol}${transform.value}`];
  if (transform.decimals !== undefined) parts.push(`保留 ${transform.decimals} 位`);
  return parts.join('，');
}
