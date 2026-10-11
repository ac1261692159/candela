import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { nanoid } from 'nanoid';
import { badRequest, forbidden, notFound, type DomainErrorInput } from '../../i18n/domain-error';
import { MetaSavedMetricRepository } from './meta-saved-metric.repository';
import { CreateSavedMetricDto, UpdateSavedMetricDto } from './dto/meta-saved-metric.dto';
import { mergeMetricDefinition } from './metric-definition-merge';
import { PrismaService } from '../shared/prisma.service';
import { validateMetricTimeRange, validateRetentionWindow } from '../query/metric-window';
import { VALUE_PICKS } from '../query/metric-value-pick';
import { isNoopTransform, resolveTransform, validateTransform } from '../query/metric-transform';
import type { MetricTransform } from '../../types/dsl.types';
import type { IamContext } from '../iam/iam.types';

@Injectable()
export class MetaSavedMetricService {
  private readonly logger = new Logger(MetaSavedMetricService.name);

  constructor(
    private readonly repository: MetaSavedMetricRepository,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 指标口径变更审计（PRD AC-12）：写 ops_action_log，action 以 `alert_` 开头以便出现在
   * 运维 → 监控告警 → 变更记录里（与规则/联系人变更同一条时间线）。审计失败不影响业务。
   */
  private async audit(
    action: string,
    detail: Record<string, unknown>,
    operator: string,
  ): Promise<void> {
    try {
      await this.prisma.opsActionLog.create({
        data: { action, target_table: 'metasavedmetric', detail: detail as object, status: 'done', operator },
      });
    } catch (error) {
      this.logger.warn(`指标审计写入失败 [${action}]: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 口径字段摊平成可比对的一层，用于「字段：旧 → 新」审计 */
  private static flatDefinition(definition: Record<string, unknown>): Record<string, unknown> {
    const metric = (definition?.metric ?? {}) as Record<string, unknown>;
    const relative = (metric.time_range as { relative?: unknown } | undefined)?.relative;
    return {
      event: metric.event ?? null,
      analysis: metric.analysis ?? metric.type ?? null,
      prop: metric.prop ?? null,
      percentile: metric.percentile ?? null,
      value_pick: metric.value_pick ?? null,
      time_range: relative ? JSON.stringify(relative) : null,
      transform: metric.transform ? JSON.stringify(metric.transform) : null,
      filters: metric.filters ? JSON.stringify(metric.filters).slice(0, 200) : null,
      subject_id: metric.subject_id ?? null,
    };
  }

  private static changesOf(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Record<string, { from: unknown; to: unknown }> {
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [field, to] of Object.entries(after)) {
      const from = before[field];
      if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) {
        changes[field] = { from: from ?? null, to: to ?? null };
      }
    }
    return changes;
  }

  async list(projectName: string, kind?: string) {
    const items = await this.repository.list(projectName, kind);
    return items.map((item) => this.toResponse(item));
  }

  async get(metricId: string, projectName: string) {
    const item = await this.repository.findById(metricId, projectName);
    if (!item) {
      throw notFound({
        code: 'meta.metric.notFound',
        messageKey: 'meta:error.metric.notFound',
        message: '指标不存在',
      });
    }
    return this.toResponse(item);
  }

  async create(projectName: string, owner: string, dto: CreateSavedMetricDto) {
    const definition = this.normalizeDefinition(dto.kind, dto.definition_json);
    const existing = await this.repository.findByName(dto.name, projectName);
    if (existing) {
      throw badRequest({
        code: 'meta.metric.nameExists',
        messageKey: 'meta:error.metric.nameExists',
        message: '指标名已存在',
      });
    }
    const created = await this.repository.create({
      metric_id: `metric_${nanoid(10)}`,
      project_name: projectName,
      owner,
      name: dto.name,
      display_name: dto.display_name.trim(),
      remark: dto.remark?.trim() || undefined,
      kind: dto.kind,
      definition_json: JSON.stringify(definition),
      format: dto.format ?? (dto.kind === 'retention' && (definition as { measure?: string }).measure === 'rate'
        ? 'percent'
        : 'number'),
    });
    await this.audit(
      'alert_metric_create',
      { metric_id: created.metric_id, name: created.name, kind: created.kind },
      owner,
    );
    return this.toResponse(created);
  }

  async update(
    metricId: string,
    projectName: string,
    dto: UpdateSavedMetricDto,
    userId: string,
    iam: IamContext,
  ) {
    const existing = await this.repository.findById(metricId, projectName);
    if (!existing) {
      throw notFound({
        code: 'meta.metric.notFound',
        messageKey: 'meta:error.metric.notFound',
        message: '指标不存在',
      });
    }
    this.assertCanWrite(existing.owner, userId, iam);
    // 先与已存定义合并再规范化：只改部分字段时，未提供的 filters/alias 等不会被清掉（见 metric-definition-merge.ts）
    const storedDefinition = this.parseStoredDefinition(existing.definition_json);
    const definition = dto.definition_json
      ? this.normalizeDefinition(
          existing.kind,
          mergeMetricDefinition(existing.kind, storedDefinition, dto.definition_json),
        )
      : undefined;
    await this.repository.update(metricId, projectName, {
      display_name: dto.display_name?.trim(),
      remark: dto.remark,
      definition_json: definition ? JSON.stringify(definition) : undefined,
      format: dto.format,
    });
    const beforeFlat = MetaSavedMetricService.flatDefinition(this.parseStoredDefinition(existing.definition_json));
    const afterDefinition = definition ?? storedDefinition;
    const changes = {
      ...MetaSavedMetricService.changesOf(
        { display_name: existing.display_name, format: existing.format, remark: existing.remark ?? null },
        {
          display_name: dto.display_name?.trim() ?? existing.display_name,
          format: dto.format ?? existing.format,
          remark: dto.remark ?? existing.remark ?? null,
        },
      ),
      ...(definition ? MetaSavedMetricService.changesOf(beforeFlat, MetaSavedMetricService.flatDefinition(afterDefinition)) : {}),
    };
    if (Object.keys(changes).length > 0) {
      await this.audit(
        'alert_metric_update',
        { metric_id: metricId, name: existing.name, changes },
        userId,
      );
    }
    return this.get(metricId, projectName);
  }

  async delete(metricId: string, projectName: string, userId: string, iam: IamContext) {
    const existing = await this.repository.findById(metricId, projectName);
    if (!existing) {
      throw notFound({
        code: 'meta.metric.notFound',
        messageKey: 'meta:error.metric.notFound',
        message: '指标不存在',
      });
    }
    this.assertCanWrite(existing.owner, userId, iam);
    await this.repository.delete(metricId, projectName);
    await this.audit('alert_metric_delete', { metric_id: metricId, name: existing.name }, userId);
    return { success: true };
  }

  /**
   * 指标写入口的唯一归属判定（rbac-v3 §6）：本人指标放行，否则要求 `metric.edit_others`
   * （owner / 分析管理员默认持有）。指标不走锁定与编辑授权，故不复用 AssetPolicy。
   */
  private assertCanWrite(owner: string, userId: string, iam: IamContext): void {
    if (owner === userId || iam.permissions.has('metric.edit_others')) return;
    throw forbidden({
      code: 'meta.metric.notOwner',
      messageKey: 'meta:error.metric.notOwner',
      message: '只能修改或删除自己的指标',
    });
  }

  private parseStoredDefinition(json: string | null | undefined): Record<string, unknown> {
    if (!json) return {};
    try {
      const parsed = JSON.parse(json) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  normalizeDefinition(kind: string, raw: Record<string, unknown>) {
    if (kind === 'event') {
      const metric = raw.metric && typeof raw.metric === 'object' ? (raw.metric as Record<string, unknown>) : raw;
      if (!metric || metric.kind === 'formula') {
        throw badRequest({
          code: 'meta.metric.eventFormulaNotAllowed',
          messageKey: 'meta:error.metric.eventFormulaNotAllowed',
          message: '事件指标不能是公式',
        });
      }
      if (!metric.analysis && !metric.type) {
        throw badRequest({
          code: 'meta.metric.analysisRequired',
          messageKey: 'meta:error.metric.analysisRequired',
          message: '事件指标缺少计算方法',
        });
      }
      // 事件为空的事件指标无法求值（告警侧会判为「不可告警」，分析里也查不出东西），
      // 因此在这里挡住——2026-09-15 验收实测到 API 允许保存（界面因为必填不会触发）
      const eventKey = typeof metric.event === 'string' ? metric.event.trim() : '';
      if (!eventKey) {
        throw badRequest({
          code: 'meta.metric.eventRequired',
          messageKey: 'meta:error.metric.eventRequired',
          message: '事件指标缺少事件',
        });
      }
      // v2：白名单补 transform / value_pick / time_range / subject_id——
      // 缺失这四个字段会导致「分析页看到的数与指标值不一致」（数值变换、取值口径被静默丢弃）
      const valuePickError = validateValuePick(metric.value_pick);
      if (valuePickError) throw badRequest(valuePickError);
      const timeRangeError = validateMetricTimeRange(metric.time_range);
      if (timeRangeError) {
        throw badRequest({
          code: 'meta.metric.timeRangeInvalid',
          messageKey: 'meta:error.metric.timeRangeInvalid',
          params: { reason: timeRangeError },
          message: timeRangeError,
        });
      }
      const transform = normalizeTransform(metric.transform);
      // 显式清空（null）= 删掉该键：前端「取消勾选」后定义里不该残留 null
      const cleared = dropNull({
        transform,
        value_pick: metric.value_pick ?? null,
        time_range: metric.time_range ?? null,
        subject_id: metric.subject_id ?? null,
      });
      const definition: Record<string, unknown> = {
        version: 2,
        metric: dropEmpty({
          kind: 'event',
          event: eventKey,
          analysis: metric.analysis,
          prop: metric.prop,
          percentile: metric.percentile,
          filters: metric.filters,
          alias: metric.alias,
          type: metric.type,
          func: metric.func,
          transform: cleared.transform,
          value_pick: cleared.value_pick,
          time_range: cleared.time_range,
          subject_id: cleared.subject_id,
        }),
      };
      // 时间范围来自指标时记 metric，否则跟随告警规则窗口（存量指标行为不变）
      definition.time_source = (metric.time_range as { relative?: unknown } | undefined)?.relative
        ? 'metric'
        : 'rule';
      return definition;
    }
    if (kind === 'retention') {
      const start = (raw.start_event ?? raw.startEvent) as Record<string, unknown> | undefined;
      const retain = (raw.retain_event ?? raw.retainEvent ?? raw.return_event) as
        | Record<string, unknown>
        | undefined;
      const n = Number(raw.n);
      const measure = raw.measure === 'count' ? 'count' : 'rate';
      const startEvent = typeof start?.event === 'string' ? start.event : typeof raw.start_event === 'string' ? raw.start_event : '';
      const retainEvent =
        typeof retain?.event === 'string'
          ? retain.event
          : typeof raw.retain_event === 'string'
            ? raw.retain_event
            : '';
      if (!startEvent || !retainEvent) {
        throw badRequest({
          code: 'meta.metric.retentionEventsRequired',
          messageKey: 'meta:error.metric.retentionEventsRequired',
          message: '留存指标须包含初始和回访事件',
        });
      }
      if (!Number.isInteger(n) || n < 1 || n > 90) {
        throw badRequest({
          code: 'meta.metric.retentionWindowInvalid',
          messageKey: 'meta:error.metric.retentionWindowInvalid',
          message: '留存周期 n 须为 1~90 的整数',
        });
      }
      // v3：留存指标可选「队列范围」（相对范围，≥ n+1 天、≤ 180 天）；不设则沿用按周期推导
      const windowError = validateRetentionWindow(raw.time_range, n);
      if (windowError) {
        throw badRequest({
          code: 'meta.metric.retentionCohortRangeInvalid',
          messageKey: 'meta:error.metric.retentionCohortRangeInvalid',
          params: { reason: windowError },
          message: `留存指标队列范围：${windowError}`,
        });
      }
      return {
        version: 2,
        start_event: { event: startEvent, filters: start?.filters },
        retain_event: { event: retainEvent, filters: retain?.filters },
        cohort: raw.cohort === 'first_day' ? 'first_day' : 'all',
        granularity: ['week', 'month'].includes(String(raw.granularity)) ? raw.granularity : 'day',
        n,
        measure,
        ...(raw.time_range ? { time_range: raw.time_range } : {}),
      };
    }
    throw badRequest({
      code: 'meta.metric.kindUnsupported',
      messageKey: 'meta:error.metric.kindUnsupported',
      message: '不支持的指标类型',
    });
  }

  private toResponse(item: {
    metric_id: string;
    project_name: string;
    owner: string;
    name: string;
    display_name: string;
    remark: string | null;
    kind: string;
    definition_json: string;
    format: string;
    created_at: Date;
    updated_at: Date;
  }) {
    return {
      metric_id: item.metric_id,
      project_name: item.project_name,
      owner: item.owner,
      name: item.name,
      display_name: item.display_name,
      remark: item.remark,
      kind: item.kind,
      definition_json: JSON.parse(item.definition_json) as Record<string, unknown>,
      format: item.format,
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  }
}

/** 取值选择：不合法直接 400（拼错的值会让归并走错分支） */
function validateValuePick(raw: unknown): DomainErrorInput | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if ((VALUE_PICKS as readonly string[]).includes(String(raw))) return null;
  const options = VALUE_PICKS.join(' / ');
  return {
    code: 'meta.metric.valuePickInvalid',
    messageKey: 'meta:error.metric.valuePickInvalid',
    params: { options },
    message: `取值选择不合法（可选：${options}）`,
  };
}

/**
 * 数值变换（v3 四则运算）：校验与归一化共用 `metric-transform.ts`。
 * 旧定义里的 `factor` 会被升级成 `{op:'mul', value}` 写回，读取侧两种都能解释。
 */
function normalizeTransform(raw: unknown): MetricTransform | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const error = validateTransform(raw);
  if (error) throw new BadRequestException(error);
  const resolved = resolveTransform(raw as MetricTransform);
  if (isNoopTransform(resolved)) return null;
  return {
    op: resolved.op,
    value: resolved.value,
    ...(resolved.decimals === undefined ? {} : { decimals: resolved.decimals }),
  };
}

/** 去掉 undefined 的键（保留 null，用于「显式清空」语义） */
function dropEmpty(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** 把 null 视为「未设置」（保留 0 / '' 等合法值） */
function dropNull(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}
