import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { nanoid } from 'nanoid';
import { badRequest, conflict, domainError } from '../../i18n/domain-error';
import { CohortComputeService } from './cohort-compute.service';
import {
  CohortKind,
  SQL_COHORT_PREVIEW_LIMIT,
  SqlDefinition,
  assertNegativeUniverseSupported,
  normalizeSchedule,
  cohortNotFound,
  computeDay,
  validateCohortName,
  validateDefinition,
} from './cohort-definition';
import { CohortMembersService } from './cohort-members.service';
import { CohortPreviewService } from './cohort-preview.service';
import { CohortRepository } from './cohort.repository';
import { CohortSqlService } from './cohort-sql.service';
import { SubjectService } from '../subject/subject.service';
import { TimezoneService } from '../time/timezone.service';
import { ProjectTimeRegistry } from '../time/project-time-registry';
import { CreateCohortDto, CreateResultCohortDto, PreviewConditionCohortDto, PreviewResultCohortDto, PreviewSqlCohortDto, UpdateCohortDto } from './dto/cohort.dto';

const PROJECT_LIMIT = 200;

@Injectable()
export class CohortService {
  constructor(
    private readonly repository: CohortRepository,
    private readonly compute: CohortComputeService,
    private readonly members: CohortMembersService,
    private readonly sql: CohortSqlService,
    private readonly previews: CohortPreviewService,
    private readonly subjects: SubjectService,
    private readonly timezones: TimezoneService,
    @Optional() private readonly projectTimes?: ProjectTimeRegistry,
  ) {}

  async list(project: string, keyword?: string, status?: string, subjectId?: string) {
    if (status === 'ready') {
      const preset = await this.subjects.ensurePreset(project);
      const includeEmpty = !subjectId || subjectId === preset.subject_id;
      const items = await this.repository.listReady(project, subjectId, includeEmpty);
      return items.map((item) => this.toResponse(item));
    }
    const items = await this.repository.list(project, keyword);
    return items.map((item) => this.toResponse(item));
  }

  async get(cohortId: string, project: string) {
    const item = await this.repository.findById(cohortId, project);
    if (!item) {
      throw cohortNotFound();
    }
    return this.toResponse(item);
  }

  async create(project: string, owner: string, dto: CreateCohortDto, csvText?: string) {
    const count = await this.repository.count(project);
    if (count >= PROJECT_LIMIT) {
      throw badRequest({
        code: 'cohort.projectLimit',
        messageKey: 'cohort:error.cohort.projectLimit',
        params: { max: PROJECT_LIMIT },
        message: `每个项目最多 ${PROJECT_LIMIT} 个分群`,
      });
    }
    const name = validateCohortName(dto.name);
    const existing = await this.repository.findByName(name, project);
    if (existing) {
      throw badRequest({
        code: 'cohort.nameExists',
        messageKey: 'cohort:error.cohort.nameExists',
        message: '分群名已存在',
      });
    }
    const kind = dto.kind as CohortKind;
    if (kind !== 'condition' && kind !== 'id_upload' && kind !== 'sql') {
      throw badRequest({
        code: 'cohort.resultEntryRequired',
        messageKey: 'cohort:error.cohort.resultEntryRequired',
        message: '请用结果分群入口保存分析结果',
      });
    }
    const definition = validateDefinition(kind, dto.definition_json ?? (kind === 'id_upload' ? { match: 'uid' } : undefined));
    const resolved = await this.subjects.resolve(project, dto.subject_id);
    if (kind === 'condition') {
      assertNegativeUniverseSupported(resolved, (definition as { conditions?: unknown }).conditions);
    }
    const created = await this.repository.create({
      cohort_id: `cohort_${nanoid(10)}`,
      project_name: project,
      owner,
      name,
      display_name: dto.display_name.trim(),
      remark: dto.remark?.trim() || undefined,
      kind,
      definition_json: JSON.stringify(definition),
      schedule: normalizeSchedule(kind, dto.schedule),
      status: 'pending',
      subject_id: resolved.subject_id,
    });
    if (kind === 'id_upload') {
      const csv = csvText || dto.csv_text;
      if (!csv) {
        throw badRequest({
          code: 'cohort.csvRequired',
          messageKey: 'cohort:error.cohort.csvRequired',
          message: '请上传 CSV',
        });
      }
      await this.compute.computeIdUpload(created.cohort_id, project, csv);
      return this.get(created.cohort_id, project);
    }
    this.compute.enqueue(created.cohort_id, project);
    return this.toResponse(created);
  }

