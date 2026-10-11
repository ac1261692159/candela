import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DISK_TREND_MAX_HOURS, DiskTrendDto } from '../../src/modules/ops/dto/alert.dto';

const OPTS = { whitelist: true, forbidNonWhitelisted: true } as const;

async function check(plain: Record<string, unknown>) {
  const dto = plainToInstance(DiskTrendDto, plain);
  const errors = await validate(dto, OPTS);
  return errors.map((e) => `${e.property}: ${e.constraints ? Object.values(e.constraints).join('; ') : ''}`);
}

describe('DiskTrendDto', () => {
  it('接受前端默认 180 天（小时）', async () => {
    expect(DISK_TREND_MAX_HOURS).toBe(4320);
    expect(await check({ hours: '4320', path: '/data' })).toEqual([]);
  });

  it('拒绝超过 180 天', async () => {
    const errors = await check({ hours: '4321' });
    expect(errors.some((e) => e.startsWith('hours:'))).toBe(true);
  });
});
