/**
 * 服务端 JOIN 注入（跨表取数）。
 *
 * 背景：生产 ClickHouse 23.2.1 **不支持相关子查询**（子查询内引用外层列会报
 * `Code 47 UNKNOWN_IDENTIFIER`，见 `CODE_HANDOVER.md` 2026-09-14 节）。因此
 * 「用户属性」（后续还有「维度表属性」）这类跨表取数，一律改为在
 * `FROM clklog_sa.sa_events` 之后显式 LEFT JOIN，由本注册表按查询收集、去重、渲染。
 *
 * 用法：
 * ```ts
 * const joins = new JoinRegistry();
 * const expr = await resolver.resolve(prop, 'user', type, { project, joins });
 * const sql = [
 *   `SELECT ${expr} AS v`,
 *   'FROM clklog_sa.sa_events',
 *   ...joins.render(),
 *   'WHERE project_name = {project: String}',
 * ].join('\n');
 * ```
 * 约束：JOIN 的 `on` 必须引用 `sa_events` 侧表达式（列或 `JSONExtract` /
 * `formatDateTime`），因此**只有 FROM 是 `clklog_sa.sa_events` 的查询才允许注入**；
 * profile 侧（FROM `sa_user_profiles`）走 `resolveUserPropertyDirect`，不注入 JOIN。
 */
import { badRequest } from '../../i18n/domain-error';

/** 维度表 JOIN 去重键前缀（别名如 `dtr_dt_xxx_1`） */
export const DATATABLE_JOIN_KEY_PREFIX = 'dtr';
export const MAX_DATATABLE_JOINS = 3;

export interface JoinRequest {
  /** 去重键：同一查询里同键只产生一个 JOIN，同时作为别名前缀 */
  key: string;
  /** JOIN 右侧（子查询或表名），含参数化占位符，如 `{project: String}` */
  subquery: string;
  /** ON 条件；别名由注册表分配 */
  on: (alias: string) => string;
}

export interface RenderedJoin {
  alias: string;
  sql: string;
}

export class JoinRegistry {
  private readonly items: RenderedJoin[] = [];
  private readonly aliases = new Map<string, string>();
  private seq = 0;

  /** 注册（或复用）一个 JOIN，返回其别名 */
  register(request: JoinRequest): string {
    const existing = this.aliases.get(request.key);
    if (existing) return existing;
    if (request.key.startsWith(`${DATATABLE_JOIN_KEY_PREFIX}_`)) {
      const used = [...this.aliases.keys()].filter((key) =>
        key.startsWith(`${DATATABLE_JOIN_KEY_PREFIX}_`),
      ).length;
      if (used >= MAX_DATATABLE_JOINS) {
        throw badRequest({
          code: 'relation.datatable.tooManyJoins',
          messageKey: 'cohort:error.relation.tooManyJoins',
          params: { max: MAX_DATATABLE_JOINS },
          message: '单次查询最多关联 3 张数据表',
        });
      }
    }
    const alias = `${request.key}_${++this.seq}`;
    this.aliases.set(request.key, alias);
    this.items.push({
      alias,
      sql: `LEFT JOIN ${request.subquery} AS ${alias} ON ${request.on(alias)}`,
    });
    return alias;
  }

  /** 供生成器拼在 `FROM clklog_sa.sa_events` 之后 */
  render(): string[] {
    return this.items.map((item) => item.sql);
  }

  get size(): number {
    return this.items.length;
  }
}

/** 用户属性 JOIN 的去重键（同时是别名前缀，如 `up_1`） */
export const USER_PROFILE_JOIN_KEY = 'up';

/**
 * 用户属性 JOIN：把 `sa_user_profiles` 按项目过滤后左联到事件表的 `distinct_id`。
 *
 * - `FINAL`：ReplacingMergeTree 未合并前的重复 `distinct_id` 会让事件行翻倍，必须去重；
 * - `{project: String}`：参数化项目过滤，替代原来的相关引用 `project_name = sa_events.project_name`；
 * - `LEFT JOIN`：未命中用户保留事件行（取值为空），与原标量子查询语义一致。
 */
export function userProfileJoinRequest(): JoinRequest {
  return {
    key: USER_PROFILE_JOIN_KEY,
    subquery:
      '(SELECT distinct_id AS uid, properties FROM clklog_sa.sa_user_profiles FINAL WHERE project_name = {project: String})',
    on: (alias) => `sa_events.distinct_id = ${alias}.uid`,
  };
}
