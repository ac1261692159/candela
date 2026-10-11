import { Injectable } from '@nestjs/common';
import { badRequest } from '../../i18n/domain-error';
import { PrismaService } from './prisma.service';
import { TimezoneService } from '../time/timezone.service';
import { ExpressionCompilerService } from './expression-compiler.service';
import { FilterScope } from '../../types/dsl.types';
import { JoinRegistry, userProfileJoinRequest } from '../relation/join-registry';
import {
  datatableFieldExpr,
  datatableJoinRequest,
  eventTimeJoinExpr,
  parseDatatableDimension,
} from '../relation/datatable-join';

interface ResolveContext {
  project: string;
  event?: string;
  /**
   * 虚拟事件的来源事件列表。属性解析时，若在虚拟事件本身找不到属性定义，
   * 会依次尝试来源事件作为 fallback。
   */
  events?: string[];
  /**
   * 跨表取数收集器。`scope='user'` 以及维度表属性 `{prop}@{field}` 时**必填**：
   * 改为 LEFT JOIN 取数（ClickHouse 23.2.1 不支持相关子查询）。
   * 调用方须把 `joins.render()` 拼在 `FROM clklog_sa.sa_events` 之后。
   */
  joins?: JoinRegistry;
}

interface LoadedDatatableDimension {
  tableId: string;
  version: number;
  keyColumn: string;
  primaryField: string;
  fieldKey: string;
  dataType: string;
  targetType: string;
  granularity: string | null;
  targetProp: string;
}

