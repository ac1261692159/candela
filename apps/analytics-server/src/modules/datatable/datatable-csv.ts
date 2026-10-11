/**
 * 数据表（维度表）CSV 解析与校验 —— 纯函数，便于单测。
 *
 * 规则（与 PRD §6 对齐）：
 * - 第一列即主键；表头即字段名：`^[a-z][a-z0-9_]{0,49}$`；
 * - 文件内同主键重复：**后行覆盖前行**（与数数/神策"取首行"刻意不同，见 PRD §10 决议）；
 * - 主键为空 / 单元格超长 / 类型不符 → 丢弃并记录行号与原因；
 * - 限额：文件 ≤ 10MB、行数 ≤ 20 万、列数 ≤ 50。
 */

export type DatatableDataType = 'number' | 'string' | 'datetime' | 'boolean';

export const DATATABLE_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxRows: 200_000,
  maxColumns: 100,
  maxCellLength: 1024,
} as const;

export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

export interface ParsedColumn {
  field_key: string;
  data_type: DatatableDataType;
  display_name: string;
  is_primary: boolean;
  sort_order: number;
}

export interface DroppedRow {
  line: number;
  reason: string;
  /** 原因的文案键与参数（i18n v1；前端优先用 key 渲染，`reason` 为中文兜底） */
  reason_key?: string;
  reason_params?: Record<string, unknown>;
}

export interface ParsedCsv {
  columns: ParsedColumn[];
  /** 主键 → 归一化后的 values（JSON 字符串） */
  rows: Map<string, string>;
  /** 主键 → 已解析的原始行（用于预览：字段值按声明类型呈现） */
  preview: Record<string, string>[];
  successRows: number;
  droppedRows: number;
  dropped: DroppedRow[];
  /** 文件内主键重复（后行覆盖前行）的次数 */
  duplicatedKeys: number;
}

export class DatatableCsvError extends Error {}

