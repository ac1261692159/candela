/**
 * password.util 单测。
 */
import { hashPassword, verifyPassword } from '../../src/modules/auth/password.util';

describe('password.util', () => {
  it('哈希后能验证正确密码', () => {
    const hash = hashPassword('secret123');
    expect(hash).toContain(':');
    expect(verifyPassword('secret123', hash)).toBe(true);
  });

  it('错误密码验证失败', () => {
    const hash = hashPassword('secret123');
    expect(verifyPassword('wrong', hash)).toBe(false);
  });

  it('同密码每次哈希结果不同（salt 随机）', () => {
    const h1 = hashPassword('same');
    const h2 = hashPassword('same');
    expect(h1).not.toBe(h2);
    expect(verifyPassword('same', h1)).toBe(true);
    expect(verifyPassword('same', h2)).toBe(true);
  });
});
