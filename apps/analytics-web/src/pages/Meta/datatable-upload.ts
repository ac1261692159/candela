import type { DatatableDataType } from '../../services/datatable.service';
import { t as translate, type TFunction } from '../../i18n';
import { FIELD_KEY_PATTERN } from './datatable-shared';

export const EXCEL_EXT = /\.xlsx?$/i;

export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
/** 与服务端 `DATATABLE_LIMITS.maxBytes` 对齐，提前给出可读错误而不是让服务端 413 */

export const MAX_TABLE_BYTES = 10 * 1024 * 1024;
/** 与服务端 `FIELD_KEY_PATTERN` 对齐：小写字母开头、仅小写字母/数字/下划线、≤50 字符 */

export interface HeaderRename {
  from: string;
  to: string;
}


export interface TabularFileResult {
  text: string;
  renames: HeaderRename[];
  /** 双行表头：第 2 行是字段说明（中文名）时，取作显示名且不作为数据导入 */
  labels: string[] | null;
  /** 数据行全空、已不导入的列名（业务维表常带 `##var` 之类标记列） */
  droppedColumns: string[];
  /** `##type` 行声明的数据类型（未识别到的位置为 null） */
  declaredTypes: (DatatableDataType | null)[] | null;
  /** 是否命中 `##var` 元数据行模式 */
  marker: boolean;
}

/** `##type` 行的类型词表：兼容英文与中文写法 */

export const DECLARED_TYPES: Record<string, DatatableDataType> = {
  string: 'string',
  text: 'string',
  文本: 'string',
  字符串: 'string',
  number: 'number',
  numeric: 'number',
  int: 'number',
  integer: 'number',
  float: 'number',
  数值: 'number',
  数字: 'number',
  datetime: 'datetime',
  date: 'datetime',
  time: 'datetime',
  时间: 'datetime',
  日期: 'datetime',
  boolean: 'boolean',
  bool: 'boolean',
  布尔: 'boolean',
};

/**
 * 识别源文件头部的自描述元数据行（Excel 里常用的约定，仅前 3 行、且必须由 `##var` 开头才启用）：
 *   第 1 行首列 `##var`  → 该行为字段名
 *   第 2 行首列 `##name` → 该行为维度表属性显示名
 *   第 3 行首列 `##type` → 该行为声明数据类型
 * 首列是标记列（数据行里为空），整列剥掉；缺 `##var` 时完全回退旧行为。
 */

export function detectMetadata(grid: string[][]): {
  names: string[] | null;
  declaredTypes: (DatatableDataType | null)[] | null;
  marker: boolean;
} {
  const lead = (row?: string[]) => (row?.[0] ?? '').trim();
  if (lead(grid[0]) !== '##var') return { names: null, declaredTypes: null, marker: false };
  const strip = (row?: string[]) => (row ?? []).slice(1);
  const header = strip(grid[0]);
  const names = lead(grid[1]) === '##name' ? strip(grid[1]) : null;
  const typeRowIndex = names ? 2 : 1;
  const declaredTypes =
    lead(grid[typeRowIndex]) === '##type'
      ? strip(grid[typeRowIndex]).map(
          (value) => DECLARED_TYPES[(value ?? '').trim().toLowerCase()] ?? null,
        )
      : null;
  // 标记列必须从**所有**行剥掉（数据行里它也是空的），否则各列值会整体错位一格
  const consumed = 1 + (names ? 1 : 0) + (declaredTypes ? 1 : 0);
  const body = grid.slice(consumed).map((row) => strip(row));
  grid.length = 0;
  grid.push(header, ...body);
  return { names, declaredTypes, marker: true };
}

/** Excel 单元格 → 文本：日期到秒、公式取计算结果、富文本拼接 */

export function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(
      value.getHours(),
    )}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }
  if (typeof value === 'object') {
    const cell = value as {
      result?: unknown;
      richText?: { text: string }[];
      text?: string;
      hyperlink?: string;
      error?: string;
    };
    if (cell.result !== undefined) return cellToText(cell.result);
    if (Array.isArray(cell.richText)) return cell.richText.map((part) => part.text).join('');
    if (typeof cell.text === 'string') return cell.text;
    if (cell.hyperlink) return cell.hyperlink;
    return '';
  }
  return String(value);
}


