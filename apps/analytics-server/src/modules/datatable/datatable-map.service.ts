import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { DatatableRowsService } from './datatable-rows.service';

/** 一次值映射结果：原始值 → 业务名 */
export interface ValueMapResult {
  /** 原始值 → 展示名（未命中的值不会出现在这里，前端回落原始值） */
  map: Record<string, string>;
  /** 用哪一列做展示名 */
  label_field: string;
  /** 该列的显示名（用于页面说明「按 X 显示」） */
  label_title: string;
  datatable_key: string;
  key_column: string;
  version: number;
}

/**
 * 属性 → 维表映射的查询结果。
 * 先回答「有没有绑定」（决定页面是否该提示"疑似配错"），再给映射本身：
 * 没有绑定的列不能提示"已绑定维表"，否则每个普通分组列都会挂一个红色问号。
 */
export interface ValueMapLookup {
  /** 该属性在本项目有生效绑定；false 时 result 必为 null */
  bound: boolean;
  /** 展示列（有绑定就尽量给出，"0 命中"时页面据此说明按哪列显示） */
  label_field?: string;
  label_title?: string;
  truncated?: boolean;
  /** 有绑定但本次取值一个都没命中时为 null */
  result: ValueMapResult | null;
}

/** 标识列：可以当 join 键，但不能当"业务名"展示 */
function isIdLikeColumn(column: { field_key: string; is_primary?: boolean }): boolean {
  if (column.is_primary) return true;
  return column.field_key === 'id' || /(^|_)id$/i.test(column.field_key);
}

/**
 * 选展示列：值映射实际拿哪一列当业务名。
 *
 * 优先 `*_name` 文本列（业务命名习惯），其次任一文本列，最后退化到第一个非 key 列；
 * **ID 型列（主键 / `id` / `*_id`）一律不当展示列**：拿 ID 当"业务名"显示，用户看到的是
 * 两列互换（如 `goods_name` 的值被换成 `goods_id`），比不映射更糟；表里只剩 ID 型列时
 * 返回 null，调用方据此放弃映射（回落原始值）。
 * 查询链路与「关联属性」列表共用这一份规则，避免两边说法不一致。
 */
export function pickLabelField(
  columns: { field_key: string; data_type: string; is_primary?: boolean }[],
  keyColumn: string,
): string | null {
  const others = columns.filter(
    (column) => column.field_key !== keyColumn && !isIdLikeColumn(column),
  );
  const nameish = others.find(
    (column) => column.data_type === 'string' && /(^|_)name$/i.test(column.field_key),
  );
  const text = nameish ?? others.find((column) => column.data_type === 'string');
  return (text ?? others[0])?.field_key ?? null;
}

/** 绑定显式选了展示列就用它；否则走 pickLabelField 默认。 */
export function resolveLabelField(
  columns: { field_key: string; data_type: string; is_primary?: boolean }[],
  keyColumn: string,
  requested?: string | null,
): string | null {
  if (requested && columns.some((column) => column.field_key === requested)) return requested;
  return pickLabelField(columns, keyColumn);
}

/** 事件分析：分组列 `g_N` 对应 groups[N].prop（跳过「总计」时间桶）。 */
export function groupMapTargets(
  groups?: Array<{ scope?: string; granularity?: string; prop?: string }>,
): { key: string; prop: string }[] {
  const targets: { key: string; prop: string }[] = [];
  (groups ?? []).forEach((group, index) => {
    if (group.scope === 'time' && group.granularity === 'total') return;
    if (group.prop) targets.push({ key: `g_${index}`, prop: group.prop });
  });
  return targets;
}

/** 漏斗/留存：单列 `group_col`；时间/分群/标签不当维表键。 */
export function firstGroupMapTarget(
  groups?: Array<{ scope?: string; prop?: string }>,
): { key: string; prop: string }[] {
  const group = groups?.[0];
  if (!group?.prop) return [];
  if (group.scope === 'time' || group.scope === 'cohort' || group.scope === 'tag') return [];
  return [{ key: 'group_col', prop: group.prop }];
}

/**
 * 值映射（数据表 v1 §7）：把分析结果里「已绑定数据表的属性」的取值换成维表业务名。
 * 只读、按需、结果内联进查询结果；未命中一律回落原始值，不改变下钻用的原始值。
 */
