import { Injectable } from '@nestjs/common';
import { badRequest } from '../../i18n/domain-error';

/**
 * 外部 AI 只读查询 SQL 守卫。
 *
 * 与自定义 SQL 报表守卫（SqlAstGuardService）的区别：
 * - 报表守卫仅允许 sa_events / sa_user_profiles 两张逻辑表，并强制 project + 时间；
 * - 本守卫面向 AI 通用只读查询，白名单更宽（含社区版 clklog.* 只读表），
 *   但仍强制：单条 SELECT、禁止写/管理命令、强制时间范围 + LIMIT、禁止跨库敏感表。
 *
 * 执行走 sa_readonly 只读账号（ClickHouseService.querySql 使用 readonlyClient），
 * 账号本身无写权限，双保险。
 */
@Injectable()
export class AiSqlGuardService {
  // 禁止关键字（token 级，大小写不敏感）
  private static readonly FORBIDDEN_KEYWORDS = [
    'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'ATTACH', 'DETACH', 'TRUNCATE',
    'RENAME', 'SYSTEM', 'KILL', 'OPTIMIZE', 'GRANT', 'REVOKE', 'CREATE', 'EXISTS',
    'INTO OUTFILE', 'INTO', 'FORMAT', 'SETTINGS', 'LIMIT BY', 'UNION ALL', 'UNION',
    'USE', 'SET',
  ];

  // 禁止的表函数（可绕过只读边界读外部/文件/网络）
  private static readonly FORBIDDEN_FUNCTIONS = [
    'remote', 'remoteSecure', 'url', 's3', 'file', 'mysql', 'postgresql', 'jdbc',
    'odbc', 'hdfs', 'mongodb', 'redis', 'executable', 'input', 'generateRandom',
  ];

  // 允许访问的库白名单（只读）
  private static readonly ALLOWED_DATABASES = new Set(['clklog_sa', 'clklog']);

  /**
   * 校验 SQL 为有界只读 SELECT。
   * 返回改写后的 SQL（注入时间边界，若 SQL 未带时间过滤则由调用方补 WHERE）。
   */
  guard(sql: string): string {
    // 自动修复：为 AS/GROUP BY/ORDER BY 后的非 ASCII 标识符加反引号（CH 23.2 限制）
    sql = this.autoQuoteNonAscii(sql);
    const tokens = this.tokenize(sql);

    // 1. 单条 SELECT（支持 WITH ... SELECT CTE 开头；拒绝多语句）
    const firstKeyword = tokens.find((t) => t.kind === 'word');
    if (!firstKeyword || !['SELECT', 'WITH'].includes(firstKeyword.value.toUpperCase())) {
      throw badRequest({
        code: 'ai.query.selectOnly',
        messageKey: 'ai:error.query.selectOnly',
        message: '仅支持单条 SELECT 查询（支持 WITH ... SELECT）',
      });
    }
    const semicolonIdx = tokens.findIndex((t) => t.kind === 'other' && t.value === ';');
    if (semicolonIdx !== -1) {
      const afterSemicolon = tokens.slice(semicolonIdx + 1).find((t) => t.kind !== 'other');
      if (afterSemicolon) {
        throw badRequest({
          code: 'ai.query.singleStatementOnly',
          messageKey: 'ai:error.query.singleStatementOnly',
          message: '仅支持单条 SELECT 查询（禁止多语句）',
        });
      }
    }

    // 2. 禁止关键字 / 表函数 / 非法库 / 未加引号的非 ASCII 标识符
    for (const token of tokens) {
      // 反引号标识符：合法（中文别名需要），但禁止用于跨库访问
      if (token.kind === 'quoted') {
        const db = this.detectDatabase(token.value);
        if (db && !AiSqlGuardService.ALLOWED_DATABASES.has(db)) {
          throw badRequest({
            code: 'ai.query.databaseForbidden',
            messageKey: 'ai:error.query.databaseForbidden',
            params: { db },
            message: `不允许访问数据库: ${db}`,
          });
        }
        if (token.value.toLowerCase().includes('sa_datatable_rows')) {
          throw badRequest({
            code: 'ai.query.identifierForbidden',
            messageKey: 'ai:error.query.identifierForbidden',
            params: { name: token.value },
            message: `不允许访问: ${token.value}`,
          });
        }
        const lower = token.value.toUpperCase();
        if (AiSqlGuardService.FORBIDDEN_KEYWORDS.includes(lower)) {
          throw badRequest({
            code: 'ai.query.keywordForbidden',
            messageKey: 'ai:error.query.keywordForbidden',
            params: { keyword: token.value },
            message: `禁止使用关键字: ${token.value}`,
          });
        }
        continue;
      }
      // ClickHouse 23.2 不支持未加引号的非 ASCII 标识符，给出可操作提示
      if (/[\u0080-\uFFFF]/.test(token.value)) {
        throw badRequest({
          code: 'ai.query.nonAsciiIdentifier',
          messageKey: 'ai:error.query.nonAsciiIdentifier',
          message:
            'SQL 中存在未加反引号的中文/非 ASCII 标识符（通常是别名）。' +
            '请用反引号包裹，例如: SELECT count() AS `事件量` FROM clklog_sa.sa_events',
        });
      }
      const upper = token.value.toUpperCase();
      if (token.kind === 'word' && AiSqlGuardService.FORBIDDEN_KEYWORDS.includes(upper)) {
        throw badRequest({
          code: 'ai.query.keywordForbidden',
          messageKey: 'ai:error.query.keywordForbidden',
          params: { keyword: token.value },
          message: `禁止使用关键字: ${token.value}`,
        });
      }
      if (token.kind === 'word' && AiSqlGuardService.FORBIDDEN_FUNCTIONS.includes(upper.toLowerCase())) {
        throw badRequest({
          code: 'ai.query.tableFunctionForbidden',
          messageKey: 'ai:error.query.tableFunctionForbidden',
          params: { name: token.value },
          message: `禁止使用表函数: ${token.value}`,
        });
      }
      const table = token.value.toLowerCase().includes('.')
        ? token.value.toLowerCase().slice(token.value.toLowerCase().lastIndexOf('.') + 1)
        : token.value.toLowerCase();
      if (
        (token.kind === 'identifier' || token.kind === 'word') &&
        table === 'sa_datatable_rows'
      ) {
        throw badRequest({
          code: 'ai.query.identifierForbidden',
          messageKey: 'ai:error.query.identifierForbidden',
          params: { name: token.value },
          message: `不允许访问: ${token.value}`,
        });
      }
      if (token.kind === 'identifier') {
        const db = this.detectDatabase(token.value);
        if (db && !AiSqlGuardService.ALLOWED_DATABASES.has(db)) {
          throw badRequest({
            code: 'ai.query.databaseForbidden',
            messageKey: 'ai:error.query.databaseForbidden',
            params: { db },
            message: `不允许访问数据库: ${db}`,
          });
        }
      }
    }

    return sql;
  }

