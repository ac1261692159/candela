import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 定点删除的条件白名单与 SQL 构造（phase: clklog-data-management-v1.2，纯函数）。
 *
 * 设计要点（见 design-data-management-v1.2 §2）：
 * - **不做任意 SQL**：条件只有四种（按事件 / 按项目 / 按时间上界 / 未来时间戳），表与列都白名单；
 * - **只允许旁路库** `clklog_sa.*`：出现 `clklog.*`（社区版）一律拒绝（红线 1，代码硬校验）；
 * - **必须带项目边界**：除「未来时间戳」外，SQL 一律含 `project_name = {project}`（设计 DML 契约）；
 * - **时间上界默认昨天**：除未来时间戳专项外不接受 `to > 昨天`，避免删到正在写入的数据。
 */

/** 允许被定点删除的表：条件类型 + 时间列 + 备份取列 */
export interface DeleteTableSpec {
  /** 允许的条件种类 */
  kinds: ReadonlyArray<DeleteKind>;
  /** 时间列（无时间语义的表为 null，只能按项目删） */
  timeColumn: string | null;
  /** 预演样例展示列（避免把 properties 之类的敏感大字段带回前端） */
  sampleColumns: ReadonlyArray<string>;
  /** 分区键是否就是项目名（真 → 可 DROP PARTITION，秒级） */
  partitionByProject: boolean;
  /** 表的中文用途说明（用于前端提示，键值走 i18n 的是前端自己的事，这里只做白名单元数据） */
  label: string;
}

export type DeleteKind = 'event' | 'project' | 'before' | 'future';

export const DELETE_TABLES: Record<string, DeleteTableSpec> = {
  'clklog_sa.sa_events': {
    kinds: ['event', 'project', 'before', 'future'],
    timeColumn: 'stat_date',
    // ⚠️ 别名不能叫 stat_date：会遮蔽真实列，WHERE 里的 `stat_date > {today: Date}` 会被解析成
    // String 与 Date 比较并报 "There is no supertype for types String, Date"（2026-10-09 实测踩到）
    sampleColumns: ['event', 'distinct_id', 'toString(stat_date) AS stat_date_text'],
    partitionByProject: false,
    label: 'sa_events',
  },
  'clklog_sa.sa_user_profiles': {
    kinds: ['project'],
    timeColumn: null,
    sampleColumns: ['project_name', 'distinct_id'],
    partitionByProject: false,
    label: 'sa_user_profiles',
  },
  'clklog_sa.sa_datatable_rows': {
    kinds: ['project'],
    timeColumn: null,
    sampleColumns: ['project_name', 'datatable_key', 'version'],
    partitionByProject: false,
    label: 'sa_datatable_rows',
  },
  'clklog_sa.sa_cohort_members': {
    kinds: ['project'],
    timeColumn: null,
    sampleColumns: ['project_name', 'cohort_key', 'distinct_id'],
    partitionByProject: true,
    label: 'sa_cohort_members',
  },
  'clklog_sa.sa_tag_members': {
    kinds: ['project'],
    timeColumn: null,
    sampleColumns: ['project_name', 'tag_key', 'distinct_id'],
    partitionByProject: true,
    label: 'sa_tag_members',
  },
};

/** 项目名格式（与建项目/上报口径一致）：小写字母开头，允许小写字母/数字/_/-，≤64 */
export const PROJECT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
/** 事件名：允许大小写字母数字与 _ - $ . 开头（与 SDK 预置事件 `$SignUp` 兼容），≤200 */
export const EVENT_NAME_PATTERN = /^[A-Za-z0-9_$][A-Za-z0-9_$.-]{0,199}$/;
const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface DeleteRequest {
  kind: DeleteKind;
  table: string;
  project: string;
  /** kind=event 必填 */
  event?: string;
  /** kind=event/project 可选范围（YYYY-MM-DD，闭区间） */
  from?: string;
  to?: string;
  /** kind=before 必填：删 stat_date < before */
  before?: string;
  /** 平台时区的今天（YYYY-MM-DD），由服务层注入以便测试 */
  today: string;
}

