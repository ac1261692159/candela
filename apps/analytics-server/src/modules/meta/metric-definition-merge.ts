/**
 * 指标定义的**合并**语义（phase: clklog-analytics-metric-detail-v1）。
 *
 * `normalizeDefinition` 是按白名单重建对象：调用方只传部分字段时，未出现的字段会**消失**。
 * 编辑场景下这是数据破坏级的行为（用户的筛选条件/别名会被静默清掉，而界面上根本看不到），
 * 因此在规范化之前先把已存定义与本次提交合并：
 *
 * - `undefined` = 本次未提供 → 保留已存值；
 * - `null` / 空值 = 显式清空 → 覆盖（保持「能删掉筛选」的能力）。
 */

function pickDefined(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function mergeEventSide(storedSide: unknown, incomingSide: unknown): unknown {
  if (!incomingSide || typeof incomingSide !== 'object') return storedSide ?? incomingSide;
  return { ...((storedSide ?? {}) as Record<string, unknown>), ...(incomingSide as Record<string, unknown>) };
}

export function mergeMetricDefinition(
  kind: string,
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (!stored || Object.keys(stored).length === 0) return incoming;

  if (kind === 'event') {
    const storedMetric = (stored.metric ?? {}) as Record<string, unknown>;
    const raw = incoming.metric;
    const incomingMetric = (raw && typeof raw === 'object' ? raw : incoming) as Record<string, unknown>;
    return { ...stored, metric: { ...storedMetric, ...pickDefined(incomingMetric) } };
  }

  if (kind === 'retention') {
    const merged: Record<string, unknown> = {
      ...stored,
      start_event: mergeEventSide(stored.start_event, incoming.start_event ?? incoming.startEvent),
      retain_event: mergeEventSide(
        stored.retain_event,
        incoming.retain_event ?? incoming.retainEvent ?? incoming.return_event,
      ),
      ...pickDefined({
        n: incoming.n,
        measure: incoming.measure,
        cohort: incoming.cohort,
        granularity: incoming.granularity,
      }),
    };
    // v3：队列范围（time_range）也要参与合并——漏掉它会让「改队列范围」静默无效
    if ('time_range' in incoming) {
      if (incoming.time_range) merged.time_range = incoming.time_range;
      else delete merged.time_range;
    }
    return merged;
  }

  return incoming;
}
