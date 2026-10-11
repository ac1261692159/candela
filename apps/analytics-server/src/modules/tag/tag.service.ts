import { Injectable } from '@nestjs/common';
import { nanoid } from 'nanoid';
import { badRequest, conflict, notFound } from '../../i18n/domain-error';
import { TagComputeService } from './tag-compute.service';
import { normalizeTagSchedule, parseTagDefinition, TAG_PROJECT_LIMIT, validateTagName } from './tag-definition';
import { TagMembersService } from './tag-members.service';
import { TagRepository } from './tag.repository';
import { CreateTagDto, UpdateTagDto } from './dto/tag.dto';
import { SubjectService } from '../subject/subject.service';
import { conditionsUseDidNot } from '../subject/subject-definition';
import { subjectForbidsNegativeUniverse } from '../subject/subject-expr';

@Injectable()
export class TagService {
  constructor(
    private readonly repository: TagRepository,
    private readonly compute: TagComputeService,
    private readonly members: TagMembersService,
    private readonly subjects: SubjectService,
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

  async get(tagId: string, project: string) {
    const item = await this.repository.findById(tagId, project);
    if (!item) {
      throw notFound({
        code: 'tag.notFound',
        messageKey: 'cohort:error.tag.notFound',
        message: '标签不存在',
      });
    }
    return this.toResponse(item);
  }

  async create(project: string, owner: string, dto: CreateTagDto) {
    const count = await this.repository.count(project);
    if (count >= TAG_PROJECT_LIMIT) {
      throw badRequest({
        code: 'tag.projectLimit',
        messageKey: 'cohort:error.tag.projectLimit',
        params: { max: TAG_PROJECT_LIMIT },
        message: `每个项目最多 ${TAG_PROJECT_LIMIT} 个标签`,
      });
    }
    const name = validateTagName(dto.name);
    const existing = await this.repository.findByName(name, project);
    if (existing) {
      throw badRequest({
        code: 'tag.nameExists',
        messageKey: 'cohort:error.tag.nameExists',
        message: '标签名已存在',
      });
    }
    const definition = parseTagDefinition(dto.definition_json);
    const resolved = await this.subjects.resolve(project, dto.subject_id);
    if (
      subjectForbidsNegativeUniverse(resolved) &&
      definition.rules.some((rule) => conditionsUseDidNot(rule.conditions))
    ) {
      throw badRequest({
        code: 'tag.subject.didNotUnsupported',
        messageKey: 'cohort:error.subject.didNotUnsupported',
        message: '事件属性主体不能使用「没做过 / 没依次做过」',
      });
    }
    const created = await this.repository.create({
      tag_id: `tag_${nanoid(10)}`,
      project_name: project,
      owner,
      name,
      display_name: dto.display_name.trim(),
      remark: dto.remark?.trim() || undefined,
      kind: 'condition',
      definition_json: JSON.stringify(definition),
      schedule: normalizeTagSchedule(dto.schedule),
      status: 'pending',
      subject_id: resolved.subject_id,
    });
    this.compute.enqueue(created.tag_id, project);
    return this.toResponse(created);
  }

  async update(tagId: string, project: string, dto: UpdateTagDto) {
    const existing = await this.repository.findById(tagId, project);
    if (!existing) {
      throw notFound({
        code: 'tag.notFound',
        messageKey: 'cohort:error.tag.notFound',
        message: '标签不存在',
      });
    }
    let definitionJson: string | undefined;
    let shouldRecompute = false;
    if (dto.definition_json) {
      definitionJson = JSON.stringify(parseTagDefinition(dto.definition_json));
      shouldRecompute = definitionJson !== existing.definition_json;
      const parsed = parseTagDefinition(dto.definition_json);
      const resolved = await this.subjects.resolve(project, existing.subject_id);
      if (
        subjectForbidsNegativeUniverse(resolved) &&
        parsed.rules.some((rule) => conditionsUseDidNot(rule.conditions))
      ) {
        throw badRequest({
          code: 'tag.subject.didNotUnsupported',
          messageKey: 'cohort:error.subject.didNotUnsupported',
          message: '事件属性主体不能使用「没做过 / 没依次做过」',
        });
      }
    }
    await this.repository.update(tagId, project, {
      display_name: dto.display_name?.trim(),
      remark: dto.remark,
      definition_json: definitionJson,
      schedule: dto.schedule ? normalizeTagSchedule(dto.schedule) : undefined,
    });
    if (shouldRecompute) this.compute.enqueue(tagId, project);
    return this.get(tagId, project);
  }

  async setLocked(tagId: string, project: string, locked: boolean) {
    const existing = await this.repository.findById(tagId, project);
    if (!existing) {
      throw notFound({
        code: 'tag.notFound',
        messageKey: 'cohort:error.tag.notFound',
        message: '标签不存在',
      });
    }
    await this.repository.update(tagId, project, { locked });
    return this.get(tagId, project);
  }

  async remove(tagId: string, project: string, force = false) {
    const existing = await this.repository.findById(tagId, project);
    if (!existing) {
      throw notFound({
        code: 'tag.notFound',
        messageKey: 'cohort:error.tag.notFound',
        message: '标签不存在',
      });
    }
    const cards = await this.repository.findCardsReferencing(project, tagId);
    const names = cards.map((card) => card.name).filter(Boolean).join('、');
    if (cards.length > 0 && !force) {
      throw conflict({
        code: 'tag.cardReferenced',
        messageKey: 'cohort:error.tag.cardReferenced',
        params: { names: cards.map((card) => card.name).filter(Boolean).join(', ') },
        message: `标签已被卡片引用${names ? `：${names}` : ''}。删除后这些卡片里的筛选会失效。`,
      });
    }
    await this.members.deleteBatch(project, tagId, existing.batch_id);
    await this.repository.delete(tagId, project);
    return { success: true };
  }

  async refresh(tagId: string, project: string) {
    const existing = await this.repository.findById(tagId, project);
    if (!existing) {
      throw notFound({
        code: 'tag.notFound',
        messageKey: 'cohort:error.tag.notFound',
        message: '标签不存在',
      });
    }
    this.compute.enqueue(tagId, project);
    return this.get(tagId, project);
  }

  async membersPreview(tagId: string, project: string, limit = 1000) {
    const existing = await this.repository.findById(tagId, project);
    if (!existing) {
      throw notFound({
        code: 'tag.notFound',
        messageKey: 'cohort:error.tag.notFound',
        message: '标签不存在',
      });
    }
    const capped = Math.min(Math.max(limit, 1), 1000);
    if (!existing.batch_id) return { items: [], total: existing.member_count };
    const items = await this.members.preview(project, tagId, existing.batch_id, capped);
    return { items, total: existing.member_count };
  }

  private toResponse(item: {
    tag_id: string;
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
