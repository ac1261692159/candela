/**
 * SqlAstGuardService 单测：安全守卫（黑名单 + 逻辑表改写）。
 */
import { DomainError } from '../../src/i18n/domain-error';
import { SqlAstGuardService } from '../../src/modules/report/sql-ast-guard.service';

/** i18n v1：同步抛错断言统一为「DomainError + HTTP 状态 + 机器码」 */
function expectDomainError(fn: () => unknown, errorCode: string, status = 400) {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DomainError);
  expect(thrown).toMatchObject({ status, errorCode });
}

describe('SqlAstGuardService', () => {
  const service = new SqlAstGuardService();
  const params = { project: 'clklogapp', from: '2026-08-01', to: '2026-08-27' };

  it('正常 SELECT 通过并归一逻辑表（project + time 走 tableFilterSetting）', () => {
    const sql = service.guard('SELECT count() FROM clklog_sa.sa_events', params);
    expect(sql).toContain('clklog_sa.sa_events');
    expect(sql).not.toContain('SELECT * FROM clklog_sa.sa_events WHERE project_name');
    const filters = service.tableFilterSetting(params);
    expect(filters).toContain("project_name = \\'clklogapp\\'");
    expect(filters).toContain("stat_date BETWEEN \\'2026-08-01\\' AND \\'2026-08-27\\'");
  });

  it('拒绝非 SELECT（INSERT）', () => {
    expectDomainError(
      () => service.guard('INSERT INTO clklog_sa.sa_events VALUES (1)', params),
      'report.sql.singleSelectOnly',
    );
  });

  it('拒绝 DROP/ALTER 关键字（token 级，不被字符串绕过）', () => {
    expectDomainError(
      () => service.guard('SELECT 1; DROP TABLE clklog_sa.sa_events', params),
      'report.sql.multiStatementForbidden',
    );
    // 字符串里的 DROP 不应触发（tokenize 已跳过字符串字面量）
    expect(() =>
      service.guard("SELECT count() FROM clklog_sa.sa_events WHERE event = 'DROP'", params),
    ).not.toThrow();
  });

  it('拒绝表函数 remote/url', () => {
    expectDomainError(
      () => service.guard("SELECT * FROM remote('host', 'db', 'tbl')", params),
      'report.sql.tableFunctionForbidden',
    );
  });

  it('拒绝 system.* / 其他库访问', () => {
    expectDomainError(() => service.guard('SELECT * FROM system.tables', params), 'report.sql.tableForbidden');
    expectDomainError(() => service.guard('SELECT * FROM clklog.log_analysis', params), 'report.sql.tableForbidden');
  });

  it('表名归一不产生嵌套子查询（回归：不再包 SELECT *）', () => {
    const sql = service.guard('SELECT count() FROM sa_events', params);
    expect(sql).toContain('FROM clklog_sa.sa_events');
    expect(sql.match(/clklog_sa\.sa_events/g)).toHaveLength(1);
    expect(sql).not.toContain('clklog_sa.(SELECT');
    expect(sql).not.toContain('SELECT * FROM clklog_sa.sa_events WHERE project_name');
    expect(sql).not.toContain('__SQLREPORT_EVENTS__');
  });

  it('tableFilterSetting extra AND 注入成员条件且不含 SELECT *', () => {
    const extra =
      "if(user_key != '', user_key, distinct_id) IN (SELECT uid FROM clklog_sa.sa_cohort_members WHERE cohort_id = 'cohort_abc123xxxx')";
    const filters = service.tableFilterSetting(params, { events: extra, profiles: extra });
    expect(filters).toContain('sa_cohort_members');
    expect(filters).toContain('clklog_sa.sa_events');
    expect(filters).toContain('clklog_sa.sa_user_profiles');
    expect(filters).not.toContain('SELECT *');
  });

  it('SQL 分群 logicalTablesOnly 拒绝成员表', () => {
    expectDomainError(
      () => service.guard('SELECT uid FROM sa_cohort_members', params, { logicalTablesOnly: true }),
      'report.sql.nonLogicalTable',
    );
    expectDomainError(
      () => service.guard('SELECT uid FROM clklog_sa.sa_tag_members', params, { logicalTablesOnly: true }),
      'report.sql.nonLogicalTable',
    );
    expect(() =>
      service.guard('SELECT uid FROM sa_events', params, { logicalTablesOnly: true }),
    ).not.toThrow();
  });

  it('用户 SQL 白名单不含 sa_datatable_rows（仅服务端生成器可 JOIN 维表）', () => {
    expectDomainError(
      () => service.guard('SELECT pk FROM clklog_sa.sa_datatable_rows', params),
      'report.sql.tableForbidden',
    );
    expectDomainError(
      () => service.guard('SELECT pk FROM sa_datatable_rows', params),
      'report.sql.tableForbidden',
    );
  });

  describe('无过滤 + 解析 properties 的 sa_events 扫描', () => {
    it('拒绝整条语句无 WHERE 的 properties 解析（2026-09-21 实测预估 1818 秒）', () => {
      expectDomainError(
        () =>
          service.guard(
            "SELECT JSONExtractString(properties, 'os') AS plat, count() AS n FROM clklog_sa.sa_events GROUP BY plat ORDER BY n DESC LIMIT 40",
            params,
          ),
        'report.sql.scanRequiresFilter',
      );
    });

    it('拒绝无 WHERE 的 properties 分组（物化整个 JSON 大列）', () => {
      expectDomainError(
        () => service.guard('SELECT properties, count() FROM sa_events GROUP BY properties', params),
        'report.sql.scanRequiresFilter',
      );
    });

    it('注释里的 WHERE 不能绕过（tokenize 丢弃注释）', () => {
      expectDomainError(
        () =>
          service.guard(
            "-- 这里写 WHERE 不算\nSELECT JSONExtractString(properties, 'os') FROM sa_events",
            params,
          ),
        'report.sql.scanRequiresFilter',
      );
    });

    it('带 WHERE 过滤的 properties 解析放行', () => {
      expect(() =>
        service.guard(
          "SELECT JSONExtractString(properties, 'rtime') AS rtime FROM clklog_sa.sa_events WHERE event = 'base_performance_cdn_download_report' LIMIT 10",
          params,
        ),
      ).not.toThrow();
    });

    it('无 WHERE 但只读系统字段的全窗口聚合放行（event 是 ORDER BY 首列，可裁剪 granule）', () => {
      expect(() => service.guard('SELECT event, count() FROM sa_events GROUP BY event', params)).not.toThrow();
      expect(() => service.guard('SELECT count() FROM clklog_sa.sa_events', params)).not.toThrow();
      expect(() => service.guard('SELECT os, count() FROM sa_events GROUP BY os', params)).not.toThrow();
    });
  });
});
