import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { badRequest, domainError } from '../../i18n/domain-error';
import { addCalendarDays, parseChDateTimeInTz, ymdInTz } from '../time/calendar';
import { TimezoneService } from '../time/timezone.service';
import { ClickHouseService } from '../shared/clickhouse.service';
import { PrismaService } from '../shared/prisma.service';
import { SubjectService } from '../subject/subject.service';
import { ResolvedSubject, subjectExpr } from '../subject/subject-expr';
import { JoinRegistry } from '../relation/join-registry';
import { isClickHouseTimeout } from '../query-job/query-job.policy';
import type { UserTimelineQueryDto } from './dto/user-timeline.dto';

export interface UserTimelineSpec {
  subject_id?: string;
  /** 标识口径：subject = 分析主体（预置/自定义）；user_property / event_property = 按属性等值匹配 */
  id_kind?: 'subject' | 'user_property' | 'event_property';
  /** id_kind 为属性时的属性键（如 massid） */
  id_key?: string;
  value: string;
  from: string;
  to: string;
  events?: string[];
  order: 'asc' | 'desc';
  limit: number;
  /** 服务端行级筛选（事件属性等值/包含），作用于明细与概览 */
  filter_key?: string;
  filter_scope?: 'event' | 'user';
  filter_value?: string;
}

export interface UserTimelineRow {
  log_time: string;
  event: string;
  distinct_id: string;
  user_key: string;
  properties: string;
  matched_total?: number | string;
  event_kinds?: number | string;
  first_log_time?: string | null;
  last_log_time?: string | null;
}

export interface UserTimelineSummary {
  /** 区间内该用户的命中总数（count() OVER ()，与 LIMIT 无关） */
  matched_total: number;
  /** 本次物化返回的行数（≤ TIMELINE_MAX_ROWS） */
  shown_total: number;
  /** 事件种类数（uniqExact(event) OVER ()） */
  event_kinds: number;
  first_log_time: string | null;
  last_log_time: string | null;
  /** 命中数超过物化上限时为真（如实标注，不静默截断） */
  truncated: boolean;
}

/** 单次物化上限（行为序列常见几千条；超过按时间序截断并标注） */
export interface UserTimelineOverview {
  /** 每日事件量（趋势图） */
  daily: { date: string; count: number }[];
  /** 事件次数分布（占比饼图，Top 20） */
  events: { event: string; count: number }[];
}

export interface UserTimelineNeighbors {
  /** 锚点事件之前的 N 条（时间正序，便于按序列阅读） */
  before: UserTimelineRow[];
  /** 锚点事件之后的 N 条（时间正序） */
  after: UserTimelineRow[];
}

/** 用户标识（画像表里的一条身份） */
export interface UserTimelineIdentity {
  distinct_id: string;
  user_key: string;
}

export interface UserTimelineProfile {
  /** 用户属性（sa_user_profiles.properties 原文解析；缺失为空对象） */
  attributes: Record<string, unknown>;
  /** 标签最新值（sa_tag_members 取最新批次 + MySQL 侧名称） */
  tags: { tag_id: string; name: string; value: string }[];
  /** 按属性查时解析到的标识（页面据此显示「已解析为 1_14552557」，使用者不必自己知道内部 ID） */
  resolved?: UserTimelineIdentity | null;
  /** 按属性查时匹配到的标识个数（0 = 属性键或值不对） */
  matched_users?: number;
}

export const TIMELINE_MAX_ROWS = 5000;
export const TIMELINE_DEFAULT_ROWS = 500;
/** stat_date 余量（天）：stat_date 按项目时区切日、log_time 按平台时区，两端各留余量 */
export const TIMELINE_STAT_DATE_MARGIN_DAYS = 2;
/** 属性 → 标识解析的匹配上限（属性值理论上对应一个人；给足余量，触顶时提示收窄） */
export const TIMELINE_RESOLVE_MAX_USERS = 200;

@Injectable()
export class TimelineService {
  private readonly logger = new Logger(TimelineService.name);

