import { Injectable } from '@nestjs/common';
import { nanoid } from 'nanoid';
import { badRequest, conflict, notFound } from '../../i18n/domain-error';
import {
  PRESET_SUBJECT_DISPLAY,
  PRESET_SUBJECT_NAME,
  parseSubjectSource,
  validateSubjectName,
} from './subject-definition';
import { subjectExpr, type ResolvedSubject } from './subject-expr';
import { SubjectRepository } from './subject.repository';
import { CreateSubjectDto, UpdateSubjectDto } from './dto/subject.dto';

@Injectable()
export class SubjectService {
  constructor(private readonly repository: SubjectRepository) {}

  async list(project: string) {
    await this.ensurePreset(project);
    const items = await this.repository.list(project);
    return items.map((item) => this.toResponse(item));
  }

  async get(subjectId: string, project: string) {
    await this.ensurePreset(project);
    const item = await this.repository.findById(subjectId, project);
    if (!item) {
      throw notFound({
        code: 'subject.notFound',
        messageKey: 'cohort:error.subject.notFound',
        message: '分析主体不存在',
      });
    }
    return this.toResponse(item);
  }

  async create(project: string, dto: CreateSubjectDto) {
    await this.ensurePreset(project);
    const name = validateSubjectName(dto.name);
    const existing = await this.repository.findByName(name, project);
    if (existing) {
      throw badRequest({
        code: 'subject.nameExists',
        messageKey: 'cohort:error.subject.nameExists',
        message: '主体名已存在',
      });
    }
    const source = parseSubjectSource(dto.source);
    const created = await this.repository.create({
      subject_id: `asub_${nanoid(10)}`,
      project_name: project,
      name,
      display_name: dto.display_name.trim(),
      kind: 'property',
      source_json: JSON.stringify(source),
      sort_order: 100,
      is_preset: false,
    });
    return this.toResponse(created);
  }

  async update(subjectId: string, project: string, dto: UpdateSubjectDto) {
    const existing = await this.repository.findById(subjectId, project);
    if (!existing) {
      throw notFound({
        code: 'subject.notFound',
        messageKey: 'cohort:error.subject.notFound',
        message: '分析主体不存在',
      });
    }
    if (existing.is_preset && dto.source) {
      throw badRequest({
        code: 'subject.presetSourceImmutable',
        messageKey: 'cohort:error.subject.presetSourceImmutable',
        message: '预置主体不可改来源',
      });
    }
    let sourceJson: string | undefined;
    if (dto.source) sourceJson = JSON.stringify(parseSubjectSource(dto.source));
    await this.repository.update(subjectId, project, {
      display_name: dto.display_name?.trim(),
      source_json: sourceJson,
    });
    return this.get(subjectId, project);
  }

  async remove(subjectId: string, project: string) {
    const existing = await this.repository.findById(subjectId, project);
    if (!existing) {
      throw notFound({
        code: 'subject.notFound',
        messageKey: 'cohort:error.subject.notFound',
        message: '分析主体不存在',
      });
    }
    if (existing.is_preset) {
      throw badRequest({
        code: 'subject.presetDeleteForbidden',
        messageKey: 'cohort:error.subject.presetDeleteForbidden',
        message: '预置主体不可删除',
      });
    }
    const [cohorts, tags, cards] = await Promise.all([
      this.repository.countCohorts(project, subjectId),
      this.repository.countTags(project, subjectId),
      this.repository.findCardsReferencing(project, subjectId),
    ]);
    if (cohorts > 0 || tags > 0 || cards.length > 0) {
      const names = cards.map((card) => card.name).filter(Boolean).join('、');
      throw conflict({
        code: 'subject.assetReferenced',
        messageKey: 'cohort:error.subject.assetReferenced',
        params: { names: cards.map((card) => card.name).filter(Boolean).join(', ') },
        message: `主体已被分群/标签/卡片引用${names ? `：${names}` : ''}。请先改资产再删除。`,
      });
    }
    await this.repository.delete(subjectId, project);
    return { success: true };
  }

  async sort(project: string, ids: string[]) {
    await this.ensurePreset(project);
    const items = await this.repository.list(project);
    const allowed = new Set(items.map((item) => item.subject_id));
    const ordered = ids.filter((id) => allowed.has(id));
    for (const item of items) {
      if (!ordered.includes(item.subject_id)) ordered.push(item.subject_id);
    }
    await Promise.all(
      ordered.map((id, index) => this.repository.update(id, project, { sort_order: index })),
    );
    return this.list(project);
  }

  async ensurePreset(project: string) {
    const existing = await this.repository.findByName(PRESET_SUBJECT_NAME, project);
    const preset =
      existing ??
      (await this.repository.create({
        subject_id: `asub_${nanoid(10)}`,
        project_name: project,
        name: PRESET_SUBJECT_NAME,
        display_name: PRESET_SUBJECT_DISPLAY,
        kind: 'preset',
        is_preset: true,
        sort_order: 0,
      }));
    await Promise.all([
      this.repository.backfillEmptyCohorts(project, preset.subject_id),
      this.repository.backfillEmptyTags(project, preset.subject_id),
    ]);
    return preset;
  }

  async resolve(project: string, subjectId?: string | null): Promise<ResolvedSubject> {
    const preset = await this.ensurePreset(project);
    const id = subjectId?.trim();
    if (!id || id === preset.subject_id) {
      return { subject_id: preset.subject_id, kind: 'preset' };
    }
    const row = await this.repository.findById(id, project);
    if (!row) {
      throw badRequest({
        code: 'subject.notFound',
        messageKey: 'cohort:error.subject.notFound',
        message: '分析主体不存在',
      });
    }
    if (row.kind === 'preset' || row.is_preset) {
      return { subject_id: row.subject_id, kind: 'preset' };
    }
    const source = parseSubjectSource(row.source_json ? JSON.parse(row.source_json) : null);
    const columnRow =
      source.scope === 'event'
        ? await this.repository.findEventMaterializedColumn(project, source.prop)
        : await this.repository.findUserMaterializedColumn(project, source.prop);
    return {
      subject_id: row.subject_id,
      kind: 'property',
      source: { ...source, column: columnRow?.materialized_column ?? null },
    };
  }

  /**
   * 主体 ID 表达式（`sa_events` 语境）。
   *
   * 用户属性主体需要注入 `LEFT JOIN sa_user_profiles`；本方法的调用方是自定义 SQL
   * 报表，无法向用户手写 SQL 注入 JOIN，因此**显式拒绝**而不是产出不可执行的 SQL。
   */
  async expr(project: string, subjectId?: string | null): Promise<string> {
    const resolved = await this.resolve(project, subjectId);
    if (resolved.kind === 'property' && resolved.source?.scope === 'user') {
      throw badRequest({
        code: 'subject.userPropUnsupportedInSql',
        messageKey: 'cohort:error.subject.userPropUnsupportedInSql',
        message: '自定义 SQL 报表暂不支持「用户属性」分析主体（无法向手写 SQL 注入跨表 JOIN），请改用预置主体或事件属性主体',
      });
    }
    return subjectExpr(resolved);
  }

  private toResponse(item: {
    subject_id: string;
    project_name: string;
    name: string;
    display_name: string;
    kind: string;
    source_json: string | null;
    sort_order: number;
    is_preset: boolean;
    created_at: Date;
    updated_at: Date;
  }) {
    return {
      ...item,
      source: item.source_json ? (JSON.parse(item.source_json) as Record<string, unknown>) : null,
    };
  }
}
