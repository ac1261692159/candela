/**
 * ClickHouse 预算类错误 → 可读领域错误（机器码 + 可执行文案）单测。
 * 依据：2026-09-21 排查中 `system.query_log` 实测 160 = TOO_SLOW
 * （`Estimated query execution time (1818.45 seconds) is too long. Maximum: 300`）。
 */
import { DomainError } from '../../src/i18n/domain-error';
import { toQueryBudgetError } from '../../src/modules/query-budget/query-budget-error';

function chError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, type: 'ClickHouseError' });
}

describe('toQueryBudgetError', () => {
  it('160/158（预估或墙钟超时）→ queryTimeout，带秒数参数', () => {
    const timeout = toQueryBudgetError(
      chError('160', 'Estimated query execution time (1818.4511945670909 seconds) is too long. Maximum: 300.'),
      300,
    ) as DomainError;
    expect(timeout).toBeInstanceOf(DomainError);
    expect(timeout).toMatchObject({
      status: 400,
      errorCode: 'report.sql.queryTimeout',
      messageKey: 'report:error.sql.queryTimeout',
      params: { seconds: 300 },
    });
    expect(timeout.message).toContain('300');
  });

  it('158 墙钟超时同样归到 queryTimeout', () => {
    const err = toQueryBudgetError(chError('158', 'Timeout exceeded: elapsed 300.1 seconds'), 300);
    expect((err as DomainError).errorCode).toBe('report.sql.queryTimeout');
  });

  it('241/307/321（内存、行数、字节）→ queryTooLarge', () => {
    for (const code of ['241', '307', '321']) {
      const err = toQueryBudgetError(chError(code, 'Limit for rows or bytes to read exceeded'), 300);
      expect((err as DomainError).errorCode).toBe('report.sql.queryTooLarge');
    }
  });

  it('无 errorCode 时按原文兜底识别（客户端不同版本的错误形状）', () => {
    const byMessage = toQueryBudgetError(
      new Error('Code: 160. DB::Exception: Estimated query execution time (2333.6 seconds) is too long. Maximum: 300'),
      300,
    );
    expect((byMessage as DomainError).errorCode).toBe('report.sql.queryTimeout');
  });

  it('与预算无关的错误返回 null（调用方透传原错误）', () => {
    expect(toQueryBudgetError(new Error('Code: 47. DB::Exception: Unknown identifier: foo'), 300)).toBeNull();
    expect(toQueryBudgetError(undefined, 300)).toBeNull();
  });
});