@Injectable()
export class DatatableMapService {
  private readonly logger = new Logger(DatatableMapService.name);
  /** 表快照进程内缓存：避免同一张表在一次查询里被反复整表读取 */
  private readonly snapshotCache = new Map<string, { at: number; data: Map<string, string> }>();
  private static readonly SNAPSHOT_TTL_MS = 60_000;
  private static readonly MAX_VALUES = 50_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rows: DatatableRowsService,
  ) {}

  private async readSnapshotCached(
    project: string,
    datatableId: string,
    version: number,
  ): Promise<Map<string, string>> {
    // 注意：ClickHouse 行的 datatable_key 列存的是**内部 id**（`datatable.service` 全部传 id），
    // 不是用户看到的 table_key；传错会静默返回空映射（v1 值映射直接失效）。
    const cacheKey = `${project}:${datatableId}:${version}`;
    const hit = this.snapshotCache.get(cacheKey);
    if (hit && Date.now() - hit.at < DatatableMapService.SNAPSHOT_TTL_MS) return hit.data;
    const data = await this.rows.readSnapshot(project, datatableId, version);
    this.snapshotCache.set(cacheKey, { at: Date.now(), data });
    return data;
  }

  invalidateProject(project: string): void {
    const prefix = `${project}:`;
    for (const key of [...this.snapshotCache.keys()]) {
      if (key.startsWith(prefix)) this.snapshotCache.delete(key);
    }
  }

  /**
   * 项目级「数据表修订戳」：进查询缓存 key，使建表/更新数据/绑定变更后旧缓存自然失效。
   * 取值包含生效绑定数与两张表的更新时间，任何一次变更都会改变它。
   */
  async revision(project: string): Promise<string> {
    try {
      const [tables, bindings] = await Promise.all([
        this.prisma.metaDatatable.aggregate({
          where: { project_name: project },
          _count: true,
          _max: { updated_at: true },
        }),
        this.prisma.metaDatatableBinding.aggregate({
          where: { project_name: project, status: 'active' },
          _count: true,
          _max: { created_at: true },
        }),
      ]);
      const tableStamp = tables._max.updated_at?.getTime() ?? 0;
      const bindingStamp = bindings._max.created_at?.getTime() ?? 0;
      return `dt${tables._count}.${tableStamp}.b${bindings._count}.${bindingStamp}`;
    } catch {
      // 修订戳失败不能影响查询本身：退化为固定值（等于沿用原缓存策略）
      return 'dt-na';
    }
  }

  /**
   * 按属性名生成值映射。
   * - 没有生效绑定 → `{ bound: false }`（调用方保持原样，且**不能**提示"已绑定维表"）
   * - 有绑定但本次取值一个都没命中 / 表为空 → `{ bound: true, result: null }`
   */
  async buildForProp(
    project: string,
    targetProp: string,
    rawValues: string[],
  ): Promise<ValueMapLookup> {
    const none: ValueMapLookup = { bound: false, result: null };
    if (rawValues.length === 0) return none;
    const binding = await this.prisma.metaDatatableBinding.findFirst({
      where: { project_name: project, target_prop: targetProp, status: 'active' },
    });
    if (!binding) return none;
    const bound = { bound: true, result: null } as ValueMapLookup;
    const table = await this.prisma.metaDatatable.findFirst({
      where: { id: binding.datatable_id, status: 'active' },
    });
    if (!table || table.active_version < 1) return bound;

    const columns = await this.prisma.metaDatatableColumn.findMany({
      where: { datatable_id: table.id },
      orderBy: { sort_order: 'asc' },
    });
    if (columns.length === 0) return bound;

    const keyColumn =
      binding.key_column || columns.find((column) => column.is_primary)?.field_key || columns[0].field_key;
    const labelField = resolveLabelField(columns, keyColumn, binding.label_field);
    const truncated = rawValues.length > DatatableMapService.MAX_VALUES;
    // 表里只剩 ID 型列可选：显示 ID 不是"业务名"，宁可不映射（避免两列看起来互换）
    if (!labelField) return { ...bound, truncated };
    const labelTitle =
      columns.find((column) => column.field_key === labelField)?.display_name || labelField;

    let snapshot: Map<string, string>;
    try {
      snapshot = await this.readSnapshotCached(project, table.id, table.active_version);
    } catch (err) {
      this.logger.warn(`读取数据表快照失败（${table.id} / ${table.table_key}）：${(err as Error).message}`);
      return { bound: true, result: null, label_field: labelField, label_title: labelTitle, truncated };
    }

    // 行键（ClickHouse 的 pk）恒为**首列**（写入与导出都以首列做 pk），而 join 键列可能不是首列
    // （方案 B 允许任选）。values JSON **不含首列**，所以：
    // - 只有 join 键列 = 首列时才能靠 pk 命中；
    // - 键列不是首列时必须用 `values[键列]`，否则「事件取值恰好等于某行自增 ID」会被错误映射。
    const firstKey = columns[0].field_key;
    const wanted = new Set(rawValues.slice(0, DatatableMapService.MAX_VALUES));
    const map: Record<string, string> = {};
    for (const [pk, payload] of snapshot) {
      let values: Record<string, unknown>;
      try {
        values = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue; // 坏行忽略，不影响其它值
      }
      const keyValue = values[keyColumn];
      const candidates = new Set<string>();
      if (keyColumn === firstKey) candidates.add(pk);
      if (keyValue !== undefined && keyValue !== null && String(keyValue) !== '') {
        candidates.add(String(keyValue));
      }
      // 兜底：键列取值缺失（空值 / 历史行）时仍可用 pk 命中
      if (candidates.size === 0) candidates.add(pk);
      for (const candidate of candidates) {
        if (!wanted.has(candidate) || map[candidate] !== undefined) continue;
        // labelField = 首列时它的值就是 pk（values 里没有首列）
        const label = labelField === firstKey ? pk : values[labelField];
        if (label === undefined || label === null || String(label) === '') continue;
        map[candidate] = String(label);
      }
    }
    if (Object.keys(map).length === 0) {
      return { bound: true, result: null, label_field: labelField, label_title: labelTitle, truncated };
    }

    return {
      bound: true,
      label_field: labelField,
      label_title: labelTitle,
      truncated,
      result: {
        map,
        label_field: labelField,
        label_title: labelTitle,
        datatable_key: table.table_key,
        key_column: keyColumn,
        version: table.active_version,
      },
    };
  }

  /**
   * 给结果列附值映射。event / funnel / retention 共用，避免三处复制 enrich 规则。
   */
  async attachToColumns<T extends { key: string }>(
    project: string,
    columns: T[],
    rows: Record<string, unknown>[],
    targets: { key: string; prop: string }[],
  ): Promise<T[]> {
    if (targets.length === 0) return columns;
    const mapped = await Promise.all(
      targets.map(async (target) => {
        const values = [
          ...new Set(
            rows
              .map((row) => row[target.key])
              .filter((value) => value !== null && value !== undefined && value !== '')
              .map(String),
          ),
        ];
        const lookup = await this.buildForProp(project, target.prop, values).catch(
          (): ValueMapLookup => ({ bound: false, result: null }),
        );
        return { key: target.key, lookup, sampled: values.length, prop: target.prop };
      }),
    );
    return columns.map((column) => {
      const hit = mapped.find((item) => item.key === column.key);
      if (!hit || !hit.lookup.bound) return column;
      const stats = {
        sampled: hit.sampled,
        matched: hit.lookup.result ? Object.keys(hit.lookup.result.map).length : 0,
        ...(hit.lookup.truncated ? { truncated: true } : {}),
      };
      if (!hit.lookup.result) {
        if (hit.sampled > 0) {
          return {
            ...column,
            value_map_title: hit.lookup.label_title ?? hit.prop,
            value_map_stats: stats,
          };
        }
        return column;
      }
      return {
        ...column,
        value_map: hit.lookup.result.map,
        value_map_title: hit.lookup.result.label_title,
        value_map_stats: stats,
      };
    });
  }

  /** 筛选下拉：已绑定属性返回 名称（ID）候选项，提交值仍是 raw。 */
  async labelsForProp(
    project: string,
    targetProp: string,
    limit = 5_000,
  ): Promise<{
    bound: boolean;
    label_title?: string;
    items: { raw: string; label: string }[];
    truncated: boolean;
  }> {
    const none = { bound: false, items: [] as { raw: string; label: string }[], truncated: false };
    const binding = await this.prisma.metaDatatableBinding.findFirst({
      where: { project_name: project, target_prop: targetProp, status: 'active' },
    });
    if (!binding) return none;
    const table = await this.prisma.metaDatatable.findFirst({
      where: { id: binding.datatable_id, status: 'active' },
    });
    if (!table || table.active_version < 1) return { bound: true, items: [], truncated: false };
    const columns = await this.prisma.metaDatatableColumn.findMany({
      where: { datatable_id: table.id },
      orderBy: { sort_order: 'asc' },
    });
    const keyColumn =
      binding.key_column || columns.find((column) => column.is_primary)?.field_key || columns[0]?.field_key;
    if (!keyColumn) return { bound: true, items: [], truncated: false };
    const labelField = resolveLabelField(columns, keyColumn, binding.label_field);
    if (!labelField) return { bound: true, items: [], truncated: false };
    let snapshot: Map<string, string>;
    try {
      snapshot = await this.readSnapshotCached(project, table.id, table.active_version);
    } catch {
      return { bound: true, items: [], truncated: false };
    }
    const firstKey = columns[0].field_key;
    const items: { raw: string; label: string }[] = [];
    for (const [pk, payload] of snapshot) {
      if (items.length >= limit) break;
      let values: Record<string, unknown>;
      try {
        values = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const raw =
        keyColumn === firstKey ? pk : values[keyColumn] != null ? String(values[keyColumn]) : pk;
      const label = labelField === firstKey ? pk : values[labelField];
      if (!raw || label == null || String(label) === '') continue;
      items.push({ raw, label: String(label) });
    }
    const title = columns.find((column) => column.field_key === labelField)?.display_name || labelField;
    return {
      bound: true,
      label_title: title,
      items,
      truncated: snapshot.size > items.length,
    };
  }
}
