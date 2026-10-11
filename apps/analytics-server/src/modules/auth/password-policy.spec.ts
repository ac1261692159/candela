import { assertPasswordPolicy, generateTemporaryPassword, PASSWORD_MIN_LENGTH } from './password-policy';
import { DomainError } from '../../i18n/domain-error';

describe('password-policy（account-lifecycle-v1，AL-2）', () => {
  it('短于 8 位拒绝，恰好 8 位通过', () => {
    expect(() => assertPasswordPolicy('1234567'.slice(0, 7), 'user1')).toThrow(DomainError);
    try {
      assertPasswordPolicy('a'.repeat(7), 'user1');
      fail('应当抛出');
    } catch (e) {
      expect((e as DomainError).errorCode).toBe('auth.password.tooShort');
      expect((e as DomainError).params).toEqual({ min: PASSWORD_MIN_LENGTH });
    }
    expect(() => assertPasswordPolicy('xK9#mQ2v', 'user1')).not.toThrow();
  });

  it('弱口令黑名单拒绝（大小写不敏感）', () => {
    for (const weak of ['12345678', 'password', 'PASSWORD', 'qwerty123']) {
      try {
        assertPasswordPolicy(weak, 'user1');
        fail(`应当拒绝弱口令 ${weak}`);
      } catch (e) {
        expect((e as DomainError).errorCode).toBe('auth.password.weak');
      }
    }
  });

  it('包含用户名拒绝（大小写不敏感）', () => {
    try {
      assertPasswordPolicy('xxUser1xxxx', 'user1');
      fail('应当抛出');
    } catch (e) {
      expect((e as DomainError).errorCode).toBe('auth.password.containsUsername');
    }
  });

  it('临时密码：12 位、无歧义字符、两次不同', () => {
    const a = generateTemporaryPassword();
    const b = generateTemporaryPassword();
    expect(a).toHaveLength(12);
    expect(a).toMatch(/^[a-zA-Z2-9]+$/);
    expect(a).not.toMatch(/[01oli]/);
    expect(a).not.toBe(b);
  });
});