export interface DeletePlan {
  table: string;
  /** 删除 SQL（参数化；未来时间戳用 today 参数比较） */
  sql: string;
  params: Record<string, unknown>;
  /** 预演用的同条件查询 SQL */
  previewSql: string;
  previewParams: Record<string, unknown>;
  /** 样例查询 SQL */
  sampleSql: string;
  /** 受影响日期区间（用于清理登记；无时间语义的表返回 null） */
  range: { from: string; to: string } | null;
  /** 分区名（partitionByProject 的表用 DROP PARTITION 路径；否则为 null） */
  dropPartition: string | null;
  /** 供人工确认的条件摘要（稳定字符串，参与 token） */
  summary: string;
}

export class DeletePlanError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: 400 | 409 = 400,
  ) {
    super(message);
  }
}

function assertYmd(value: string, field: string): string {
  if (!YMD_PATTERN.test(value)) {
    throw new DeletePlanError('ops.dataDelete.dateInvalid', `${field} 须为 YYYY-MM-DD`);
  }
  return value;
}

/** 构造删除计划（含 SQL）；任何白名单外的输入都抛 DeletePlanError */
export function buildDeletePlan(req: DeleteRequest): DeletePlan {
  const spec = DELETE_TABLES[req.table];
  if (!spec) {
    // 明确区分「社区版库」与「其他表」，便于前端给不同提示
    const code = req.table.startsWith('clklog.') ? 'ops.dataDelete.communityRefused' : 'ops.dataDelete.tableNotAllowed';
    throw new DeletePlanError(code, `表不在定点删除白名单：${req.table}`);
  }
  if (!spec.kinds.includes(req.kind)) {
    throw new DeletePlanError('ops.dataDelete.kindNotAllowed', `${req.table} 不支持该删除条件：${req.kind}`);
  }
  if (!PROJECT_NAME_PATTERN.test(req.project)) {
    throw new DeletePlanError('ops.dataDelete.projectInvalid', `项目名格式非法：${req.project}`);
  }

  const where: string[] = [];
  const params: Record<string, unknown> = { project: req.project };
  const today = assertYmd(req.today, 'today');

  // 项目边界：未来时间戳专项也要带项目（避免跨项目误删）
  where.push('project_name = {project: String}');

  if (req.kind === 'event') {
    if (!req.event || !EVENT_NAME_PATTERN.test(req.event)) {
      throw new DeletePlanError('ops.dataDelete.eventInvalid', `事件名格式非法：${req.event ?? '(空)'}`);
    }
    where.push('event = {event: String}');
    params.event = req.event;
  }

  if (req.kind === 'before') {
    if (!req.before) throw new DeletePlanError('ops.dataDelete.beforeRequired', 'before 必填');
    assertYmd(req.before, 'before');
    if (req.before > today) {
      throw new DeletePlanError('ops.dataDelete.beforeInFuture', 'before 不得晚于今天（要删未来数据请用「未来时间戳」条件）');
    }
    where.push(`${spec.timeColumn} < {before: Date}`);
    params.before = req.before;
  }

  if (req.kind === 'event' || req.kind === 'project') {
    if (req.from) {
      assertYmd(req.from, 'from');
      where.push(`${spec.timeColumn} >= {from: Date}`);
      params.from = req.from;
    }
    if (req.to) {
      assertYmd(req.to, 'to');
      if (req.to > today) {
        throw new DeletePlanError('ops.dataDelete.toInFuture', 'to 不得晚于今天（要删未来数据请用「未来时间戳」条件）');
      }
      where.push(`${spec.timeColumn} <= {to: Date}`);
      params.to = req.to;
    }
    if (req.from && req.to && req.from > req.to) {
      throw new DeletePlanError('ops.dataDelete.rangeInvalid', 'from 不得晚于 to');
    }
  }

  let range: { from: string; to: string } | null = null;
  if (req.kind === 'future') {
    // 未来时间戳专项：只删 stat_date > 今天（时钟错乱数据）；不使用 DROP PARTITION（未来分区可能正在写入）
    if (spec.timeColumn === null) {
      throw new DeletePlanError('ops.dataDelete.kindNotAllowed', `${req.table} 无时间列，不支持未来时间戳清理`);
    }
    where.push(`${spec.timeColumn} > {today: Date}`);
    params.today = today;
    range = { from: today, to: '9999-12-31' };
  } else if (spec.timeColumn === null) {
    range = null;
  } else {
    range = { from: req.from ?? req.before ?? '1970-01-01', to: req.to ?? '9999-12-31' };
  }

  const whereSql = where.join(' AND ');
  const sql = spec.partitionByProject
    ? `ALTER TABLE ${req.table} DROP PARTITION '${req.project}'`
    : `ALTER TABLE ${req.table} DELETE WHERE ${whereSql}`;

  // DROP PARTITION 路径没有 WHERE 参数（分区名已按 PROJECT_NAME_PATTERN 校验后内插）
  const deleteParams = spec.partitionByProject ? {} : params;

  return {
    table: req.table,
    sql,
    params: deleteParams,
    previewSql: `SELECT count() AS rows FROM ${req.table} WHERE ${whereSql}`,
    previewParams: params,
    sampleSql: `SELECT ${spec.sampleColumns.join(', ')} FROM ${req.table} WHERE ${whereSql} LIMIT 5`,
    range,
    dropPartition: spec.partitionByProject ? req.project : null,
    summary: [
      `kind=${req.kind}`,
      `table=${req.table}`,
      `project=${req.project}`,
      `event=${req.event ?? '-'}`,
      `from=${req.from ?? '-'}`,
      `to=${req.to ?? '-'}`,
      `before=${req.before ?? '-'}`,
      `today=${today}`,
    ].join('|'),
  };
}