  // 缺省构造兜底纯单测；生产由 DI 注入
  constructor(
    private readonly clickHouse: ClickHouseService,
    private readonly subjects: SubjectService = new SubjectService(undefined as never),
    private readonly timezones: TimezoneService = new TimezoneService(undefined),
    private readonly prisma: PrismaService = new PrismaService(),
  ) {}

  /** 把入参归一为执行规格（时间按平台时区解释；条数收敛到 [1, 上限]） */
  normalize(dto: UserTimelineQueryDto): UserTimelineSpec {
    const value = (dto.value ?? '').trim();
    if (!value) {
      throw badRequest({ code: 'timeline.valueRequired', messageKey: 'analysis:error.timeline.valueRequired' });
    }
    // DTO 允许「到分钟」（YYYY-MM-DD HH:mm）；解析器（parseChDateTimeInTz）吃带秒的串，这里补齐
    const from = withSeconds(dto.from);
    const to = withSeconds(dto.to);
    if (!from || !to) {
      throw badRequest({ code: 'timeline.rangeRequired', messageKey: 'analysis:error.timeline.rangeRequired' });
    }
    const limit = dto.limit ? Math.min(TIMELINE_MAX_ROWS, Math.max(1, Math.trunc(dto.limit))) : TIMELINE_DEFAULT_ROWS;
    const events = (dto.events ?? []).map((e) => e.trim()).filter(Boolean).slice(0, 50);
    // 按属性查却没有属性键：不能悄悄退回标识口径（会给出「这个人没有事件」的错误结论）
    if (dto.id_kind && dto.id_kind !== 'subject' && !dto.id_key?.trim()) {
      throw badRequest({
        code: 'timeline.idKeyRequired',
        messageKey: 'analysis:error.timeline.idKeyRequired',
        params: { kind: dto.id_kind },
      });
    }
    return {
      subject_id: dto.subject_id,
      ...(dto.id_kind && dto.id_kind !== 'subject' ? { id_kind: dto.id_kind } : {}),
      ...(dto.id_kind && dto.id_kind !== 'subject' && dto.id_key ? { id_key: dto.id_key } : {}),
      value,
      from,
      to,
      ...(events.length ? { events } : {}),
      order: dto.order === 'asc' ? 'asc' : 'desc',
      limit,
      ...(dto.filter_key && dto.filter_value
        ? { filter_key: dto.filter_key, filter_scope: dto.filter_scope ?? 'event', filter_value: dto.filter_value }
        : {}),
    };
  }

  /**
   * 行为概览：每日事件量 + 事件次数分布（**只读 log_time/event 两列，不读 properties**）。
   *
   * 这正是「概览先行」的前提 —— 明细超预算转后台时，概览已经能返回（见 PRD §7 / 设计 §10.1）。
   */
  async overview(
    spec: UserTimelineSpec,
    project: string,
    options: { maxExecutionTime?: number } = {},
  ): Promise<UserTimelineOverview> {
    const tz = this.timezones.platformTz;
    const sinceMs = parseChDateTimeInTz(spec.from, tz);
    const untilMs = parseChDateTimeInTz(spec.to, tz);
    if (sinceMs === null || untilMs === null || sinceMs >= untilMs) {
      return { daily: [], events: [] };
    }
    const { params, conditions, joins } = await this.buildFilters(spec, project, sinceMs, untilMs, tz);
    const where = conditions.join('\n        AND ');
    const settings = options.maxExecutionTime ? { maxExecutionTime: options.maxExecutionTime } : {};
    try {
      const [daily, events] = await Promise.all([
        this.clickHouse.query<{ date: string; count: number | string }>(
          `SELECT toString(toDate(log_time)) AS date, count() AS count
           FROM clklog_sa.sa_events
           ${joins.render().join('\n           ')}
           WHERE ${where}
           GROUP BY date ORDER BY date`,
          params,
          settings,
        ),
        this.clickHouse.query<{ event: string; count: number | string }>(
          `SELECT event, count() AS count
           FROM clklog_sa.sa_events
           ${joins.render().join('\n           ')}
           WHERE ${where}
           GROUP BY event ORDER BY count DESC LIMIT 20`,
          params,
          settings,
        ),
      ]);
      return {
        daily: daily.map((r) => ({ date: String(r.date), count: Number(r.count ?? 0) })),
        events: events.map((r) => ({ event: String(r.event), count: Number(r.count ?? 0) })),
      };
    } catch (error) {
      // 概览失败不阻断查询：如实返回空图（明细仍会给数）
      this.logger.warn(`行为概览查询失败: ${error instanceof Error ? error.message : String(error)}`);
      return { daily: [], events: [] };
    }
  }

