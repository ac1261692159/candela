import { Injectable } from '@nestjs/common';
import { badRequest } from '../../i18n/domain-error';

/**
 * 自定义 SQL 安全守卫（词法级 + 逻辑表改写）。
 *
 * 说明（评审修正）：
 * - 纯字符串包含判断会被注释/字符串/CTE/子查询绕过，故此处做**词法级 tokenize**，
 *   在 token 层面识别关键字与标识符，避免被字符串字面量/注释中的关键字绕过。
 * - 完整 AST 解析（真正的语法树）与专用只读账号隔离一并留 TODO（见架构文档 §11.4）。
 *
 * 能力：
 * 1. 校验为单条 SELECT；
 * 2. 禁止 DDL/DML/管理命令、表函数、system.*、其他库、FORMAT/SETTINGS/INTO OUTFILE；
 * 3. 逻辑表改写：表名归一到 clklog_sa.sa_events / sa_user_profiles；
 *    project + 时间边界由 additional_table_filters 注入（见 tableFilterSetting）。
 *    不再包 SELECT * 子查询，否则 CH 无法走 ORDER BY (event, stat_date)，
 *    且会把 properties 整列打满 max_bytes_to_read。
 */
type SqlToken = { kind: 'word' | 'string' | 'comment' | 'identifier' | 'quoted' | 'other'; value: string };

@Injectable()
export class SqlAstGuardService {
  // 禁止的关键字（token 级匹配，忽略大小写）
  private static readonly FORBIDDEN_KEYWORDS = [
    'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'ATTACH', 'DETACH', 'TRUNCATE',
    'RENAME', 'SYSTEM', 'KILL', 'OPTIMIZE', 'GRANT', 'REVOKE', 'CREATE', 'EXISTS',
    'INTO OUTFILE', 'INTO', 'FORMAT', 'SETTINGS', 'LIMIT BY',
  ];

  // 禁止的表函数（会被 remote/url/s3 等绕过只读边界）
  private static readonly FORBIDDEN_FUNCTIONS = [
    'remote', 'remoteSecure', 'url', 's3', 'file', 'mysql', 'postgresql', 'jdbc',
    'odbc', 'hdfs', 'mongodb', 'redis', 'executable', 'input', 'generateRandom',
  ];

  // 允许访问的表（白名单）
  private static readonly ALLOWED_TABLES = new Set([
    'sa_events',
    'sa_user_profiles',
  ]);

