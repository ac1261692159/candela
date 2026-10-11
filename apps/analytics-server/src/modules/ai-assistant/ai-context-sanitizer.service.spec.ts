import { AiContextSanitizerService } from './ai-context-sanitizer.service';

describe('AiContextSanitizerService', () => {
  let service: AiContextSanitizerService;

  beforeEach(() => {
    service = new AiContextSanitizerService();
  });

  it('递归删除身份与凭据字段', () => {
    const result = service.sanitize({
      token: 'secret-token',
      nested: {
        distinct_id: 'anonymous-user',
        accessToken: 'camel-case-secret',
        project_name: 'other-project',
        metric: 12,
      },
    });

    expect(result.value).toEqual({
      nested: { metric: 12 },
      _truncated: true,
    });
    expect(JSON.stringify(result.value)).not.toContain('secret');
    expect(JSON.stringify(result.value)).not.toContain('anonymous-user');
    expect(JSON.stringify(result.value)).not.toContain('other-project');
  });

  it('掩码手机号、邮箱和身份证', () => {
    const result = service.sanitize({
      result: {
        values: [
          '13812345678',
          'alice@example.com',
          '11010519491231002X',
        ],
      },
    });
    const text = JSON.stringify(result.value);

    expect(text).toContain('138****5678');
    expect(text).toContain('a***@example.com');
    expect(text).toContain('110***********002X');
    expect(text).not.toContain('13812345678');
    expect(text).not.toContain('alice@example.com');
  });

  it('结果数组最多保留 100 项并标记截断', () => {
    const result = service.sanitize({
      result: { rows: Array.from({ length: 120 }, (_, index) => ({ index })) },
    });
    const rows = (result.value.result as { rows: unknown[] }).rows;

    expect(rows).toHaveLength(101);
    expect(rows[100]).toEqual({ _truncated_items: 20 });
    expect(result.truncated).toBe(true);
  });

  it('整体输出不超过 128 KiB', () => {
    const result = service.sanitize({
      page: 'event',
      route: '/analysis/event',
      analysis: { dsl: 'x'.repeat(32_000) },
      result: {
        rows: Array.from({ length: 100 }, () => ({ value: '中'.repeat(2_000) })),
      },
    });

    expect(Buffer.byteLength(JSON.stringify(result.value), 'utf8')).toBeLessThanOrEqual(128 * 1024);
    expect(result.truncated).toBe(true);
  });

  it('用户问题也进行敏感值掩码', () => {
    expect(service.sanitizeText('分析 13812345678 和 alice@example.com')).toBe(
      '分析 138****5678 和 a***@example.com',
    );
  });
});
