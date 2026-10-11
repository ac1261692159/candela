import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

/**
 * 密码哈希（Node 内置 crypto scrypt，无额外依赖）。
 * 格式：`salt:hash`（hex），verify 用 timingSafeEqual 防时序攻击。
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
