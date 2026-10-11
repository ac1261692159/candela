import { Injectable, Optional } from '@nestjs/common';
import { ClickHouseService } from '../shared/clickhouse.service';
import { SubjectService } from '../subject/subject.service';
import { TimezoneService } from '../time/timezone.service';
import { ProjectTimeRegistry } from '../time/project-time-registry';
import { CohortConditionSqlService } from './cohort-condition-sql.service';
import {
  assertNegativeUniverseSupported,
  computeDay,
  validateConditionDefinition,
} from './cohort-definition';

/** 试跑示例成员条数：默认 20（够看清圈到谁），上限与成员预览一致 */
export const CONDITION_PREVIEW_DEFAULT_SAMPLE = 20;
export const CONDITION_PREVIEW_SAMPLE_LIMIT = 1000;
const EXEC_SECONDS = 30;

@Injectable()
export class CohortPreviewService {
  constructor(
    private readonly conditionSql: CohortConditionSqlService,
    private readonly clickHouse: ClickHouseService,
    private readonly subjects: SubjectService,
    private readonly timezones: TimezoneService,
    @Optional() private readonly projectTimes?: ProjectTimeRegistry,
  ) {}

  /**
   * 条件分群试跑：给出精确人数与示例成员，不写 `sa_cohort_members`、不改分群状态。
   *
   * 口径与保存后的预计算一致（`computeDay` 走项目统计日历、`buildUidSet` 同一条集合 SQL），
   * 否则「试跑 1200 人、保存后 980 人」会让人不再信任这个数。
   */
  async previewCondition(
    project: string,
    definitionJson: unknown,
    subjectId?: string,
    limitInput?: number,
  ) {
    const definition = validateConditionDefinition(definitionJson);
    const resolved = await this.subjects.resolve(project, subjectId);
    assertNegativeUniverseSupported(resolved, definition.conditions);
    const limit = Math.min(
      Math.max(limitInput ?? CONDITION_PREVIEW_DEFAULT_SAMPLE, 0),
      CONDITION_PREVIEW_SAMPLE_LIMIT,
    );
    const parts = await this.conditionSql.buildPreviewParts(
      project,
      definition.conditions,
      computeDay(this.statTzOf(project)),
      resolved.subject_id,
      limit,
    );
    const countRows = await this.clickHouse.query<{ c: string | number }>(
      parts.count.sql,
      parts.count.params,
      { maxExecutionTime: EXEC_SECONDS, maxResultRows: 1 },
    );
    const count = Number(countRows[0]?.c ?? 0);
    if (!parts.sample) return { count, items: [] as { uid: string }[], limit, truncated: false };
    const sampleRows = await this.clickHouse.query<{ uid: string }>(
      parts.sample.sql,
      parts.sample.params,
      { maxExecutionTime: EXEC_SECONDS, maxResultRows: limit },
    );
    const items = sampleRows
      .map((row) => ({ uid: String(row.uid ?? '') }))
      .filter((row) => row.uid !== '');
    return { count, items, limit, truncated: items.length >= limit };
  }

  /** 项目统计日历（与 CohortComputeService 同一取值路径） */
  private statTzOf(project: string): string {
    return this.projectTimes?.timeZoneOf(project, this.timezones.platformTz) ?? this.timezones.platformTz;
  }
}