export function toCsvText(grid: string[][]): string {
  return grid
    .map((row) =>
      row.map((cell) => (/[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(','),
    )
    .join('\n');
}

/**
 * 读取上传文件为 CSV 文本。CSV 直读；Excel 取第一个工作表转成 CSV 文本后复用既有
 * `csv_text` 契约（服务端校验/限额/错误文案完全一致），解析库按需加载不影响首屏。
 */
/** 拆分 CSV 表头行（仅用于表头规范化，不追求完整 CSV 语义） */

export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

/**
 * 双行表头判定：第 1 行多数是合法字段名、第 2 行非空单元格多数是中文说明 ⇒ 第 2 行是说明行。
 * 这类文件（如 `##var,id,…` + `##,自增ID,…`）第 2 行不能当数据导入，否则中文会被写进表。
 */

export function looksLikeLabelRow(header: string[], second: string[] | undefined): boolean {
  if (!second) return false;
  const nonEmpty = second.filter((cell) => (cell ?? '').trim() !== '');
  if (nonEmpty.length < 2) return false;
  const headerOkRatio =
    header.length === 0 ? 0 : header.filter((name) => FIELD_KEY_PATTERN.test(name)).length / header.length;
  const cnRatio = nonEmpty.filter((cell) => /[^\x00-\x7F]/.test(cell)).length / nonEmpty.length;
  // 关键护栏：只要第 2 行出现纯数字单元格，就当它是**数据行**（如 `1,精铁`），
  // 否则正常中文数据会被误判成说明行而被静默丢掉（丢行不计入丢弃计数）。
  const hasNumericCell = nonEmpty.some((cell) => /^-?\d+(\.\d+)?$/.test(cell.trim()));
  if (hasNumericCell) return false;
  return headerOkRatio >= 0.5 && cnRatio >= 0.5;
}

/**
 * 数据行全空的列直接不导入。这类列（如 Excel 里的 `##var` 标记列）没有任何值，
 * 若保留会占住「第一列 = 主键」的位置，导致所有行被判「主键为空」丢弃。
 */

export function dropEmptyColumns(grid: string[][], t: TFunction = translate): string[] {
  const header = grid[0] ?? [];
  const keep: number[] = [];
  const dropped: string[] = [];
  header.forEach((name, index) => {
    const hasValue = grid.slice(1).some((row) => (row[index] ?? '').trim() !== '');
    if (hasValue) keep.push(index);
    else dropped.push(name?.trim() || t('datatable:upload.columnFallback', { index: index + 1 }));
  });
  if (keep.length > 0 && keep.length < header.length) {
    grid.forEach((row, index) => {
      grid[index] = keep.map((column) => row[column] ?? '');
    });
  } else if (keep.length === 0) {
    throw new Error(t('datatable:upload.allColumnsEmpty'));
  }
  return dropped;
}

/**
 * 表头名不合法（中文、空格、大写等）时自动改为 col_N，原表头留作显示名。
 * 服务端字段名规则不放宽，改由向导第 2 步提供改名入口。
 */

export function normalizeHeader(grid: string[][], t: TFunction = translate): HeaderRename[] {
  const header = grid[0] ?? [];
  const renames: HeaderRename[] = [];
  header.forEach((name, index) => {
    if (FIELD_KEY_PATTERN.test(name)) return;
    const to = `col_${index + 1}`;
    renames.push({ from: name || t('datatable:upload.emptyHeaderName'), to });
    header[index] = to;
  });
  return renames;
}

/** 文本超过服务端上限（Excel 压缩后原文件很小，转成文本可能很大）时提前拦下 */

export function ensureTableSize(text: string, t: TFunction = translate): string {
  if (new Blob([text]).size > MAX_TABLE_BYTES) {
    throw new Error(t('datatable:upload.tableTooLarge'));
  }
  return text;
}


export function uploadErrorMessage(err: unknown, fallback: string, t: TFunction = translate): string {
  const raw = err instanceof Error ? err.message : '';
  if (/413|entity too large/i.test(raw)) {
    return t('datatable:upload.payloadTooLarge');
  }
  return raw || fallback;
}


export async function readTabularFile(file: File, t: TFunction = translate): Promise<TabularFileResult> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(t('datatable:upload.fileTooLarge'));
  if (!EXCEL_EXT.test(file.name)) {
    const text = await file.text();
    const grid = text.split(/\r?\n/).map((line) => splitCsvLine(line));
    const metadata = detectMetadata(grid);
    // 有 `##var` 且已吃掉 `##name`/`##type` 时不再跑启发式，避免把中文数据的首行误判成说明行
    const canHeuristic = !metadata.marker || (!metadata.names && !metadata.declaredTypes);
    let labels: string[] | null = metadata.names;
    if (canHeuristic && looksLikeLabelRow(grid[0] ?? [], grid[1])) {
      labels = grid.splice(1, 1)[0];
    }
    const droppedColumns = dropEmptyColumns(grid, t);
    const renames = normalizeHeader(grid, t);
    return {
      text: ensureTableSize(
        renames.length > 0 || labels || droppedColumns.length > 0 ? toCsvText(grid) : text,
        t,
      ),
      renames,
      labels,
      droppedColumns,
      declaredTypes: metadata.declaredTypes,
      marker: metadata.marker,
    };
  }
  const { Workbook } = await import('exceljs');
  const workbook = new Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(t('datatable:upload.noWorksheet'));
  const grid: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    grid.push((row.values as unknown[]).slice(1).map(cellToText));
  });
  if (grid.length === 0) throw new Error(t('datatable:upload.emptyWorksheet'));
  const width = Math.max(...grid.map((row) => row.length));
  const normalized = grid.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''));
  const metadata = detectMetadata(normalized);
  const canHeuristic = !metadata.marker || (!metadata.names && !metadata.declaredTypes);
  let labels: string[] | null = metadata.names;
  if (canHeuristic && looksLikeLabelRow(normalized[0] ?? [], normalized[1])) {
    labels = normalized.splice(1, 1)[0];
  }
  const droppedColumns = dropEmptyColumns(normalized, t);
  const renames = normalizeHeader(normalized, t);
  return {
    text: ensureTableSize(toCsvText(normalized), t),
    renames,
    labels,
    droppedColumns,
    declaredTypes: metadata.declaredTypes,
    marker: metadata.marker,
  };
}

/** 对齐数数：下拉里的内置属性（不在属性注册表内，固定存在） */
