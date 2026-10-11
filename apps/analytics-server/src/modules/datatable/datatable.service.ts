import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { nanoid } from 'nanoid';
import { badRequest, conflict, notFound } from '../../i18n/domain-error';
import { PrismaService } from '../shared/prisma.service';
import { DatatableRowsService } from './datatable-rows.service';
import { DatatableImportService } from './datatable-import.service';
import { resolveLabelField } from './datatable-map.service';
import {
  DatatableCsvError,
  assertHeaderMatches,
  parseCsvText,
  parseDatatableCsv,
  type ParsedCsv,
} from './datatable-csv';
import { EVENT_TIME_GRANULARITY_FORMAT } from '../relation/datatable-join';
import type {
  CreateBindingDto,
  CreateDatatableDto,
  ParseDatatableDto,
  UpdateBindingDto,
  UpdateDatatableDto,
} from './dto/datatable.dto';

/** 时间绑定的粒度 → 服务端格式化（与 PRD §6.2 / 实测口径一致，固定 Asia/Shanghai） */
export const GRANULARITY_FORMAT = EVENT_TIME_GRANULARITY_FORMAT;

@Injectable()
export class DatatableService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rows: DatatableRowsService,
    private readonly imports: DatatableImportService,
  ) {}

  private parseOrFail(dto: ParseDatatableDto): ParsedCsv {
    try {
      return parseDatatableCsv(dto.csv_text, { columns: dto.columns });
    } catch (err) {
      if (err instanceof DatatableCsvError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  async preview(dto: ParseDatatableDto) {
    const parsed = this.parseOrFail(dto);
    return {
      columns: parsed.columns,
      preview_rows: parsed.preview,
      success_rows: parsed.successRows,
      dropped_rows: parsed.droppedRows,
      dropped_detail: parsed.dropped,
      duplicated_keys: parsed.duplicatedKeys,
    };
  }

  async updatePreview(project: string, id: string, dto: UpdateDatatableDto) {
    await this.requireTable(project, id);
    const saved = await this.prisma.metaDatatableColumn.findMany({
      where: { datatable_id: id },
      orderBy: { sort_order: 'asc' },
    });
    const header = (parseCsvText(dto.csv_text)[0] ?? []).map((cell) => cell.trim());
    try {
      assertHeaderMatches(header, saved);
    } catch (err) {
      if (err instanceof DatatableCsvError) throw new BadRequestException(err.message);
      throw err;
    }
    const parsed = this.parseOrFail({
      ...dto,
      columns: saved.map((column) => ({
        field_key: column.field_key,
        data_type: column.data_type as 'number' | 'string' | 'datetime' | 'boolean',
        display_name: column.display_name ?? undefined,
      })),
    });
    const table = await this.requireTable(project, id);
    return {
      columns: parsed.columns,
      preview_rows: parsed.preview,
      success_rows: parsed.successRows,
      dropped_rows: parsed.droppedRows,
      dropped_detail: parsed.dropped,
      duplicated_keys: parsed.duplicatedKeys,
      current_row_count: table.row_count,
      mode: dto.mode,
    };
  }

  async list(project: string) {
    const [tables, bindings] = await Promise.all([
      this.prisma.metaDatatable.findMany({
        where: { project_name: project, status: { not: 'deleted' } },
        orderBy: { updated_at: 'desc' },
      }),
      this.prisma.metaDatatableBinding.findMany({
        where: { project_name: project, status: 'active' },
      }),
    ]);
    return tables.map((table) => ({
      id: table.id,
      table_key: table.table_key,
      remark: table.remark,
      row_count: table.row_count,
      column_count: table.column_count,
      active_version: table.active_version,
      binding_summary: bindings
        .filter((binding) => binding.datatable_id === table.id)
        .map((binding) => binding.target_prop)
        .join(', '),
      updated_by: table.updated_by,
      updated_at: table.updated_at,
    }));
  }

  /** 查询选择器用：生效绑定上每个非 join 键字段生成的维度表属性 */
  async listDimensionProperties(project: string) {
    const bindings = await this.prisma.metaDatatableBinding.findMany({
      where: { project_name: project, status: 'active' },
    });
    if (bindings.length === 0) return [];
    const tables = await this.prisma.metaDatatable.findMany({
      where: {
        id: { in: [...new Set(bindings.map((binding) => binding.datatable_id))] },
        project_name: project,
        status: { not: 'deleted' },
      },
      select: { id: true },
    });
    const live = new Set(tables.map((table) => table.id));
    const rows: { prop_key: string; display_name: string; data_type: string }[] = [];
    const seen = new Set<string>();
    for (const binding of bindings) {
      if (!live.has(binding.datatable_id)) continue;
      for (const mapping of asFieldMappings(binding.field_mappings)) {
        const propKey = mapping.prop_key || `${binding.target_prop}@${mapping.field_key}`;
        if (!mapping.field_key || seen.has(propKey)) continue;
        seen.add(propKey);
        rows.push({
          prop_key: propKey,
          display_name: mapping.display_name || mapping.field_key,
          data_type: mapping.data_type || 'string',
        });
      }
    }
    return rows;
  }

  async dimensionDisplayNames(project: string): Promise<Map<string, string>> {
    const rows = await this.listDimensionProperties(project);
    return new Map(rows.map((row) => [row.prop_key, row.display_name]));
  }

  async detail(project: string, id: string) {
    const table = await this.requireTable(project, id);
    const [columns, bindings, imports] = await Promise.all([
      this.prisma.metaDatatableColumn.findMany({
        where: { datatable_id: id },
        orderBy: { sort_order: 'asc' },
      }),
      this.prisma.metaDatatableBinding.findMany({
        where: { datatable_id: id },
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.metaDatatableImport.findMany({
        where: { datatable_id: id },
        orderBy: { created_at: 'desc' },
        take: 20,
      }),
    ]);
    return { ...table, columns, bindings: this.withLabelColumns(columns, bindings), imports };
  }

  async downloadCsv(project: string, id: string): Promise<string> {
    const table = await this.requireTable(project, id);
    const columns = await this.prisma.metaDatatableColumn.findMany({
      where: { datatable_id: id },
      orderBy: { sort_order: 'asc' },
    });
    const snapshot = await this.rows.readSnapshot(project, id, table.active_version);
    const header = columns.map((column) => column.field_key);
    const lines = [header.join(',')];
    for (const [pk, valuesRaw] of snapshot) {
      let values: Record<string, unknown> = {};
      try {
        values = JSON.parse(valuesRaw) as Record<string, unknown>;
      } catch {
        values = {};
      }
      const cells = columns.map((column, idx) => {
        if (idx === 0) return csvCell(pk);
        const value = values[column.field_key];
        return csvCell(value === null || value === undefined ? '' : String(value));
      });
      lines.push(cells.join(','));
    }
    return lines.join('\n');
  }

  async create(project: string, user: string, dto: CreateDatatableDto) {
    const id = await this.imports.create(project, user, dto);
    return this.detail(project, id);
  }

  async update(project: string, user: string, id: string, dto: UpdateDatatableDto) {
    const extra = await this.imports.update(project, user, id, dto);
    const table = await this.requireTable(project, id);
    return {
      active_version: table.active_version,
      row_count: table.row_count,
      ...extra,
    };
  }

  async clear(project: string, user: string, id: string) {
    await this.imports.clear(project, user, id);
    const table = await this.requireTable(project, id);
    return { active_version: table.active_version, row_count: table.row_count };
  }

  async remove(project: string, user: string, id: string) {
    return this.imports.remove(project, user, id);
  }

  async updateMeta(project: string, user: string, id: string, dto: { remark?: string }) {
    await this.requireTable(project, id);
    await this.prisma.metaDatatable.update({
      where: { id },
      data: { remark: dto.remark?.trim() ? dto.remark.trim() : null, updated_by: user },
    });
    return { id, remark: dto.remark?.trim() ?? null };
  }

  async listBindings(project: string, id: string) {
    await this.requireTable(project, id);
    const [columns, bindings] = await Promise.all([
      this.prisma.metaDatatableColumn.findMany({
        where: { datatable_id: id },
        orderBy: { sort_order: 'asc' },
      }),
      this.prisma.metaDatatableBinding.findMany({
        where: { datatable_id: id },
        orderBy: { created_at: 'asc' },
      }),
    ]);
    return this.withLabelColumns(columns, bindings);
  }

  private withLabelColumns<
    T extends { key_column: string | null; label_field?: string | null },
  >(
    columns: { field_key: string; data_type: string; display_name: string | null; is_primary: boolean }[],
    bindings: T[],
  ): (T & { label_field: string | null; label_title: string | null })[] {
    return bindings.map((binding) => {
      const keyColumn =
        binding.key_column ||
        columns.find((column) => column.is_primary)?.field_key ||
        columns[0]?.field_key ||
        '';
      const resolved = resolveLabelField(
        columns,
        keyColumn,
        binding.label_field,
      );
      const labelTitle = resolved
        ? columns.find((column) => column.field_key === resolved)?.display_name || resolved
        : null;
      return { ...binding, label_field: resolved, label_title: labelTitle };
    });
  }

  async createBinding(project: string, user: string, id: string, dto: CreateBindingDto) {
    const table = await this.requireTable(project, id);
    this.assertBindingType(dto);
    const columns = await this.columnsOrFail(id);
    this.assertKeyColumn(columns, dto.key_column);
    await this.assertTargetPropertyType(
      project,
      dto.target_type,
      dto.target_prop,
      columns.find((column) => column.field_key === dto.key_column)!,
    );
    const labelField = resolveLabelField(columns, dto.key_column, dto.label_field);
    const fieldMappings = this.buildFieldMappings(columns, dto);
    const existed = await this.prisma.metaDatatableBinding.findFirst({
      where: {
        datatable_id: id,
        target_type: dto.target_type,
        target_prop: dto.target_prop,
      },
    });
    if (existed) {
      if (existed.status === 'active') {
        throw conflict({
          code: 'datatable.binding.propBound',
          messageKey: 'datatable:error.binding.propBound',
          message: '该属性已绑定本数据表',
        });
      }
      await this.prisma.metaDatatableBinding.update({
        where: { id: existed.id },
        data: {
          status: 'active',
          granularity: dto.granularity ?? null,
          key_column: dto.key_column,
          label_field: labelField,
          field_mappings: fieldMappings,
        },
      });
      await this.imports.touchProject(project);
      return {
        id: existed.id,
        restored: true,
        table_key: table.table_key,
        field_mappings: fieldMappings,
        label_field: labelField,
      };
    }
    const bindingId = `dtb_${nanoid(10)}`;
    await this.prisma.metaDatatableBinding.create({
      data: {
        id: bindingId,
        datatable_id: id,
        project_name: project,
        target_type: dto.target_type,
        target_prop: dto.target_prop,
        key_column: dto.key_column,
        label_field: labelField,
        field_mappings: fieldMappings,
        granularity: dto.granularity ?? null,
        created_by: user,
      },
    });
    await this.imports.touchProject(project);
    return {
      id: bindingId,
      restored: false,
      table_key: table.table_key,
      field_mappings: fieldMappings,
      label_field: labelField,
    };
  }

  async updateBinding(project: string, id: string, bindingId: string, dto: UpdateBindingDto) {
    await this.requireTable(project, id);
    const binding = await this.prisma.metaDatatableBinding.findFirst({
      where: { id: bindingId, datatable_id: id },
    });
    if (!binding) {
      throw notFound({
        code: 'datatable.binding.notFound',
        messageKey: 'datatable:error.binding.notFound',
        message: '绑定不存在',
      });
    }
    const columns = await this.columnsOrFail(id);
    const keyColumn = dto.key_column ?? binding.key_column;
    this.assertKeyColumn(columns, keyColumn);
    await this.assertTargetPropertyType(
      project,
      binding.target_type,
      binding.target_prop,
      columns.find((column) => column.field_key === keyColumn)!,
    );
    const labelField = resolveLabelField(columns, keyColumn, dto.label_field ?? binding.label_field);
    const fieldMappings = this.buildFieldMappings(columns, {
      ...dto,
      target_prop: binding.target_prop,
      key_column: keyColumn,
      field_mappings: dto.field_mappings,
    } as CreateBindingDto);
    await this.prisma.metaDatatableBinding.update({
      where: { id: bindingId },
      data: {
        key_column: keyColumn,
        label_field: labelField,
        field_mappings: fieldMappings,
        granularity: dto.granularity === undefined ? undefined : dto.granularity,
      },
    });
    await this.imports.touchProject(project);
    return { id: bindingId, label_field: labelField, key_column: keyColumn };
  }

  private buildFieldMappings(
    columns: { field_key: string; data_type: string; display_name?: string | null }[],
    dto: { target_prop: string; key_column: string; field_mappings?: { field_key: string; display_name?: string }[] },
  ) {
    const overrides = new Map(
      (dto.field_mappings ?? []).map((item) => [item.field_key, item.display_name ?? '']),
    );
    return columns
      .filter((column) => column.field_key !== dto.key_column)
      .map((column) => ({
        field_key: column.field_key,
        prop_key: `${dto.target_prop}@${column.field_key}`,
        data_type: column.data_type,
        display_name:
          overrides.get(column.field_key)?.trim() ||
          (column.display_name ?? '').trim() ||
          column.field_key,
      }));
  }

  async deleteBinding(project: string, id: string, bindingId: string) {
    await this.requireTable(project, id);
    const binding = await this.prisma.metaDatatableBinding.findFirst({
      where: { id: bindingId, datatable_id: id },
    });
    if (!binding) {
      throw notFound({
        code: 'datatable.binding.notFound',
        messageKey: 'datatable:error.binding.notFound',
        message: '绑定不存在',
      });
    }
    if (binding.status !== 'active') {
      await this.prisma.metaDatatableBinding.delete({ where: { id: bindingId } });
      await this.imports.touchProject(project);
      return { id: bindingId, status: 'deleted' };
    }
    await this.prisma.metaDatatableBinding.update({
      where: { id: bindingId },
      data: { status: 'invalid' },
    });
    await this.imports.touchProject(project);
    return { id: bindingId, status: 'invalid' };
  }

  async usage(project: string, id: string) {
    await this.requireTable(project, id);
    const bindings = await this.prisma.metaDatatableBinding.findMany({
      where: { datatable_id: id },
    });
    return {
      bindings: bindings.map((binding) => ({
        target_type: binding.target_type,
        target_prop: binding.target_prop,
        status: binding.status,
      })),
      referenced_cards: 0,
    };
  }

  private async columnsOrFail(id: string) {
    const columns = await this.prisma.metaDatatableColumn.findMany({
      where: { datatable_id: id },
      orderBy: { sort_order: 'asc' },
    });
    if (columns.length === 0) {
      throw badRequest({
        code: 'datatable.binding.noFields',
        messageKey: 'datatable:error.binding.noFields',
        message: '数据表没有字段，无法关联属性',
      });
    }
    return columns;
  }

  private assertKeyColumn(columns: { field_key: string }[], keyColumn: string) {
    if (!columns.some((column) => column.field_key === keyColumn)) {
      const options = columns.map((c) => c.field_key).join('、');
      throw badRequest({
        code: 'datatable.binding.keyColumnNotFound',
        messageKey: 'datatable:error.binding.keyColumnNotFound',
        params: { column: keyColumn, options },
        message: `join 键列 ${keyColumn} 不在数据表字段里；可选：${options}`,
      });
    }
  }

  /**
   * PRD datatable-v2 A7 / CODE_HANDOVER DT-08：绑定前校验目标属性的**存在性**与**类型同族**。
   *
   * 不校验时，文本键列绑数值属性会静默「0 命中」——用户以为数据没了，实际是键对不上。
   * 2026-09-15 生产实测：绑定一个项目中不存在的属性也返回 201。
   */
  private async assertTargetPropertyType(
    project: string,
    targetType: string,
    targetProp: string,
    keyColumn: { field_key: string; data_type: string },
  ): Promise<void> {
    // event_name / event_time 是系统字段，取值域固定，不按属性类型判断
    if (targetType !== 'event_property') return;
    // 同一 prop_key 在不同事件里可能被声明为不同类型（生产实测：state 有 10 个事件是
    // number、12 个是 string）。取全部声明类型判断「是否有同类」，而不是随便取一条
    // ——否则会误伤这种多态属性（验收 A9 踩到）。
    const props = await this.prisma.metaEventProperty.findMany({
      where: { project_name: project, prop_key: targetProp },
      select: { data_type: true },
    });
    if (props.length === 0) {
      throw badRequest({
        code: 'datatable.binding.propNotFound',
        messageKey: 'datatable:error.binding.propNotFound',
        params: { prop: targetProp },
        message: `事件属性 ${targetProp} 不存在（该项目未采集到该属性，绑定后命中恒为 0）`,
      });
    }
    const family = (dataType: string): string => {
      if (dataType === 'number') return 'number';
      if (dataType === 'boolean') return 'boolean';
      if (dataType === 'datetime') return 'datetime';
      if (dataType === 'list' || dataType === 'object' || dataType === 'object_group') return 'complex';
      return 'string';
    };
    const keyFamily = family(keyColumn.data_type);
    const declared = [...new Set(props.map((p) => p.data_type))];
    const families = new Set(declared.map(family));
    if (keyFamily === 'complex' || !families.has(keyFamily)) {
      throw badRequest({
        code: 'datatable.binding.typeMismatch',
        messageKey: 'datatable:error.binding.typeMismatch',
        params: {
          column: keyColumn.field_key,
          keyType: keyColumn.data_type,
          prop: targetProp,
          declared: declared.join('、'),
        },
        message: `类型不匹配：数据表键列 ${keyColumn.field_key}（${keyColumn.data_type}）与事件属性 ${targetProp}（声明类型 ${declared.join('、')}）不是同一类，命中会恒为 0`,
      });
    }
  }

  private assertBindingType(dto: CreateBindingDto) {
    if (dto.target_type === 'event_time' && !dto.granularity) {
      throw badRequest({
        code: 'datatable.binding.eventTimeGranularityRequired',
        messageKey: 'datatable:error.binding.eventTimeGranularityRequired',
        message: '绑定事件时间必须选择时间粒度',
      });
    }
    if (dto.target_type !== 'event_time' && dto.granularity) {
      throw badRequest({
        code: 'datatable.binding.granularityNotAllowed',
        messageKey: 'datatable:error.binding.granularityNotAllowed',
        message: '只有绑定事件时间才需要时间粒度',
      });
    }
  }

  private async requireTable(project: string, id: string) {
    const table = await this.prisma.metaDatatable.findFirst({
      where: { id, project_name: project, status: { not: 'deleted' } },
    });
    if (!table) {
      throw notFound({
        code: 'datatable.table.notFound',
        messageKey: 'datatable:error.table.notFound',
        message: '数据表不存在',
      });
    }
    return table;
  }
}

function asFieldMappings(value: unknown): {
  field_key: string;
  prop_key?: string;
  data_type?: string;
  display_name?: string;
}[] {
  if (!Array.isArray(value)) return [];
  const rows: {
    field_key: string;
    prop_key?: string;
    data_type?: string;
    display_name?: string;
  }[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.field_key !== 'string' || !rec.field_key) continue;
    rows.push({
      field_key: rec.field_key,
      prop_key: typeof rec.prop_key === 'string' ? rec.prop_key : undefined,
      data_type: typeof rec.data_type === 'string' ? rec.data_type : undefined,
      display_name: typeof rec.display_name === 'string' ? rec.display_name : undefined,
    });
  }
  return rows;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