  /**
   * 「查看前后行为」：以某条事件为锚，取它前后各 N 条（**窗口沿用调用方给的区间**，
   * 不额外扩大扫描范围；锚点本身包含在 before 的末尾）。
   */
  async neighbors(
    spec: UserTimelineSpec & { anchor: string; limit?: number },
    project: string,
    options: { maxExecutionTime?: number } = {},
  ): Promise<UserTimelineNeighbors> {
    const tz = this.timezones.platformTz;
    const anchorMs = parseChDateTimeInTz(spec.anchor, tz);
    const sinceMs = parseChDateTimeInTz(spec.from, tz);
    const untilMs = parseChDateTimeInTz(spec.to, tz);
    const take = Math.min(50, Math.max(1, spec.limit ?? 10));
    if (anchorMs === null || sinceMs === null || untilMs === null) return { before: [], after: [] };

    const settings = options.maxExecutionTime ? { maxExecutionTime: options.maxExecutionTime } : {};

    // 两条查询分别取「锚点之前（倒序取 N，再反转成正序）」与「锚点之后（正序 N）」
    const build = async (side: 'before' | 'after') => {
      const { conditions, params, joins } = await this.buildFilters(spec, project, sinceMs, untilMs, tz);
      const anchorCond =
        side === 'before'
          ? 'log_time <= toDateTime64({anchor: String}, 3)'
          : 'log_time > toDateTime64({anchor: String}, 3)';
      const direction = side === 'before' ? 'DESC' : 'ASC';
      const rows = await this.clickHouse.query<UserTimelineRow>(
        `SELECT log_time, event, distinct_id, user_key, properties
         FROM clklog_sa.sa_events
         ${joins.render().join('\n         ')}
         WHERE ${[...conditions, anchorCond].join('\n           AND ')}
         ORDER BY log_time ${direction}
         LIMIT {limit: UInt32}`,
        { ...params, anchor: spec.anchor, limit: take },
        settings,
      );
      return side === 'before' ? [...rows].reverse() : rows;
    };

    try {
      const [before, after] = await Promise.all([build('before'), build('after')]);
      return { before, after };
    } catch (error) {
      this.logger.warn(`前后行为查询失败: ${error instanceof Error ? error.message : String(error)}`);
      throw domainError(HttpStatus.INTERNAL_SERVER_ERROR, {
        code: 'timeline.neighborsFailed',
        messageKey: 'analysis:error.timeline.queryFailed',
      });
    }
  }

