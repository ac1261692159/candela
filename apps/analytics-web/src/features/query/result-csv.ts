import type { QueryColumn } from '../../types/dsl.types';
import { t as i18nT, type TFunction } from '../../i18n';
import { localizedColumnTitle } from './column-titles';

export function mappedText(
  column: { value_map?: Record<string, string> } | undefined,
  raw: unknown,
  showRaw = false,
): string {
  if (raw == null) return '';
  const text = String(raw);
  if (showRaw || !column?.value_map) return text;
  return column.value_map[text] ?? text;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 导出：已映射列同时输出业务名与原始值，便于对账。t 缺省用当前语言。 */
export function resultToCsv(
  columns: QueryColumn[],
  rows: Record<string, unknown>[],
  t: TFunction = i18nT,
): string {
  const shown = rows.filter((row) => row.__stage !== true);
  const headers: string[] = [];
  const accessors: Array<{ key: string; mapped: boolean }> = [];
  for (const column of columns) {
    const mapped = Boolean(column.value_map && Object.keys(column.value_map).length > 0);
    // 表头按导出时语言渲染（服务端固定文案列名带 title_key，数据列回落中文原值）
    const title = localizedColumnTitle(column, t);
    if (mapped) {
      headers.push(
        column.value_map_title
          ? t('analysis:result.mappedHeader', { title, mapTitle: column.value_map_title })
          : title,
      );
      headers.push(t('analysis:result.rawHeader', { title }));
      accessors.push({ key: column.key, mapped: true });
    } else {
      headers.push(title);
      accessors.push({ key: column.key, mapped: false });
    }
  }
  const lines = [headers.map(csvCell).join(',')];
  for (const row of shown) {
    const cells: string[] = [];
    for (const access of accessors) {
      const column = columns.find((item) => item.key === access.key);
      const raw = row[access.key];
      if (access.mapped) {
        cells.push(csvCell(mappedText(column, raw)));
        cells.push(csvCell(raw == null ? '' : String(raw)));
      } else {
        cells.push(csvCell(raw == null ? '' : String(raw)));
      }
    }
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

export function downloadResultCsv(filename: string, columns: QueryColumn[], rows: Record<string, unknown>[]): void {
  const blob = new Blob([`\uFEFF${resultToCsv(columns, rows)}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