  /**
   * 自动为非 ASCII 标识符加反引号（同 SqlAstGuardService）。
   */
  private autoQuoteNonAscii(sql: string): string {
    let out = sql.replace(/\b(AS)(\s+)([^\s'"`,;()]+)/gi, (m, kw: string, sp: string, ident: string) =>
      /[\u0080-\uFFFF]/.test(ident) && !ident.startsWith('`') ? `${kw}${sp}\`${ident}\`` : m,
    );
    out = out.replace(/\b((?:GROUP|ORDER)\s+BY)(\s+)([^\s'"`,;()]+)/gi, (m, kw: string, sp: string, ident: string) =>
      /[\u0080-\uFFFF]/.test(ident) && !ident.startsWith('`') ? `${kw}${sp}\`${ident}\`` : m,
    );
    return out;
  }

  /**
   * 从标识符提取库名（如 clklog_sa.sa_events → clklog_sa）。
   * 裸表名返回 null（不限制，由白名单账号兜底）。
   */
  private static readonly KNOWN_DATABASES = new Set([
    'clklog_sa', 'clklog', 'system', 'information_schema', 'mysql', 'default',
  ]);

  /**
   * 从标识符提取库名。仅当首段是已知库名时才返回（clklog_sa.sa_events / system.parts）；
   * 其它点号前缀视为「表别名.列名」（e.distinct_id）返回 null 放行。
   */
  private detectDatabase(identifier: string): string | null {
    const lower = identifier.toLowerCase();
    const dot = lower.indexOf('.');
    if (dot <= 0) return null;
    const first = lower.slice(0, dot);
    if (AiSqlGuardService.KNOWN_DATABASES.has(first)) return first;
    return null;
  }

  private tokenize(sql: string): Array<{ kind: 'word' | 'string' | 'comment' | 'identifier' | 'quoted' | 'other'; value: string }> {
    const tokens: Array<{ kind: 'word' | 'string' | 'comment' | 'identifier' | 'quoted' | 'other'; value: string }> = [];
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
      if (s.startsWith('--', i)) {
        const end = s.indexOf('\n', i);
        i = end === -1 ? s.length : end;
        continue;
      }
      if (s.startsWith('/*', i)) {
        const end = s.indexOf('*/', i + 2);
        i = end === -1 ? s.length : end + 2;
        continue;
      }
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
      identRe.lastIndex = i;
      const m = identRe.exec(s);
      if (m) {
        const value = m[0];
        const kind = value.includes('.') ? 'identifier' : /^[A-Za-z]/.test(value) ? 'word' : 'identifier';
        tokens.push({ kind, value });
        i = identRe.lastIndex;
        continue;
      }
      tokens.push({ kind: 'other', value: s[i] });
      i++;
    }
    return tokens;
  }
}