  /**
   * 用户画像：用户属性（sa_user_profiles）+ 标签最新值（sa_tag_members 取最新批次 + MySQL 侧标签名）。
   * 失败一律降级为空，不阻断页面（见设计 §10.3 R-2）。
   *
   * 支持两种定位口径（与查询一致）：`subject`（distinct_id / user_key）与 `user_property`
   * （业务属性等值，如 massid）。按属性查时**回报解析到的标识**，页面显示「已解析为 1_14552557」——
   * 使用者只知道业务属性，平台有责任把内部标识翻译给他看。
   */
  async profile(
    input: { value: string; id_kind?: string; id_key?: string },
    project: string,
  ): Promise<UserTimelineProfile> {
    const uid = (input.value ?? '').trim();
    if (!uid) return { attributes: {}, tags: [], resolved: null, matched_users: 0 };
    const byProperty = input.id_kind === 'user_property' && !!input.id_key;

    const rows = await this.clickHouse
      .query<{ distinct_id: string; user_key: string; properties: string }>(
        byProperty
          ? `SELECT distinct_id, user_key, properties FROM clklog_sa.sa_user_profiles FINAL
             WHERE project_name = {project: String}
               AND JSONExtractString(properties, {id_key: String}) = {value: String}
             LIMIT {limit: UInt32}`
          : `SELECT distinct_id, user_key, properties FROM clklog_sa.sa_user_profiles
             WHERE project_name = {project: String}
               AND (distinct_id = {value: String} OR user_key = {value: String})
             LIMIT 1`,
        byProperty
          ? { project, id_key: input.id_key, value: uid, limit: TIMELINE_RESOLVE_MAX_USERS }
          : { project, value: uid },
      )
      .catch(() => [] as { distinct_id: string; user_key: string; properties: string }[]);

    const first = rows[0];
    let attributes: Record<string, unknown> = {};
    try {
      attributes = first?.properties ? (JSON.parse(first.properties) as Record<string, unknown>) : {};
    } catch {
      attributes = {};
    }
    // 标签 uid 口径：主体值（user_key 优先，否则 distinct_id）；再带上原始入参，兼容没有画像行的老标识
    const uids = [
      ...new Set(
        [uid, ...rows.map((r) => r.user_key || r.distinct_id)].map((v) => String(v ?? '').trim()).filter(Boolean),
      ),
    ];
    const tags = await this.clickHouse
      .query<{ tag_id: string; value: string }>(
        `SELECT tag_id, argMax(tag_value, batch_id) AS value
         FROM clklog_sa.sa_tag_members
         WHERE project_name = {project: String} AND uid IN {uids: Array(String)}
         GROUP BY tag_id`,
        { project, uids },
      )
      .catch(() => [] as { tag_id: string; value: string }[]);

    const names = await this.tagNames(project, tags.map((t) => t.tag_id)).catch(() => ({} as Record<string, string>));
    return {
      attributes,
      tags: tags.map((t) => ({ tag_id: t.tag_id, name: names[t.tag_id] ?? t.tag_id, value: String(t.value ?? '') })),
      resolved: first ? { distinct_id: String(first.distinct_id ?? ''), user_key: String(first.user_key ?? '') } : null,
      matched_users: rows.length,
    };
  }

  /** 标签展示名（MySQL 侧；失败回落到 tag_id） */
  private async tagNames(project: string, tagIds: string[]): Promise<Record<string, string>> {
    if (!tagIds.length) return {};
    const rows = await this.prisma.metaUserTag.findMany({
      where: { project_name: project, tag_id: { in: tagIds } },
      select: { tag_id: true, display_name: true, name: true },
    });
    return Object.fromEntries(rows.map((r) => [r.tag_id, r.display_name || r.name]));
  }