/** 解析 CSV 文本（支持 `,` `;` `\t` 分隔、双引号包裹、BOM） */
export function parseCsvText(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(clean);
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // 丢掉完全空白的尾部行
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function detectDelimiter(text: string): string {
  const headerLine = text.split(/\r?\n/, 1)[0] ?? '';
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = -1;
  for (const c of candidates) {
    const count = headerLine.split(c).length - 1;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return best;
}

function inferDataType(samples: string[]): DatatableDataType {
  const values = samples.filter((v) => v.trim() !== '');
  if (values.length === 0) return 'string';
  if (values.every((v) => Number.isFinite(Number(v)))) return 'number';
  if (values.every((v) => /^(true|false)$/i.test(v.trim()))) return 'boolean';
  if (
    values.every((v) => /^\d{4}-\d{2}(-\d{2})?([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(v.trim()))
  ) {
    return 'datetime';
  }
  return 'string';
}

/** 主键与布尔值归一化：保证跨类型比较时两侧形态一致 */
export function normalizeKey(value: string, type: DatatableDataType): string {
  const trimmed = value.trim();
  if (type === 'number') {
    const n = Number(trimmed);
    return Number.isFinite(n) ? String(n) : trimmed;
  }
  if (type === 'boolean') return /^true$/i.test(trimmed) ? 'true' : 'false';
  return trimmed;
}

function cellToJsonValue(value: string, type: DatatableDataType): unknown {
  const trimmed = value.trim();
  if (type === 'number') {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'boolean') return /^true$/i.test(trimmed);
  return trimmed;
}

function cellMatchesType(value: string, type: DatatableDataType): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return true;
  if (trimmed.length > DATATABLE_LIMITS.maxCellLength) return false;
  if (type === 'number') return Number.isFinite(Number(trimmed));
  if (type === 'boolean') return /^(true|false)$/i.test(trimmed);
  return true;
}

export interface ParseOptions {
  /** 已确认（或人工修正）的列类型；不传则按首 100 行推断 */
  columns?: { field_key: string; data_type: DatatableDataType; display_name?: string }[];
}

/** 解析并校验整张表；不合格直接抛错（表头问题属于整表失败，不做部分成功） */
export function parseDatatableCsv(text: string, options: ParseOptions = {}): ParsedCsv {
  if (!text.trim()) throw new DatatableCsvError('文件内容为空');
  if (Buffer.byteLength(text, 'utf8') > DATATABLE_LIMITS.maxBytes) {
    throw new DatatableCsvError('文件超过 10MB 上限');
  }
  const grid = parseCsvText(text);
  if (grid.length < 2) throw new DatatableCsvError('文件需要表头 + 至少一行数据');

  const header = grid[0].map((h) => h.trim());
  if (header.length > DATATABLE_LIMITS.maxColumns) {
    throw new DatatableCsvError(`列数超过上限 ${DATATABLE_LIMITS.maxColumns}`);
  }
  header.forEach((name, idx) => {
    if (!FIELD_KEY_PATTERN.test(name)) {
      throw new DatatableCsvError(
        `第 ${idx + 1} 列字段名不合法：${name || '(空)'}（需小写字母开头、仅小写字母/数字/下划线、≤50 字符）`,
      );
    }
  });
  if (new Set(header).size !== header.length) {
    throw new DatatableCsvError('表头存在重复字段名');
  }

  const body = grid.slice(1);
  if (body.length > DATATABLE_LIMITS.maxRows) {
    throw new DatatableCsvError(`数据行数超过上限 ${DATATABLE_LIMITS.maxRows}`);
  }

  const sample = body.slice(0, 100);
  const columns: ParsedColumn[] = header.map((field_key, idx) => {
    const override = options.columns?.find((c) => c.field_key === field_key);
    const data_type =
      override?.data_type ?? inferDataType(sample.map((row) => row[idx] ?? ''));
    return {
      field_key,
      data_type,
      display_name: override?.display_name?.trim() || field_key,
      is_primary: idx === 0,
      sort_order: idx,
    };
  });
  const primary = columns[0];

  const rows = new Map<string, string>();
  const preview: Record<string, string>[] = [];
  const dropped: DroppedRow[] = [];
  let duplicatedKeys = 0;

  body.forEach((raw, i) => {
    const line = i + 2; // 1 基 + 表头
    const cells = header.map((_, idx) => (raw[idx] ?? '').trim());
    const pkRaw = cells[0];
    if (!pkRaw) {
      dropped.push({ line, reason: '主键为空', reason_key: 'datatable:import.primaryKeyEmpty' });
      return;
    }
    if (!cellMatchesType(pkRaw, primary.data_type)) {
      dropped.push({
        line,
        reason: `主键不是 ${primary.data_type} 类型或超长`,
        reason_key: 'datatable:import.primaryKeyTypeMismatch',
        reason_params: { type: primary.data_type },
      });
      return;
    }
    let bad = false;
    for (let c = 1; c < columns.length; c++) {
      if (!cellMatchesType(cells[c], columns[c].data_type)) {
        dropped.push({
          line,
          reason: `字段 ${columns[c].field_key} 不是 ${columns[c].data_type} 类型或超长`,
          reason_key: 'datatable:import.fieldTypeMismatch',
          reason_params: { field: columns[c].field_key, type: columns[c].data_type },
        });
        bad = true;
        break;
      }
    }
    if (bad) return;

    const pk = normalizeKey(pkRaw, primary.data_type);
    const values: Record<string, unknown> = {};
    for (let c = 1; c < columns.length; c++) {
      values[columns[c].field_key] = cellToJsonValue(cells[c], columns[c].data_type);
    }
    if (rows.has(pk)) duplicatedKeys++;
    rows.set(pk, JSON.stringify(values));
    preview.push(Object.fromEntries(header.map((h, idx) => [h, cells[idx]])));
  });

  return {
    columns,
    rows,
    preview: preview.slice(0, 20),
    successRows: rows.size,
    droppedRows: dropped.length,
    dropped: dropped.slice(0, 200),
    duplicatedKeys,
  };
}

/** 更新时表头必须与已保存列名、顺序完全一致（DT-04） */
export function assertHeaderMatches(
  header: string[],
  saved: { field_key: string }[],
): void {
  const expected = saved.map((column) => column.field_key);
  const actual = header.map((cell) => cell.trim());
  if (actual.length === expected.length && actual.every((name, index) => name === expected[index])) {
    return;
  }
  const missing = expected.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expected.includes(key));
  if (missing.length === 0 && extra.length === 0) {
    throw new DatatableCsvError(
      `表头与当前表结构不一致：期望 ${expected.join(',')}，实际 ${actual.join(',')}`,
    );
  }
  throw new DatatableCsvError(
    `表头与当前表结构不一致：缺少 ${missing.join(', ') || '无'}，多出 ${extra.join(', ') || '无'}`,
  );
}

/** 增量合并：以旧快照为基础，用新文件覆盖同主键（新增则插入） */
export function mergeSnapshot(
  prior: Map<string, string>,
  incoming: Map<string, string>,
  mode: 'incr' | 'replace',
): Map<string, string> {
  if (mode === 'replace') return new Map(incoming);
  const merged = new Map(prior);
  for (const [pk, values] of incoming) merged.set(pk, values);
  return merged;
}
