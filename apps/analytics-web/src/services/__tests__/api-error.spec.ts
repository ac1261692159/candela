import { describe, expect, it } from 'vitest';
import { i18n } from '../../i18n';
import { toUserFacingApiError } from '../api-error';
import { resolveParamKeys } from '../error-params';

describe('toUserFacingApiError', () => {
  it('hides ClickHouse connection refused details', () => {
    const msg = toUserFacingApiError({
      message: 'connect ECONNREFUSED 127.0.0.1:8123',
      httpStatus: 500,
    });
    expect(msg).toContain('数据查询服务暂时不可用');
    expect(msg).not.toMatch(/ECONNREFUSED|8123|127\.0\.0\.1/);
  });

  it('hides network errors when the API process is down', () => {
    const msg = toUserFacingApiError({
      message: 'Network Error',
      code: 'ERR_NETWORK',
    });
    expect(msg).toContain('分析服务暂时无法连接');
    expect(msg).not.toMatch(/Network Error/i);
  });

  it('maps proxy 502 to a recoverable service message', () => {
    const msg = toUserFacingApiError({
      message: 'Error occurred while trying to proxy: /sa/api/meta/events',
      httpStatus: 502,
      code: 'ERR_BAD_RESPONSE',
    });
    expect(msg).toContain('分析服务暂时无法连接');
  });

  it('maps request timeout without leaking duration internals as the lead', () => {
    const msg = toUserFacingApiError({
      message: 'timeout of 60000ms exceeded',
      code: 'ECONNABORTED',
    });
    expect(msg).toContain('请求超时');
  });

  it('keeps business validation copy', () => {
    expect(
      toUserFacingApiError({
        message: '事件名不能为空',
        httpStatus: 400,
      }),
    ).toBe('事件名不能为空');
  });

  it('keeps ClickHouse SQL identifier errors for the SQL editor', () => {
    const raw = 'Code: 47. DB::Exception: Unknown identifier: foo';
    expect(toUserFacingApiError({ message: raw, httpStatus: 400 })).toBe(raw);
  });

  it('joins array messages from validation filters', () => {
    expect(
      toUserFacingApiError({
        message: ['显示名不能为空', '状态不合法'],
        httpStatus: 400,
      }),
    ).toBe('显示名不能为空；状态不合法');
  });

  it('maps 403/429 without exposing stack traces', () => {
    expect(toUserFacingApiError({ httpStatus: 403, message: 'Forbidden' })).toBe(
      '没有权限执行此操作',
    );
    expect(toUserFacingApiError({ httpStatus: 429 })).toContain('过于频繁');
  });

  it('hides empty 500 from a dead Vite proxy', () => {
    const msg = toUserFacingApiError({
      message: 'Request failed with status code 500',
      httpStatus: 500,
      code: 'ERR_BAD_RESPONSE',
    });
    expect(msg).toContain('分析服务暂时无法连接');
    expect(msg).not.toMatch(/Request failed|status code/i);
  });
});

/**
 * 校验失败的字段名参数（i18n v1 补交）：服务端下发 `field`（中文兜底）+ `field_key`（资源键），
 * 渲染前按当前语言解析 `*_key`，复用界面唯一资源，不把键名或空串露给用户。
 */
describe('resolveParamKeys（错误参数的显示名解析）', () => {
  it('field_key 按当前语言解析并覆盖中文兜底', () => {
    expect(
      toUserFacingApiError({
        messageKey: 'alerting:error.validate.required',
        params: { field: 'SMTP 服务器', field_key: 'alerting:channelConfig.smtp.field.host' },
        httpStatus: 400,
      }),
    ).toBe('请填写「SMTP 服务器」');
  });

  it('英文渲染（资源存在时）取英文显示名', () => {
    const resolved = resolveParamKeys(
      { field: 'SMTP 服务器', field_key: 'alerting:channelConfig.smtp.field.host' },
      (key) => i18n.t(key, { lng: 'en-US' }),
    );
    expect(resolved?.field).toBe('SMTP server');
  });

  it('无 key / 键不存在 / 无参数时原样返回，不产生半截文案', () => {
    const params = { channel: 'smtp' };
    expect(resolveParamKeys(params, () => '')).toBe(params);
    expect(
      resolveParamKeys({ field: '端口', field_key: 'alerting:missing.key' }, () => 'alerting:missing.key')?.field,
    ).toBe('端口');
    expect(resolveParamKeys(undefined, () => 'x')).toBeUndefined();
    expect(resolveParamKeys(null, () => 'x')).toBeUndefined();
  });
});