  /** 主体 + 区间 + stat_date 余量 + 可选事件多选 → WHERE 片段（query 与 overview 共用同一口径） */
  private async buildFilters(
    spec: UserTimelineSpec,
    project: string,
    sinceMs: number,
    untilMs: number,
    tz: string,
  ): Promise<{ params: Record<string, unknown>; conditions: string[]; joins: JoinRegistry }> {
    const joins = new JoinRegistry();
    const since = Math.floor(sinceMs / 1000);
    const until = Math.floor(untilMs / 1000);
    const params: Record<string, unknown> = {
      project,
      value: spec.value,
      since,
      until,
      stat_from: addCalendarDays(ymdInTz(tz, sinceMs), -TIMELINE_STAT_DATE_MARGIN_DAYS),
      stat_to: addCalendarDays(ymdInTz(tz, untilMs), TIMELINE_STAT_DATE_MARGIN_DAYS),
      limit: spec.limit,
    };
    // 标识条件：默认走分析主体（uid = if(user_key != '', user_key, distinct_id)）；
    // 也可以按属性等值 —— 使用者往往只知道业务属性（如 massid=YYZ...），不知道内部 distinct_id。
    const resolvedSubject = async () => this.subjects.resolve(project, spec.subject_id ?? null);
    let idCondition: string;
    if (spec.id_kind === 'user_property' && spec.id_key) {
      idCondition = await this.propertyIdCondition(spec.id_key, spec.value, project, params, joins, resolvedSubject);
    } else if (spec.id_kind === 'event_property' && spec.id_key) {
      params.id_key = spec.id_key;
      idCondition = `JSONExtractString(properties, {id_key: String}) = {value: String}`;
    } else {
      idCondition = `${subjectExpr(await resolvedSubject(), joins)} = {value: String}`;
    }

    const conditions: string[] = [
      'project_name = {project: String}',
      idCondition,
      'log_time >= toDateTime({since: UInt32})',
      'log_time < toDateTime({until: UInt32})',
      'stat_date >= toDate({stat_from: String})',
      'stat_date <= toDate({stat_to: String})',
    ];
    if (spec.events?.length) {
      conditions.push('event IN {events: Array(String)}');
      params.events = spec.events;
    }
    // 服务端行级筛选：事件属性（直接吃事实表 properties）或用户属性（先解析成标识再限定主体）
    if (spec.filter_key && spec.filter_value) {
      params.filter_value = spec.filter_value;
      if (spec.filter_scope === 'user') {
        conditions.push(
          await this.propertyIdCondition(spec.filter_key, spec.filter_value, project, params, joins, resolvedSubject, {
            paramPrefix: 'filter_ident',
            onEmpty: '1 = 0',
          }),
        );
      } else {
        conditions.push(`JSONExtractString(properties, {filter_key: String}) = {filter_value: String}`);
      }
      params.filter_key = spec.filter_key;
    }
    return { params, conditions, joins };
  }

  /**
   * 属性等值 → 标识条件（**两段式查询**：先在画像表解析，再限定事件表的主体）。
   *
   * 绝不把属性条件 JOIN 到 `sa_events` 上：那样事实表失去全部剪枝能力，ClickHouse 会按
   * stat_date 区间整段预估（实测 1495 条数据的 2 小时查询被估成 **9550 万行 / 180 秒**，
   * 超过 120 秒上限 → 后台任务直接 `query_failed`）。
   * 画像表只有十万行级、且本来就窄，扫它拿到 distinct_id 后再用既有的主体表达式限定事件。
   *
   * @param onEmpty 未匹配到用户时的条件（查标识：抛「未找到用户」；当筛选：返回空结果 `1 = 0`）
   */
  private async propertyIdCondition(
    key: string,
    value: string,
    project: string,
    params: Record<string, unknown>,
    joins: JoinRegistry,
    resolvedSubject: () => Promise<ResolvedSubject>,
    options: { paramPrefix?: string; onEmpty?: 'throw' | '1 = 0' } = {},
  ): Promise<string> {
    const identities = await this.resolveIdentities(project, key, value);
    const prefix = options.paramPrefix ?? 'ident';
    if (!identities.length) {
      if ((options.onEmpty ?? 'throw') === '1 = 0') return '1 = 0';
      throw badRequest({
        code: 'timeline.userNotFound',
        messageKey: 'analysis:error.timeline.userNotFound',
        params: { key, value },
      });
    }
    // 行级主体表达式（与默认口径一致）：user_key 优先，否则 distinct_id
    const uids = [...new Set(identities.map((i) => (i.user_key || i.distinct_id)).filter(Boolean))];
    const expr = subjectExpr(await resolvedSubject(), joins);
    if (uids.length === 1) {
      params[prefix] = uids[0];
      return `${expr} = {${prefix}: String}`;
    }
    params[`${prefix}s`] = uids;
    return `${expr} IN {${prefix}s: Array(String)}`;
  }

