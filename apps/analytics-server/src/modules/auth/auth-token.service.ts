import { createHash, randomBytes } from 'crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { badRequest, domainError, notFound } from '../../i18n/domain-error';

/**
 * 一次性令牌（phase: clklog-analytics-account-lifecycle-v2 §3）。
 * 明文只存在于当次返回与邮件链接；库内只存 sha256。
 * 同类新令牌签发即作废旧令牌（「最新一封才有效」）。
 */
export const TOKEN_PURPOSES = {
  passwordReset: 'password_reset',
  accountSetup: 'account_setup',
} as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[keyof typeof TOKEN_PURPOSES];

/** 密码重置 30 分钟、设密 72 小时 */
const TTL_MINUTES: Record<TokenPurpose, number> = {
  [TOKEN_PURPOSES.passwordReset]: 30,
  [TOKEN_PURPOSES.accountSetup]: 72 * 60,
};

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

@Injectable()
export class AuthTokenService {
  constructor(private readonly prisma: PrismaService) {}

  /** 签发：作废旧同类令牌 → 返回明文 token（仅此一次可见） */
  async issue(purpose: TokenPurpose, userId: string, email: string): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + TTL_MINUTES[purpose] * 60000);
    await this.prisma.saAuthToken.updateMany({
      where: { email, purpose, used_at: null },
      data: { used_at: new Date() },
    });
    const token = randomBytes(32).toString('hex');
    await this.prisma.saAuthToken.create({
      data: { user_id: userId, email, purpose, token_hash: sha256Hex(token), expires_at: expiresAt },
    });
    return { token, expiresAt };
  }

  /** 最近一封（任意用途未使用）签发距今不足 seconds → 抛 429（60 秒限流，PRD AM-3） */
  async assertEmailQuota(email: string, table: 'token' | 'invitation' | 'both' = 'token') {
    if (table !== 'invitation') {
      const recentToken = await this.prisma.saAuthToken.findFirst({
        where: { email, used_at: null },
        orderBy: { created_at: 'desc' },
      });
      if (recentToken && Date.now() - recentToken.created_at.getTime() < 60_000) throw tooOften();
    }
    if (table !== 'token') {
      const recentInvite = await this.prisma.saInvitation.findFirst({
        where: { email, accepted_at: null },
        orderBy: { created_at: 'desc' },
      });
      if (recentInvite && Date.now() - recentInvite.created_at.getTime() < 60_000) throw tooOften();
    }
  }

  /** 消费：校验哈希+用途+未用+未过期，原子标记 used_at；失效一律 400 token.invalid */
  async consume(purpose: TokenPurpose, token: string) {
    const row = await this.prisma.saAuthToken.findUnique({ where: { token_hash: sha256Hex(token) } });
    if (!row || row.purpose !== purpose || row.used_at || row.expires_at.getTime() < Date.now()) {
      throw badRequest({
        code: 'auth.tokenLink.invalid',
        messageKey: 'auth:error.tokenLink.invalid',
        message: '链接已失效，请重新发起',
      });
    }
    const updated = await this.prisma.saAuthToken.updateMany({
      where: { id: row.id, used_at: null },
      data: { used_at: new Date() },
    });
    if (updated.count === 0) {
      throw badRequest({
        code: 'auth.tokenLink.invalid',
        messageKey: 'auth:error.tokenLink.invalid',
        message: '链接已失效，请重新发起',
      });
    }
    return row;
  }
}

function tooOften() {
  return domainError(HttpStatus.TOO_MANY_REQUESTS, {
    code: 'auth.mail.tooOften',
    messageKey: 'auth:error.mail.tooOften',
    message: '操作过于频繁，请 60 秒后再试',
  });
}

/** 邀请域自身的失效错误（404，避免泄露令牌有效性细节） */
export function invalidInvite() {
  return notFound({
    code: 'auth.tokenLink.invalid',
    messageKey: 'auth:error.tokenLink.invalid',
    message: '链接已失效，请重新发起',
  });
}