  /**
   * 校验 + 改写。返回改写后的 SQL 与参数。
   * `logicalTablesOnly`：只允许 sa_events / sa_user_profiles（SQL 分群禁止读成员表）。
   */
  guard(
    sql: string,
    params: { project: string; from: string; to: string; eventsTimeExtra?: string },
    options?: { logicalTablesOnly?: boolean },
  ): string {
    // 0. 自动修复：ClickHouse 23.2 不支持未加引号的中文标识符，
    //    对 AS 别名 / GROUP BY / ORDER BY 后的非 ASCII 标识符自动加反引号（用户无感）
    sql = this.autoQuoteNonAscii(sql);
    const tokens = this.tokenize(sql);

    // 1. 单条 SELECT（支持 WITH ... SELECT CTE 开头；拒绝多语句）
    const firstKeyword = tokens.find((t) => t.kind === 'word');
    if (!firstKeyword || !['SELECT', 'WITH'].includes(firstKeyword.value.toUpperCase())) {
      throw badRequest({
        code: 'report.sql.singleSelectOnly',
        messageKey: 'report:error.sql.singleSelectOnly',
        message: '仅支持单条 SELECT 查询（支持 WITH ... SELECT）',
      });
    }
    const semicolonIdx = tokens.findIndex((t) => t.kind === 'other' && t.value === ';');
    if (semicolonIdx !== -1) {
      const afterSemicolon = tokens.slice(semicolonIdx + 1).find((t) => t.kind !== 'other');
      if (afterSemicolon) {
        throw badRequest({
          code: 'report.sql.multiStatementForbidden',
          messageKey: 'report:error.sql.multiStatementForbidden',
          message: '仅支持单条 SELECT 查询（禁止多语句）',
        });
      }
    }

    // 2. 禁止关键字 / 表函数 / 非法库 / 未加引号的非 ASCII 标识符
    for (const token of tokens) {
      // 反引号标识符：合法（中文别名需要），但禁止用于逻辑表（绕过 project/time 改写）与其他库
      if (token.kind === 'quoted') {
        const lower = token.value.toLowerCase();
        if (
          lower === 'sa_events' || lower === 'sa_user_profiles' ||
          lower === 'clklog_sa.sa_events' || lower === 'clklog_sa.sa_user_profiles'
        ) {
          throw badRequest({
            code: 'report.sql.logicalTableQuoted',
            messageKey: 'report:error.sql.logicalTableQuoted',
            params: { table: token.value },
            message: `逻辑表请直接写表名（勿加反引号），以便服务端注入 project/时间边界: ${token.value}`,
          });
        }
        if (this.isForbiddenIdentifier(token.value)) {
          throw badRequest({
            code: 'report.sql.tableForbidden',
            messageKey: 'report:error.sql.tableForbidden',
            params: { table: token.value },
            message: `不允许访问: ${token.value}`,
          });
        }
        if (options?.logicalTablesOnly && this.isNonLogicalTable(token.value)) {
          throw badRequest({
            code: 'report.sql.nonLogicalTable',
            messageKey: 'report:error.sql.nonLogicalTable',
            params: { table: token.value },
            message: `SQL 分群只允许 sa_events / sa_user_profiles: ${token.value}`,
          });
        }
        continue;
      }
      // ClickHouse 23.2 不支持未加引号的非 ASCII 标识符（报 Unrecognized token: �），
      // 给出可操作的提示而非透传底层乱码错误
      if (/[\u0080-\uFFFF]/.test(token.value)) {
        throw badRequest({
          code: 'report.sql.nonAsciiIdentifier',
          messageKey: 'report:error.sql.nonAsciiIdentifier',
          message:
            'SQL 中存在未加反引号的中文/非 ASCII 标识符（通常是别名）。' +
            '请用反引号包裹，例如: SELECT count() AS `事件量` FROM clklog_sa.sa_events',
        });
      }
      const upper = token.value.toUpperCase();
      if (token.kind === 'word' && SqlAstGuardService.FORBIDDEN_KEYWORDS.includes(upper)) {
        throw badRequest({
          code: 'report.sql.forbiddenKeyword',
          messageKey: 'report:error.sql.forbiddenKeyword',
          params: { keyword: token.value },
          message: `禁止使用关键字: ${token.value}`,
        });
      }
      if (token.kind === 'word' && SqlAstGuardService.FORBIDDEN_FUNCTIONS.includes(upper.toLowerCase())) {
        throw badRequest({
          code: 'report.sql.tableFunctionForbidden',
          messageKey: 'report:error.sql.tableFunctionForbidden',
          params: { fn: token.value },
          message: `禁止使用表函数: ${token.value}`,
        });
      }
      // 禁止访问 system.* / information_schema / 其他库 / 维表行存储
      if (
        (token.kind === 'identifier' || token.kind === 'word') &&
        this.isForbiddenIdentifier(token.value)
      ) {
        throw badRequest({
          code: 'report.sql.tableForbidden',
          messageKey: 'report:error.sql.tableForbidden',
          params: { table: token.value },
          message: `不允许访问: ${token.value}`,
        });
      }
      if (
        options?.logicalTablesOnly &&
        (token.kind === 'identifier' || token.kind === 'word') &&
        this.isNonLogicalTable(token.value)
      ) {
        throw badRequest({
          code: 'report.sql.nonLogicalTable',
          messageKey: 'report:error.sql.nonLogicalTable',
          params: { table: token.value },
          message: `SQL 分群只允许 sa_events / sa_user_profiles: ${token.value}`,
        });
      }
    }

    // 3. 大表扫描必须有过滤条件（见 assertBoundedEventsScan）
    this.assertBoundedEventsScan(tokens);

    // 4. 表名归一。project + time 由调用方 tableFilterSetting → additional_table_filters 注入。
    void params;
    return this.rewriteLogicalTables(sql);
  }