@Injectable()
export class AttributeResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expressionCompiler: ExpressionCompilerService,
    // 缺省构造兜底纯单测；生产由 DI 注入（TimeModule @Global）
    private readonly timezones: TimezoneService = new TimezoneService(undefined),
  ) {}

  /**
   * 解析属性访问表达式。
   * 对于 event scope：维度表属性 > 虚拟属性 > 物化列 p_{prop} > JSONExtract(properties, 'prop')。
   * 对于 user scope：注册 `LEFT JOIN sa_user_profiles`，返回该 JOIN 上的列引用。
   */
  async resolve(
    prop: string,
    scope: FilterScope,
    dataType: string,
    context: ResolveContext,
  ): Promise<string> {
    const dim = parseDatatableDimension(prop);
    if (dim) {
      if (scope === 'user') {
        throw badRequest({
          code: 'shared.attribute.datatableUserUnsupported',
          messageKey: 'errors:attribute.datatableUserUnsupported',
          message: '数据表维度暂不支持用户属性',
        });
      }
      return this.resolveDatatableDimension(dim, context);
    }
    if (scope === 'user') {
      return this.resolveUserProperty(prop, dataType, context);
    }
    return this.resolveEventProperty(prop, dataType, context);
  }

  private async resolveEventProperty(
    prop: string,
    dataType: string,
    context: ResolveContext,
  ): Promise<string> {
    // 1. 虚拟属性
    const virtualProp = await this.findVirtualProperty(prop, context.project, context.event);
    if (virtualProp && virtualProp.status === 'active') {
      return this.expressionCompiler.compile(
        virtualProp.expression,
        context,
        async (referencedProp: string) => {
          const refDataType = await this.inferDataType(referencedProp, 'event', context);
          return this.resolveBaseEventProperty(referencedProp, refDataType, context);
        },
      );
    }

    return this.resolveBaseEventProperty(prop, dataType, context);
  }

  async resolveBaseEventProperty(
    prop: string,
    dataType: string,
    context: ResolveContext,
  ): Promise<string> {
    if (parseDatatableDimension(prop)) {
      throw badRequest({
        code: 'shared.attribute.datatableInVirtualExpression',
        messageKey: 'errors:attribute.datatableInVirtualExpression',
        message: '维度表属性不能用于虚拟属性表达式',
      });
    }
    // 2. 物化列
    if (context.event) {
      const metaProp = await this.prisma.metaEventProperty.findFirst({
        where: {
          project_name: context.project,
          event_key: context.event,
          prop_key: prop,
          is_materialized: true,
        },
      });
      if (metaProp?.materialized_column) {
        return metaProp.materialized_column;
      }
    }

    return `JSONExtract${this.extractSuffix(dataType)}(properties, '${prop}')`;
  }

  /**
   * 用户属性（事件侧查询）：注册项目过滤后的 `sa_user_profiles` LEFT JOIN，
   * 返回该 JOIN 别名上的列引用。**不再使用相关子查询**（23.2.1 不支持）。
   */
  private resolveUserProperty(prop: string, dataType: string, context: ResolveContext): string {
    const joins = context.joins;
    if (!joins) {
      throw new Error(
        '用户属性需要 JoinRegistry：请在 ResolveContext 里传入 joins，并把 joins.render() 拼在 FROM clklog_sa.sa_events 之后（modules/relation/join-registry.ts）',
      );
    }
    const alias = joins.register(userProfileJoinRequest());
    return `JSONExtract${this.extractSuffix(dataType)}(${alias}.properties, '${prop}')`;
  }

  /**
   * profile 侧查询（`FROM clklog_sa.sa_user_profiles`）直接取列，**不注入 JOIN**：
   * 该查询自身的 FROM 就是画像表，且带 `project_name = {project}` 参数过滤。
   */
  resolveUserPropertyDirect(prop: string, dataType: string): string {
    return `JSONExtract${this.extractSuffix(dataType)}(properties, '${prop}')`;
  }

  private extractSuffix(dataType: string): string {
    switch (dataType) {
      case 'number':
        return 'Float';
      case 'boolean':
        return 'Bool';
      case 'datetime':
        return 'String';
      case 'list':
      case 'object':
      case 'object_group':
        return 'Raw';
      case 'string':
      default:
        return 'String';
    }
  }

  /**
   * 推断属性数据类型。如果 meta 表没有记录，默认 String。
   * 优先返回虚拟属性的 data_type。
   */
  async inferDataType(
    prop: string,
    scope: FilterScope,
    context: ResolveContext,
  ): Promise<string> {
    const dim = parseDatatableDimension(prop);
    if (dim) {
      if (scope === 'user') {
        throw badRequest({
          code: 'shared.attribute.datatableUserUnsupported',
          messageKey: 'errors:attribute.datatableUserUnsupported',
          message: '数据表维度暂不支持用户属性',
        });
      }
      const loaded = await this.loadDatatableDimension(context.project, dim);
      return loaded.dataType;
    }
    if (scope === 'user') {
      return this.inferUserDataType(prop, context.project);
    }

    const virtualProp = await this.findVirtualProperty(prop, context.project, context.event);
    if (virtualProp) {
      return virtualProp.data_type;
    }

    return this.inferBaseEventDataType(prop, context);
  }

  /**
   * 推断基础事件属性数据类型（不包含虚拟属性）。
   * 若指定了虚拟事件的来源事件列表，会依次 fallback 到来源事件。
   */
  async inferBaseEventDataType(prop: string, context: ResolveContext): Promise<string> {
    if (context.event) {
      const meta = await this.prisma.metaEventProperty.findFirst({
        where: {
          project_name: context.project,
          event_key: context.event,
          prop_key: prop,
        },
      });
      if (meta) return meta.data_type;
    }

    if (context.events?.length) {
      for (const eventKey of context.events) {
        const meta = await this.prisma.metaEventProperty.findFirst({
          where: {
            project_name: context.project,
            event_key: eventKey,
            prop_key: prop,
          },
        });
        if (meta) return meta.data_type;
      }
    }

    return 'string';
  }

  private async inferUserDataType(prop: string, projectName: string): Promise<string> {
    const meta = await this.prisma.metaUserProperty.findFirst({
      where: { project_name: projectName, prop_key: prop },
    });
    return meta?.data_type ?? 'string';
  }

  private async resolveDatatableDimension(
    dim: { targetProp: string; fieldKey: string },
    context: ResolveContext,
  ): Promise<string> {
    const joins = context.joins;
    if (!joins) {
      throw new Error(
        '维度表属性需要 JoinRegistry：请在 ResolveContext 里传入 joins，并把 joins.render() 拼在 FROM clklog_sa.sa_events 之后（modules/relation/join-registry.ts）',
      );
    }
    const loaded = await this.loadDatatableDimension(context.project, dim);
    const leftExpr = await this.datatableJoinLeftExpr(loaded, context);
    const alias = joins.register(
      datatableJoinRequest({
        tableId: loaded.tableId,
        version: loaded.version,
        keyColumn: loaded.keyColumn,
        primaryField: loaded.primaryField,
        leftExpr,
      }),
    );
    return datatableFieldExpr(alias, loaded.fieldKey, loaded.primaryField, loaded.dataType);
  }

  private async datatableJoinLeftExpr(
    loaded: LoadedDatatableDimension,
    context: ResolveContext,
  ): Promise<string> {
    if (loaded.targetProp === '#event_name' || loaded.targetType === 'event_name') {
      return 'sa_events.event';
    }
    if (loaded.targetProp === '#event_time' || loaded.targetType === 'event_time') {
      return eventTimeJoinExpr(loaded.granularity, this.timezones.platformTz);
    }
    const dataType = await this.inferBaseEventDataType(loaded.targetProp, context);
    const expr = await this.resolveBaseEventProperty(loaded.targetProp, dataType, context);
    return this.qualifySaEventsExpr(expr);
  }

  private qualifySaEventsExpr(expr: string): string {
    if (expr.includes('sa_events.')) return expr;
    if (expr.includes('(properties,')) {
      return expr.replace('(properties,', '(sa_events.properties,');
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr)) {
      return `sa_events.${expr}`;
    }
    return expr;
  }

  private async loadDatatableDimension(
    project: string,
    dim: { targetProp: string; fieldKey: string },
  ): Promise<LoadedDatatableDimension> {
    const prop = `${dim.targetProp}@${dim.fieldKey}`;
    const bindings = await this.prisma.metaDatatableBinding.findMany({
      where: { project_name: project, target_prop: dim.targetProp, status: 'active' },
    });
    if (bindings.length === 0) {
      throw badRequest({
        code: 'shared.attribute.datatableStale',
        messageKey: 'errors:attribute.datatableStale',
        params: { prop },
        message: `属性 ${prop} 依赖的数据表已失效`,
      });
    }
    const tables = await this.prisma.metaDatatable.findMany({
      where: {
        id: { in: bindings.map((binding) => binding.datatable_id) },
        project_name: project,
        status: { not: 'deleted' },
      },
    });
    const tableById = new Map(tables.map((table) => [table.id, table]));
    const live = bindings.filter((binding) => tableById.has(binding.datatable_id));
    if (live.length === 0) {
      throw badRequest({
        code: 'shared.attribute.datatableStale',
        messageKey: 'errors:attribute.datatableStale',
        params: { prop },
        message: `属性 ${prop} 依赖的数据表已失效`,
      });
    }
    const columns = await this.prisma.metaDatatableColumn.findMany({
      where: { datatable_id: { in: live.map((binding) => binding.datatable_id) } },
      orderBy: { sort_order: 'asc' },
    });
    const colsByTable = new Map<string, typeof columns>();
    for (const column of columns) {
      const list = colsByTable.get(column.datatable_id) ?? [];
      list.push(column);
      colsByTable.set(column.datatable_id, list);
    }
    const matches: LoadedDatatableDimension[] = [];
    for (const binding of live) {
      const cols = colsByTable.get(binding.datatable_id) ?? [];
      const column = cols.find((item) => item.field_key === dim.fieldKey);
      if (!column) continue;
      const table = tableById.get(binding.datatable_id);
      if (!table) continue;
      const primaryField = cols.find((item) => item.is_primary)?.field_key || cols[0]?.field_key;
      if (!primaryField) continue;
      matches.push({
        tableId: binding.datatable_id,
        version: table.active_version,
        keyColumn: binding.key_column || primaryField,
        primaryField,
        fieldKey: dim.fieldKey,
        dataType: column.data_type,
        targetType: binding.target_type,
        granularity: binding.granularity,
        targetProp: binding.target_prop,
      });
    }
    if (matches.length === 0) {
      throw badRequest({
        code: 'shared.attribute.datatableStale',
        messageKey: 'errors:attribute.datatableStale',
        params: { prop },
        message: `属性 ${prop} 依赖的数据表已失效`,
      });
    }
    if (matches.length > 1) {
      throw badRequest({
        code: 'shared.attribute.datatableMultiple',
        messageKey: 'errors:attribute.datatableMultiple',
        params: { prop },
        message: `属性 ${prop} 绑定了多张数据表`,
      });
    }
    return matches[0];
  }

  private async findVirtualProperty(prop: string, projectName: string, eventKey?: string) {
    // 优先匹配事件专属虚拟属性
    if (eventKey) {
      const eventSpecific = await this.prisma.metaVirtualProperty.findFirst({
        where: {
          project_name: projectName,
          prop_key: prop,
          event_key: eventKey,
        },
      });
      if (eventSpecific) return eventSpecific;
    }

    return this.prisma.metaVirtualProperty.findFirst({
      where: {
        project_name: projectName,
        prop_key: prop,
        event_key: null,
      },
    });
  }
}
