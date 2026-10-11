/**
 * 查询结果快照行的构造（两种 kind 共用；phase: clklog-analytics-user-timeline-v1 从 Debug 抽取）。
 *
 * 上限必须同量级才不落空：8KB × 100 行 = 800KB 会让 1MB 那条永不生效，故单行取 32KB。
 * 截断一律留标记（`properties_truncated` / `truncated`），不静默。
 */

/** 单行 properties 原文上限（字节） */
export const SNAPSHOT_ROW_MAX_BYTES = 32 * 1024;
/** 单条记录总上限（字节） */
export const SNAPSHOT_TOTAL_MAX_BYTES = 1024 * 1024;

export interface SnapshotSourceRow {
  log_time: string;
  event: string;
  distinct_id: string;
  user_key: string;
  properties: string;
}

export interface SnapshotRow {
  seq: number;
  log_time: string;
  event: string;
  distinct_id: string;
  user_key: string;
  properties: string;
  properties_truncated: boolean;
}

/** 按字节截断（不切断多字节字符），总超限或超行数上限则丢弃剩余行 */
export function buildSnapshotRows(
  items: SnapshotSourceRow[],
  options: { maxRows?: number } = {},
): { rows: SnapshotRow[]; truncated: boolean } {
  const maxRows = options.maxRows ?? Number.MAX_SAFE_INTEGER;
  const rows: SnapshotRow[] = [];
  let totalBytes = 0;
  let truncated = items.length > maxRows;
  for (const [index, item] of items.entries()) {
    if (rows.length >= maxRows) break;
    const raw = item.properties ?? '';
    const rawBytes = Buffer.byteLength(raw, 'utf8');
    const propertiesTruncated = rawBytes > SNAPSHOT_ROW_MAX_BYTES;
    const properties = propertiesTruncated ? truncateUtf8(raw, SNAPSHOT_ROW_MAX_BYTES) : raw;
    const size = Buffer.byteLength(properties, 'utf8') + 64;
    if (totalBytes + size > SNAPSHOT_TOTAL_MAX_BYTES) {
      truncated = true;
      break;
    }
    totalBytes += size;
    rows.push({
      seq: index,
      log_time: item.log_time,
      event: item.event,
      distinct_id: item.distinct_id,
      user_key: item.user_key,
      properties,
      properties_truncated: propertiesTruncated,
    });
  }
  return { rows, truncated };
}

/** 按 UTF-8 字节上限截断，且不切断多字节字符 */
function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}