  /**
   * 拦截「无过滤 + 解析或物化 properties」的 sa_events 扫描。
   *
   * 触发条件（需同时满足）：
   * - 语句读 sa_events；
   * - 整条语句没有 WHERE（注释与字符串在 tokenize 阶段已丢弃，写进注释无法绕过）；
   * - 对 properties 做 JSON 取值（JSONExtract*），或按 properties 分组。
   *
   * 不拦 GROUP BY 系统字段：sa_events 的 ORDER BY 首列是 event，`SELECT event, count()
   * GROUP BY event` 这类全窗口语句可裁剪 granule，廉价且合法。
   * 解析 properties 则相反：该列是 ZSTD(3) 大列，要逐行解压 + JSON 解析。实测
   * `SELECT JSONExtractString(properties,'os'), count() FROM sa_events GROUP BY 1`
   * 预估 1818~2334 秒、2.7 亿行，300 秒墙钟必然失败——与其让用户等满预估检查
   * （100 秒）再报底层错误，不如在入口用可操作的提示拒绝。
   */
  private assertBoundedEventsScan(tokens: SqlToken[]): void {
    const words = tokens.map((t) => (t.kind === 'word' ? t.value.toUpperCase() : ''));
    const readsEvents = tokens.some(
      (t) => (t.kind === 'word' || t.kind === 'identifier') && /(^|\.)sa_events$/i.test(t.value),
    );
    if (!readsEvents || words.includes('WHERE')) return;
    const parsesProperties = words.some((w) => w.startsWith('JSONEXTRACT'));
    const groupsByProperties =
      words.some((w, i) => w === 'GROUP' && words[i + 1] === 'BY') &&
      tokens.some((t) => /(^|\.)properties$/i.test(t.value));
    if (!parsesProperties && !groupsByProperties) return;
    throw badRequest({
      code: 'report.sql.scanRequiresFilter',
      messageKey: 'report:error.sql.scanRequiresFilter',
      message:
        "对 properties 做解析或分组时必须带 WHERE 过滤（如 event = '...'），否则会全窗口扫描、超出查询预算；" +
        'os / app_version / country / url_path 等是可直接分组的系统字段，无需解析 properties',
    });
  }

  /**
   * ClickHouse Map 文本，供 querySql 的 additional_table_filters。
   * 值内单引号写成 \' ，与 @clickhouse/client SettingsMap 口径一致。
   */
  tableFilterSetting(
    params: { project: string; from: string; to: string; eventsTimeExtra?: string },
    extraAnd?: { events?: string; profiles?: string },
  ): string {
    const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const project = esc(params.project);
    const from = esc(params.from);
    const to = esc(params.to);
    // 异时区查询的 epoch 精确裁切（服务端生成，纯 fromUnixTimestamp64Milli/数字字面量）
    const timeExtra = params.eventsTimeExtra ? ` AND (${esc(params.eventsTimeExtra)})` : '';
    const eventsExtra = extraAnd?.events ? ` AND (${esc(extraAnd.events)})` : '';
    const profilesExtra = extraAnd?.profiles ? ` AND (${esc(extraAnd.profiles)})` : '';
    return (
      `{'clklog_sa.sa_events':'project_name = \\'${project}\\' AND stat_date BETWEEN \\'${from}\\' AND \\'${to}\\'${timeExtra}${eventsExtra}',` +
      `'clklog_sa.sa_user_profiles':'project_name = \\'${project}\\'${profilesExtra}'}`
    );
  }

  /**
   * 词法 tokenize：识别 单词关键字 / 字符串 / 注释 / 反引号标识符 / 标识符（含点号）/ 其他。
   * 字符串与注释不产出 token；反引号内容产出 kind='quoted'（内部不做关键字检查）。
   */
  private tokenize(sql: string): SqlToken[] {
    const tokens: SqlToken[] = [];
    const identRe = /[A-Za-z0-9_$.]+/y;
    const ws = /\s+/y;
    let i = 0;
    const s = sql;

    while (i < s.length) {
      ws.lastIndex = i;
      if (ws.exec(s)) {
        i = ws.lastIndex;
        continue;
      }
      // 行注释 --
      if (s.startsWith('--', i)) {
        const end = s.indexOf('\n', i);
        i = end === -1 ? s.length : end;
        continue;
      }
      // 块注释
      if (s.startsWith('/*', i)) {
        const end = s.indexOf('*/', i + 2);
        i = end === -1 ? s.length : end + 2;
        continue;
      }
      // 字符串 '...'
      if (s[i] === "'") {
        let j = i + 1;
        while (j < s.length && s[j] !== "'") j++;
        i = j < s.length ? j + 1 : s.length;
        continue;
      }
      // 反引号标识符 `...`（中文别名等）
      if (s[i] === '`') {
        let j = i + 1;
        while (j < s.length && s[j] !== '`') j++;
        tokens.push({ kind: 'quoted', value: s.slice(i + 1, j) });
        i = j < s.length ? j + 1 : s.length;
        continue;
      }
      // 标识符/单词
      identRe.lastIndex = i;
      const m = identRe.exec(s);
      if (m) {
        const value = m[0];
        const kind = value.includes('.') ? 'identifier' : /^[A-Za-z]/.test(value) ? 'word' : 'identifier';
        tokens.push({ kind, value });
        i = identRe.lastIndex;
        continue;
      }
      // 其他字符
      tokens.push({ kind: 'other', value: s[i] });
      i++;
    }
    return tokens;
  }

