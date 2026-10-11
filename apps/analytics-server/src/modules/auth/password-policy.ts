import { randomBytes } from 'crypto';
import { badRequest } from '../../i18n/domain-error';

/**
 * 密码策略（phase: clklog-analytics-account-lifecycle-v1）：
 * ≥8 位 + 弱口令黑名单 + 不得包含用户名（大小写不敏感）。
 * 设计 SSOT：`docs/architecture/clklog-analytics-design-account-lifecycle-v1.md` §2。
 *
 * 只在新设/修改密码时触发；存量短密码不追溯。
 */
export const PASSWORD_MIN_LENGTH = 8;

const WEAK_PASSWORDS: readonly string[] = [
  'password',
  'password1',
  'passw0rd',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty123',
  'qwertyuiop',
  '11111111',
  '00000000',
  '87654321',
  'abc12345',
  'abcd1234',
  'iloveyou',
  'admin123',
  'admin1234',
  'root1234',
  'letmein123',
  'welcome1',
  'changeme',
  'clklog123',
  'clklog2024',
  'clklog2025',
  'clklog2026',
  'p@ssw0rd',
  'p@ssw0rd1',
];

export function assertPasswordPolicy(password: string, username: string): void {
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    throw badRequest({
      code: 'auth.password.tooShort',
      messageKey: 'auth:error.password.tooShort',
      params: { min: PASSWORD_MIN_LENGTH },
      message: `密码至少 ${PASSWORD_MIN_LENGTH} 位`,
    });
  }
  const lowered = password.toLowerCase();
  if (WEAK_PASSWORDS.includes(lowered)) {
    throw badRequest({
      code: 'auth.password.weak',
      messageKey: 'auth:error.password.weak',
      message: '密码过于常见，请换一个更不容易猜到的密码',
    });
  }
  if (username && lowered.includes(username.toLowerCase())) {
    throw badRequest({
      code: 'auth.password.containsUsername',
      messageKey: 'auth:error.password.containsUsername',
      message: '密码不能包含用户名',
    });
  }
}

/** 无歧义字母表（去 0/o/1/l/i 等易混字符） */
const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * 管理员重置密码用的一次性临时密码：12 位、CSPRNG。
 * 明文只存在于生成当次的响应里，入库的只有哈希（account-lifecycle §5）。
 */
export function generateTemporaryPassword(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i += 1) {
    out += TEMP_ALPHABET[bytes[i] % TEMP_ALPHABET.length];
  }
  return out;
}
