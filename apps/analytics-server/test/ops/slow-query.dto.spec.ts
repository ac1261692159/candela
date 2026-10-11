// 必须在 import class-validator 之前 polyfill reflect-metadata
import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SlowQueryListDto } from '../../src/modules/ops/dto/slow-query.dto';

const OPTS = { whitelist: true, forbidNonWhitelisted: true } as const;

async function check(plain: Record<string, unknown>) {
  const dto = plainToInstance(SlowQueryListDto, plain);
  const errors = await validate(dto, OPTS);
  return errors.map((e) => `${e.property}: ${e.constraints ? Object.values(e.constraints).join('; ') : ''}`);
}

describe('SlowQueryListDto', () => {
  it('空对象合法', async () => {
    expect(await check({})).toEqual([]);
  });

  it('接受合法参数', async () => {
    expect(await check({ hours: '24', min_duration_ms: '5000', status: 'all', limit: '100' })).toEqual([]);
  });

  // 前端 axios 会从 project store 自动加 ?project=（慢 SQL 是平台级查询，不参与过滤）
  it('接受 axios 自动注入的 project 参数', async () => {
    expect(await check({ hours: '24', project: 'clklogapp' })).toEqual([]);
  });

  it('拒绝越界 hours', async () => {
    const errors = await check({ hours: '999' });
    expect(errors.some((e) => e.startsWith('hours:'))).toBe(true);
  });

  it('拒绝非法 status', async () => {
    const errors = await check({ status: 'nope' });
    expect(errors.some((e) => e.startsWith('status:'))).toBe(true);
  });
});