/** 影响行数上限（超过则拒绝执行，建议分批） */
export const DELETE_MAX_ROWS = 5_000_000;

/**
 * 前置对拍「窗口覆盖」要求的时效边界（天）。
 * 被删窗口最新一天早于「今天 - N」时，只要求一张新鲜通过快照：
 * 对拍单次上限 3 天，近期快照不可能覆盖几个月前的某一天，硬要求会把历史清理永久拦住。
 */
export const DELETE_PREFLIGHT_COVERAGE_DAYS = 30;

/** 备份表名：`clklog_sa_bak.<tbl>_<yyyymmddHHMMSS>` */
export function backupTableName(table: string, at: Date): string {
  const tbl = table.split('.')[1];
  const stamp = at.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `clklog_sa_bak.${tbl}_${stamp}`;
}

/** 备份 SQL：结构复制 + 同条件 INSERT SELECT（与 scripts/cleanup.sh 口径一致） */
export function buildBackupSql(plan: DeletePlan, backupTable: string): { create: string; insert: string } {
  const source = plan.table;
  const whereSql = plan.previewSql.slice(plan.previewSql.indexOf(' WHERE ') + 7);
  return {
    create: `CREATE TABLE IF NOT EXISTS ${backupTable} AS ${source}`,
    insert: `INSERT INTO ${backupTable} SELECT * FROM ${source} WHERE ${whereSql}`,
  };
}

// ---------- 二次确认 token ----------

const TOKEN_TTL_MS = 5 * 60_000;

function digest(key: string, input: string): string {
  return createHmac('sha256', key).update(input).digest('hex').slice(0, 32);
}

/**
 * 签发确认 token：绑定「条件摘要 + 预演行数 + 签发时间」。
 * 密钥由调用方从 `appConfig.cleanup.confirmKey` 传入——**不在本文件读 env**
 * （结构棘轮：非入口目录不得新增进程环境变量读取——注释里也不要出现该字面量，
 *   棘轮按文本匹配计数）。
 */
export function signConfirmToken(summary: string, rows: number, key: string, now: Date = new Date()): string {
  const issuedAt = now.getTime();
  return `${issuedAt}.${digest(key, `${summary}#${rows}#${issuedAt}`)}`;
}

/** 校验确认 token：条件或行数变化即失效；超过 5 分钟失效 */
export function verifyConfirmToken(
  token: string,
  summary: string,
  rows: number,
  key: string,
  now: Date = new Date(),
): boolean {
  const [tsRaw, sig] = token.split('.');
  const issuedAt = Number(tsRaw);
  if (!Number.isFinite(issuedAt) || !sig) return false;
  if (now.getTime() - issuedAt > TOKEN_TTL_MS) return false;
  const expect = digest(key, `${summary}#${rows}#${issuedAt}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  return a.length === b.length && timingSafeEqual(a, b);
}
