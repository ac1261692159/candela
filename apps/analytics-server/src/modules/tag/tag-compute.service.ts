import { Injectable, Logger, Optional } from '@nestjs/common';
import { nanoid } from 'nanoid';
import {
  resolveConditionTime,
  shiftDate,
  computeDay,
  type CohortCondition,
} from '../cohort/cohort-definition';
import { CohortConditionSqlService } from '../cohort/cohort-condition-sql.service';
import { SubjectService } from '../subject/subject.service';
import { subjectExpr, subjectForbidsNegativeUniverse } from '../subject/subject-expr';
import { JoinRegistry } from '../relation/join-registry';
import { TAG_MATERIALIZE_LIMIT, type TagDefinition } from './tag-definition';
import { TagMembersService } from './tag-members.service';
import { TimezoneService } from '../time/timezone.service';
import { ProjectTimeRegistry } from '../time/project-time-registry';
import { TagRepository } from './tag.repository';

@Injectable()
export class TagComputeService {
  private readonly logger = new Logger(TagComputeService.name);
  private readonly running = new Set<string>();

  constructor(
    private readonly repository: TagRepository,
    private readonly members: TagMembersService,
    private readonly conditionSql: CohortConditionSqlService,
    private readonly subjects: SubjectService,
    private readonly timezones: TimezoneService,
    @Optional() private readonly projectTimes?: ProjectTimeRegistry,
  ) {}

  /** 项目统计日历（timezone-v2） */
  private statTzOf(project: string): string {
    return this.projectTimes?.timeZoneOf(project, this.timezones.platformTz) ?? this.timezones.platformTz;
  }

  enqueue(tagId: string, project: string) {
    setTimeout(() => {
      void this.compute(tagId, project);
    }, 0);
  }

  async compute(tagId: string, project: string) {
    if (this.running.has(tagId)) return;
    const row = await this.repository.findById(tagId, project);
    if (!row) return;
    this.running.add(tagId);
    const batchId = `b_${nanoid(10)}`;
    const oldBatch = row.batch_id;
    try {
      await this.repository.update(tagId, project, { status: 'pending', compute_error: null });
      const definition = JSON.parse(row.definition_json) as TagDefinition;
      const part = await this.buildInsertSelect(project, tagId, batchId, definition, computeDay(this.statTzOf(project)), row.subject_id);
      await this.members.insertSelect(part.sql, part.params);
      const count = await this.members.count(project, tagId, batchId);
      await this.repository.update(tagId, project, {
        status: 'ready',
        batch_id: batchId,
        member_count: count,
        last_computed_at: new Date(),
        compute_error: null,
      });
      if (oldBatch && oldBatch !== batchId) {
        await this.members.deleteBatch(project, tagId, oldBatch);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`标签 ${tagId} 计算失败: ${message}`);
      await this.repository.update(tagId, project, {
        status: 'failed',
        compute_error: message.slice(0, 1000),
      });
    } finally {
      this.running.delete(tagId);
    }
  }

  private async buildInsertSelect(
    project: string,
    tagId: string,
    batchId: string,
    definition: TagDefinition,
    computeDay: string,
    subjectId?: string,
  ) {
    const resolved = await this.subjects.resolve(project, subjectId);
    const joins = new JoinRegistry();
    const uidExpr = subjectExpr(resolved, joins);
    const forbidNegative = subjectForbidsNegativeUniverse(resolved);
    const params: Record<string, unknown> = { project, tag_id: tagId, batch_id: batchId };
    const branches: string[] = [];
    const prior: string[] = [];
    for (let i = 0; i < definition.rules.length; i++) {
      const rule = definition.rules[i];
      const set = await this.conditionSql.buildUidSet(
        project,
        rule.conditions,
        computeDay,
        `r${i}_`,
        uidExpr,
        forbidNegative,
        joins,
      );
      Object.assign(params, set.params);
      params[`r${i}_value`] = rule.value;
      const assigned = prior.length
        ? `SELECT uid FROM (${set.sql}) WHERE uid NOT IN (${prior.join(' UNION DISTINCT ')})`
        : set.sql;
      branches.push(`SELECT uid, {r${i}_value: String} AS tag_value FROM (${assigned})`);
      prior.push(`SELECT uid FROM (${set.sql})`);
    }
    if (definition.default_value) {
      const window = universeWindow(definition.rules.flatMap((rule) => rule.conditions), computeDay);
      params.u_start = window.start;
      params.u_end = window.end;
      params.default_value = definition.default_value;
      const joinsSql = joins.render().map((j) => `\n  ${j}`).join('');
      branches.push(`SELECT uid, {default_value: String} AS tag_value
FROM (
  SELECT ${uidExpr} AS uid
  FROM clklog_sa.sa_events${joinsSql}
  WHERE project_name = {project: String}
    AND stat_date BETWEEN {u_start: String} AND {u_end: String}
    AND ${uidExpr} != ''
  GROUP BY uid
)
WHERE uid NOT IN (${prior.join(' UNION DISTINCT ')})`);
    }
    const sql = `INSERT INTO clklog_sa.sa_tag_members (project_name, tag_id, batch_id, uid, tag_value)
SELECT {project: String}, {tag_id: String}, {batch_id: String}, uid, tag_value
FROM (
${branches.join('\nUNION ALL\n')}
)
LIMIT ${TAG_MATERIALIZE_LIMIT}`;
    return { sql, params };
  }
}

function universeWindow(conditions: CohortCondition[], computeDay: string): { start: string; end: string } {
  const windows = conditions
    .filter((item): item is Extract<CohortCondition, { time: unknown }> => item.type === 'did_event' || item.type === 'sequence')
    .map((item) => resolveConditionTime(item.time, computeDay));
  if (windows.length === 0) {
    return { start: shiftDate(computeDay, -7), end: shiftDate(computeDay, -1) };
  }
  return {
    start: windows.reduce((min, item) => (item.start < min ? item.start : min), windows[0].start),
    end: windows.reduce((max, item) => (item.end > max ? item.end : max), windows[0].end),
  };
}
