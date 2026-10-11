import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { SYSTEM_COLUMNS } from './system-columns';
import { tagValuesFromDefinition } from './sql-tag-filter';
import type { DataScope, FieldScope } from '../iam/iam.types';

/**
 * 元数据字典聚合服务（自定义 SQL 分析的数据发现）。
 * 一次性返回事件 / 事件属性 / 用户属性 / 系统字段。
 */
@Injectable()
export class SchemaService {
  constructor(private readonly prisma: PrismaService) {}


  async getSchema(project: string, scope?: DataScope) {
    const [events, eventAttributes, eventProperties, userProperties, cohorts, tags] = await Promise.all([
      this.prisma.metaEvent.findMany({
        where: { project_name: project, status: { not: 'hidden' } },
        select: { event_key: true, display_name: true },
        orderBy: { event_key: 'asc' },
      }),
      // 全局事件属性（含 event_count，无样例值）
      this.prisma.metaEventAttribute.findMany({
        where: { project_name: project, status: { not: 'hidden' } },
        select: { prop_key: true, data_type: true, event_count: true },
        orderBy: { prop_key: 'asc' },
      }),
      // 事件属性明细（含 sample_value，按 prop_key 去重取样例）
      this.prisma.metaEventProperty.findMany({
        where: { project_name: project, status: { not: 'hidden' }, sample_value: { not: null } },
        select: { prop_key: true, data_type: true, sample_value: true, materialized_column: true },
        orderBy: { prop_key: 'asc' },
      }),
      this.prisma.metaUserProperty.findMany({
        where: { project_name: project, status: { not: 'hidden' } },
        select: { prop_key: true, data_type: true, materialized_column: true },
        orderBy: { prop_key: 'asc' },
      }),
      this.prisma.metaUserCohort.findMany({
        where: { project_name: project, status: 'ready' },
        select: {
          cohort_id: true,
          name: true,
          display_name: true,
          batch_id: true,
          member_count: true,
          subject_id: true,
        },
        orderBy: { display_name: 'asc' },
      }),
      this.prisma.metaUserTag.findMany({
        where: { project_name: project, status: 'ready' },
        select: {
          tag_id: true,
          name: true,
          display_name: true,
          batch_id: true,
          member_count: true,
          definition_json: true,
          subject_id: true,
        },
        orderBy: { display_name: 'asc' },
      }),
    ]);

    // 事件属性：以全局属性为准，样例值从明细去重补充
    const sampleMap = new Map<string, string>();
    const materializedMap = new Map<string, string>();
    for (const p of eventProperties) {
      if (!sampleMap.has(p.prop_key) && p.sample_value) sampleMap.set(p.prop_key, p.sample_value);
      if (!materializedMap.has(p.prop_key) && p.materialized_column) {
        materializedMap.set(p.prop_key, p.materialized_column);
      }
    }

    return {
      events: events
        .filter((e) => inScope(scope?.events, e.event_key))
        .map((e) => ({
          event_key: e.event_key,
          display_name: e.display_name ?? e.event_key,
        })),
      event_properties: eventAttributes
        .filter((p) => inScope(scope?.event_properties, p.prop_key))
        .map((p) => ({
        prop_key: p.prop_key,
        data_type: p.data_type,
        sample_value: this.mask(sampleMap.get(p.prop_key) ?? null, p.data_type),
        event_count: p.event_count,
        materialized: materializedMap.get(p.prop_key) ?? null,
      })),
      user_properties: userProperties
        .filter((p) => inScope(scope?.user_properties, p.prop_key))
        .map((p) => ({
        prop_key: p.prop_key,
        data_type: p.data_type,
        sample_value: null, // MetaUserProperty 无样例值
        materialized: p.materialized_column ?? null,
      })),
      system_columns: SYSTEM_COLUMNS,
      cohorts: cohorts.map((c) => ({
        cohort_id: c.cohort_id,
        name: c.name,
        display_name: c.display_name,
        batch_id: c.batch_id,
        member_count: c.member_count,
        subject_id: c.subject_id,
      })),
      tags: tags.map((t) => ({
        tag_id: t.tag_id,
        name: t.name,
        display_name: t.display_name,
        batch_id: t.batch_id,
        member_count: t.member_count,
        values: tagValuesFromDefinition(t.definition_json),
        subject_id: t.subject_id,
      })),
    };
  }

  /** 样例值脱敏：手机号/邮箱/身份证/地址等敏感字段掩码 */
  private mask(value: string | null, dataType: string): string | null {
    if (!value) return null;
    // 手机号 138****0000
    if (/^1[3-9]\d{9}$/.test(value)) return `${value.slice(0, 3)}****${value.slice(-4)}`;
    // 邮箱 a***@x.com
    if (/^[^@]+@[^@]+$/.test(value)) {
      const [local, domain] = value.split('@');
      return `${local.slice(0, 1)}***@${domain}`;
    }
    // 身份证
    if (/^\d{17}[\dXx]$/.test(value)) return `${value.slice(0, 3)}********${value.slice(-4)}`;
    return value;
  }
}

function inScope(field: FieldScope | undefined, key: string): boolean {
  if (!field || field.mode === 'all') return true;
  return field.keys.includes(key);
}