  async createFromResult(project: string, owner: string, dto: CreateResultCohortDto) {
    const count = await this.repository.count(project);
    if (count >= PROJECT_LIMIT) {
      throw badRequest({
        code: 'cohort.projectLimit',
        messageKey: 'cohort:error.cohort.projectLimit',
        params: { max: PROJECT_LIMIT },
        message: `每个项目最多 ${PROJECT_LIMIT} 个分群`,
      });
    }
    const name = validateCohortName(dto.name);
    const existing = await this.repository.findByName(name, project);
    if (existing) {
      throw badRequest({
        code: 'cohort.nameExists',
        messageKey: 'cohort:error.cohort.nameExists',
        message: '分群名已存在',
      });
    }
    const definition = validateDefinition('result', {
      source: dto.source,
      dsl: dto.dsl,
      cell: dto.cell,
    });
    const subjectId =
      dto.subject_id ||
      (typeof dto.dsl.subject_id === 'string' ? dto.dsl.subject_id : undefined);
    const resolved = await this.subjects.resolve(project, subjectId);
    const created = await this.repository.create({
      cohort_id: `cohort_${nanoid(10)}`,
      project_name: project,
      owner,
      name,
      display_name: dto.display_name.trim(),
      remark: dto.remark?.trim() || undefined,
      kind: 'result',
      definition_json: JSON.stringify(definition),
      schedule: 'manual',
      status: 'pending',
      subject_id: resolved.subject_id,
    });
    await this.compute.materializeResult(
      created.cohort_id,
      project,
      definition as { source: 'event' | 'funnel' | 'retention'; dsl: Record<string, unknown>; cell: Record<string, unknown> },
    );
    return this.get(created.cohort_id, project);
  }

  async previewFromResult(project: string, dto: PreviewResultCohortDto) {
    const definition = validateDefinition('result', {
      source: dto.source,
      dsl: dto.dsl,
      cell: dto.cell,
    });
    const limit = Math.min(Math.max(dto.limit ?? 1000, 1), 1000);
    const uids = await this.compute.listResultUsers(
      project,
      definition as { source: 'event' | 'funnel' | 'retention'; dsl: Record<string, unknown>; cell: Record<string, unknown> },
      limit,
    );
    return { items: uids.map((uid) => ({ uid })), total: uids.length };
  }

  async update(cohortId: string, project: string, dto: UpdateCohortDto) {
    const existing = await this.repository.findById(cohortId, project);
    if (!existing) {
      throw cohortNotFound();
    }
    if (existing.kind === 'result' && dto.definition_json) {
      throw badRequest({
        code: 'cohort.resultDefinitionImmutable',
        messageKey: 'cohort:error.cohort.resultDefinitionImmutable',
        message: '结果分群不能改圈人规则',
      });
    }
    let definitionJson: string | undefined;
    let shouldRecompute = false;
    if (dto.definition_json && (existing.kind === 'condition' || existing.kind === 'sql')) {
      definitionJson = JSON.stringify(validateDefinition(existing.kind as CohortKind, dto.definition_json));
      shouldRecompute = definitionJson !== existing.definition_json;
    }
    const schedule = dto.schedule
      ? normalizeSchedule(existing.kind as CohortKind, dto.schedule)
      : undefined;
    await this.repository.update(cohortId, project, {
      display_name: dto.display_name?.trim(),
      remark: dto.remark,
      definition_json: definitionJson,
      schedule,
    });
    if (shouldRecompute) this.compute.enqueue(cohortId, project);
    return this.get(cohortId, project);
  }

  async setLocked(cohortId: string, project: string, locked: boolean) {
    const existing = await this.repository.findById(cohortId, project);
    if (!existing) {
      throw cohortNotFound();
    }
    await this.repository.update(cohortId, project, { locked });
    return this.get(cohortId, project);
  }

  async remove(cohortId: string, project: string, force = false) {
    const existing = await this.repository.findById(cohortId, project);
    if (!existing) {
      throw cohortNotFound();
    }
    const cards = await this.repository.findCardsReferencing(project, cohortId);
    const dashboards = await this.repository.findDashboardsReferencing(project, cohortId);
    const names = [...cards.map((card) => card.name), ...dashboards.map((item) => item.name)]
      .filter(Boolean)
      .join('、');
    if ((cards.length > 0 || dashboards.length > 0) && !force) {
      throw conflict({
        code: 'cohort.cardReferenced',
        messageKey: 'cohort:error.cohort.cardReferenced',
        params: {
          names: [...cards.map((card) => card.name), ...dashboards.map((item) => item.name)]
            .filter(Boolean)
            .join(', '),
        },
        message: `分群已被引用${names ? `：${names}` : ''}。删除后这些地方的分群筛选会失效。`,
      });
    }
    await this.members.deleteBatch(project, cohortId, existing.batch_id);
    await this.repository.delete(cohortId, project);
    return { success: true };
  }