  /**
   * 按用户属性解析用户标识：只扫画像表（十万行级），不碰事件表。
   * 失败向上抛（宁可报错，也不能把「查询失败」伪装成「没有这个用户」）。
   */
  async resolveIdentities(project: string, key: string, value: string): Promise<UserTimelineIdentity[]> {
    const rows = await this.clickHouse.query<{ distinct_id: string; user_key: string }>(
      `SELECT distinct_id, user_key
       FROM clklog_sa.sa_user_profiles FINAL
       WHERE project_name = {project: String}
         AND JSONExtractString(properties, {id_key: String}) = {value: String}
       LIMIT {limit: UInt32}`,
      { project, id_key: key, value, limit: TIMELINE_RESOLVE_MAX_USERS },
    );
    return rows
      .map((r) => ({ distinct_id: String(r.distinct_id ?? ''), user_key: String(r.user_key ?? '') }))
      .filter((r) => r.distinct_id || r.user_key);
  }

  /**
   * 查该用户在 [from, to) 内的全部事件。
   *
   * 时间一律用 **epoch 秒 + toDateTime()**（naïve 字符串按 CH 服务端时区解释，曾偏 8 小时）；
   * 汇总（命中数/种类数/首末）用窗口函数在同一次扫描里取，不额外查询。
   */
  async query(
    spec: UserTimelineSpec,
    project: string,
    options: { maxExecutionTime?: number } = {},
  ): Promise<{ items: UserTimelineRow[]; summary: UserTimelineSummary }> {
    const tz = this.timezones.platformTz;
    const sinceMs = parseChDateTimeInTz(spec.from, tz);
    const untilMs = parseChDateTimeInTz(spec.to, tz);
    if (sinceMs === null || untilMs === null) {
      throw badRequest({ code: 'timeline.timeInvalid', messageKey: 'analysis:error.timeline.timeInvalid' });
    }
    if (sinceMs >= untilMs) {
      throw badRequest({ code: 'timeline.rangeInvalid', messageKey: 'analysis:error.timeline.rangeInvalid' });
    }

    const { params, conditions, joins } = await this.buildFilters(spec, project, sinceMs, untilMs, tz);
    const direction = spec.order === 'asc' ? 'ASC' : 'DESC';

    // 汇总与明细共用一次扫描：count()/uniqExact()/min()/max() OVER () 都在 LIMIT 之前求值
    const sql = `
      SELECT log_time, event, distinct_id, user_key, properties,
             count() OVER () AS matched_total,
             uniqExact(event) OVER () AS event_kinds,
             min(log_time) OVER () AS first_log_time,
             max(log_time) OVER () AS last_log_time
      FROM clklog_sa.sa_events
      ${joins.render().join('\n      ')}
      WHERE ${conditions.join('\n        AND ')}
      ORDER BY log_time ${direction}
      LIMIT {limit: UInt32}
    `;

    let rows: UserTimelineRow[];
    try {
      rows = await this.clickHouse.query<UserTimelineRow>(
        sql,
        params,
        options.maxExecutionTime ? { maxExecutionTime: options.maxExecutionTime } : {},
      );
    } catch (error) {
      const timedOut = isClickHouseTimeout(error);
      this.logger.error(
        `用户行为序列查询失败（${spec.from}~${spec.to}${timedOut ? ' timeout' : ''}）: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw domainError(timedOut ? HttpStatus.GATEWAY_TIMEOUT : HttpStatus.INTERNAL_SERVER_ERROR, {
        code: timedOut ? 'timeline.queryTimeout' : 'timeline.queryFailed',
        messageKey: timedOut ? 'analysis:error.timeline.queryTimeout' : 'analysis:error.timeline.queryFailed',
      });
    }

    const first = rows[0];
    const matchedTotal = first ? Number(first.matched_total ?? 0) : 0;
    return {
      items: rows,
      summary: {
        matched_total: matchedTotal,
        shown_total: rows.length,
        event_kinds: first ? Number(first.event_kinds ?? 0) : 0,
        first_log_time: first?.first_log_time ?? null,
        last_log_time: first?.last_log_time ?? null,
        truncated: matchedTotal > rows.length,
      },
    };
  }
}

/** 'YYYY-MM-DD HH:mm' → 'YYYY-MM-DD HH:mm:00'（已是带秒形态则原样返回） */
function withSeconds(value: string | undefined): string {
  const text = (value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text) ? `${text}:00` : text;
}