  /** 判断标识符是否非法（system. 前缀 / 其他库 / 表函数库） */
  /**
   * 自动为非 ASCII 标识符加反引号（用户无感修复中文别名）。
   * 覆盖 AS 别名与 GROUP BY / ORDER BY 的首项引用；多.item 列表需用户自加反引号，
   * 此时守卫的友好报错会兜底提示。
   */
  private autoQuoteNonAscii(sql: string): string {
    // AS <别名>
    let out = sql.replace(/\b(AS)(\s+)([^\s'"`,;()]+)/gi, (m, kw: string, sp: string, ident: string) =>
      /[\u0080-\uFFFF]/.test(ident) && !ident.startsWith('`') ? `${kw}${sp}\`${ident}\`` : m,
    );
    // GROUP BY / ORDER BY <引用>
    out = out.replace(/\b((?:GROUP|ORDER)\s+BY)(\s+)([^\s'"`,;()]+)/gi, (m, kw: string, sp: string, ident: string) =>
      /[\u0080-\uFFFF]/.test(ident) && !ident.startsWith('`') ? `${kw}${sp}\`${ident}\`` : m,
    );
    return out;
  }

  /** clklog_sa 下除逻辑表以外的表（含分群/标签成员表） */
  private isNonLogicalTable(identifier: string): boolean {
    const lower = identifier.toLowerCase();
    const table = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower;
    if (table === 'sa_cohort_members' || table === 'sa_tag_members') return true;
    if (lower.startsWith('clklog_sa.') && !SqlAstGuardService.ALLOWED_TABLES.has(table)) return true;
    if (!lower.includes('.') && table.startsWith('sa_') && !SqlAstGuardService.ALLOWED_TABLES.has(table)) {
      return true;
    }
    return false;
  }

  private isForbiddenIdentifier(identifier: string): boolean {
    const lower = identifier.toLowerCase();
    // 系统库一律禁止
    if (lower.startsWith('system.') || lower.startsWith('information_schema.') || lower.startsWith('mysql.')) {
      return true;
    }
    const table = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower;
    // 维表行只给服务端生成器 JOIN，用户 SQL / AI SQL 不得直接读
    if (table === 'sa_datatable_rows') return true;
    const dot = lower.indexOf('.');
    if (dot > 0) {
      const first = lower.slice(0, dot);
      if (first === 'clklog_sa') return false; // 本库放行
      if (first === 'clklog') return true;     // 报表仅限 clklog_sa，社区版库不放
      // 其它前缀视为「表别名.列名」（如 e.distinct_id / snm.scene_name）→ 放行，
      // 库级越权由只读账号 + 逻辑表改写兜底
      return false;
    }
    return false;
  }

  /**
   * 表名归一到 clklog_sa.*，不包 SELECT * 子查询。
   * 用占位符两步替换，避免 `sa_events` 匹配到已写出的 `clklog_sa.sa_events`。
   */
  private rewriteLogicalTables(sql: string): string {
    const P_EVENTS = '__SQLREPORT_EVENTS__';
    const P_PROFILES = '__SQLREPORT_PROFILES__';
    return sql
      .replace(/clklog_sa\.sa_user_profiles\b|\bsa_user_profiles\b/gi, P_PROFILES)
      .replace(/clklog_sa\.sa_events\b|\bsa_events\b/gi, P_EVENTS)
      .replace(new RegExp(P_PROFILES, 'g'), 'clklog_sa.sa_user_profiles')
      .replace(new RegExp(P_EVENTS, 'g'), 'clklog_sa.sa_events');
  }
}
