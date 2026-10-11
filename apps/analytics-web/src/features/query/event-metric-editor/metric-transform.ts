/**
 * 数值变换（四则运算 + 保留小数位）的前端镜像（phase: clklog-analytics-metric-v3）。
 *
 * 与后端 `query/metric-transform.ts` 同一语义：**变换在 SQL 侧应用一次**，
 * 前端只负责编辑、回显与提交，不做数值计算（两处各算一次必然出现 ÷1000 变 ÷1000000）。
 */

import { t as i18nT, type TFunction } from '../../../i18n';

export type TransformOp = 'mul' | 'div' | 'add' | 'sub';

export interface MetricTransformValue {
  op?: TransformOp;
  value?: number;
  /** v2 旧字段（等价 op='mul'） */
  factor?: number;
  decimals?: number;
}

/**
 * 兼容层（勿删）：`features/metrics/`（P2-C 批次）直接读取本常量；
 * 本域内部用 `transformOpOptions(t)`。对方迁移后一并删除。
 */

/** 四则运算选项（`t` 缺省用当前语言） */
export function transformOpOptions(t: TFunction = i18nT): { label: string; value: TransformOp }[] {
  return [
    { label: t('analysis:transform.mul'), value: 'mul' },
    { label: t('analysis:transform.div'), value: 'div' },
    { label: t('analysis:transform.add'), value: 'add' },
    { label: t('analysis:transform.sub'), value: 'sub' },
  ];
}

/** 运算符号（用于文案） */
export const TRANSFORM_OP_SYMBOL: Record<TransformOp, string> = {
  mul: '×',
  div: '÷',
  add: '+',
  sub: '−',
};

export function resolveTransformValue(transform?: MetricTransformValue | null): {
  op: TransformOp;
  value: number;
  decimals?: number;
} | null {
  if (!transform || typeof transform !== 'object') return null;
  const decimals =
    typeof transform.decimals === 'number' && Number.isInteger(transform.decimals) && transform.decimals >= 0
      ? transform.decimals
      : undefined;
  if (transform.op && typeof transform.value === 'number' && Number.isFinite(transform.value)) {
    return { op: transform.op, value: transform.value, ...(decimals === undefined ? {} : { decimals }) };
  }
  if (typeof transform.factor === 'number' && Number.isFinite(transform.factor)) {
    return { op: 'mul', value: transform.factor, ...(decimals === undefined ? {} : { decimals }) };
  }
  if (decimals !== undefined) return { op: 'mul', value: 1, decimals };
  return null;
}

/** 无操作变换（乘/除 1、加/减 0 且无小数位）：提交时不写入定义 */
export function isNoopTransform(transform?: MetricTransformValue | null): boolean {
  const resolved = resolveTransformValue(transform);
  if (!resolved) return true;
  if (resolved.decimals !== undefined) return false;
  if (resolved.op === 'mul' || resolved.op === 'div') return resolved.value === 1;
  return resolved.value === 0;
}

/** 文案：「÷1000，保留 2 位」（`t` 缺省用当前语言） */
export function describeTransform(transform?: MetricTransformValue | null, t: TFunction = i18nT): string {
  const resolved = resolveTransformValue(transform);
  if (!resolved) return '';
  const parts = [`${TRANSFORM_OP_SYMBOL[resolved.op]}${resolved.value}`];
  if (resolved.decimals !== undefined) parts.push(t('analysis:transform.decimalsKept', { decimals: resolved.decimals }));
  return parts.join(t('analysis:transform.join'));
}