  async refresh(cohortId: string, project: string) {
    const existing = await this.repository.findById(cohortId, project);
    if (!existing) {
      throw cohortNotFound();
    }
    if (existing.kind !== 'condition' && existing.kind !== 'sql') {
      throw domainError(HttpStatus.METHOD_NOT_ALLOWED, {
        code: 'cohort.manualRefreshUnsupported',
        messageKey: 'cohort:error.cohort.manualRefreshUnsupported',
        message: '仅条件分群与 SQL 分群可手动刷新',
      });
    }
    this.compute.enqueue(cohortId, project);
    return this.get(cohortId, project);
  }

  async membersPreview(cohortId: string, project: string, limit = 1000, keyword?: string) {
    const existing = await this.repository.findById(cohortId, project);
    if (!existing) {
      throw cohortNotFound();
    }
    const capped = Math.min(Math.max(limit, 1), 1000);
    const search = keyword?.trim() || undefined;
    if (!existing.batch_id) return { items: [], total: existing.member_count, keyword: search, truncated: false };
    const items = await this.members.preview(project, cohortId, existing.batch_id, capped, search);
    return { items, total: existing.member_count, keyword: search, truncated: items.length >= capped };
  }

  /** 条件分群试跑：只读，不落成员表、不改状态（实现见 CohortPreviewService） */
  previewCondition(project: string, dto: PreviewConditionCohortDto) {
    return this.previews.previewCondition(project, dto.definition_json, dto.subject_id, dto.limit);
  }

  /**
   * ID 分群重传名单（整体替换）。
   *
   * 失败时保持上一批成员：`computeIdUpload` 先解析后写新批，只有成功才切 `batch_id`，
   * 这里也不把状态改成 `failed`（重传是一次用户动作，不该把在用的分群标红）。
   */
  async replaceMembers(cohortId: string, project: string, csvText: string) {
    const existing = await this.repository.findById(cohortId, project);
    if (!existing) {
      throw cohortNotFound();
    }
    if (existing.kind !== 'id_upload') {
      throw badRequest({
        code: 'cohort.idUpload.onlyIdUpload',
        messageKey: 'cohort:error.idUpload.onlyIdUpload',
      });
    }
    await this.compute.computeIdUpload(cohortId, project, csvText);
    return this.get(cohortId, project);
  }

  async previewSql(project: string, dto: PreviewSqlCohortDto, cohortId?: string) {
    let definition: SqlDefinition;
    if (cohortId && !dto.definition_json) {
      const existing = await this.repository.findById(cohortId, project);
      if (!existing) {
        throw cohortNotFound();
      }
      if (existing.kind !== 'sql') {
        throw badRequest({
          code: 'cohort.sqlPreviewUnsupported',
          messageKey: 'cohort:error.cohort.sqlPreviewUnsupported',
          message: '仅 SQL 分群可试跑',
        });
      }
      definition = validateDefinition('sql', JSON.parse(existing.definition_json)) as unknown as SqlDefinition;
    } else {
      definition = validateDefinition('sql', dto.definition_json) as unknown as SqlDefinition;
    }
    const limit = Math.min(Math.max(dto.limit ?? SQL_COHORT_PREVIEW_LIMIT, 1), SQL_COHORT_PREVIEW_LIMIT);
    const result = await this.sql.preview(project, definition, computeDay(this.projectTimes?.timeZoneOf(project, this.timezones.platformTz) ?? this.timezones.platformTz), limit);
    return {
      items: result.uids.map((uid) => ({ uid })),
      total: result.uids.length,
      truncated: result.uids.length >= limit,
    };
  }

  templateCsv() {
    return { filename: 'cohort_uid_template.csv', content: 'uid\n' };
  }

  private toResponse(item: {
    cohort_id: string;
    project_name: string;
    owner: string;
    name: string;
    display_name: string;
    remark: string | null;
    kind: string;
    definition_json: string;
    schedule: string;
    status: string;
    member_count: number;
    batch_id: string;
    last_computed_at: Date | null;
    compute_error: string | null;
    subject_id?: string;
    created_at: Date;
    updated_at: Date;
  }) {
    return {
      ...item,
      definition_json: JSON.parse(item.definition_json) as Record<string, unknown>,
    };
  }
}
