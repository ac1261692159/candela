import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../shared/prisma.service';
import { badRequest, conflict, domainError, notFound } from '../../i18n/domain-error';
import { isValidTimeZoneName } from '../time/calendar';
import { TimezoneService } from '../time/timezone.service';
import { hashPassword, verifyPassword } from './password.util';
import { assertPasswordPolicy, generateTemporaryPassword } from './password-policy';
import { AuthAuditService } from './auth-audit.service';
import { AuthTokenService, TOKEN_PURPOSES, sha256Hex, type TokenPurpose } from './auth-token.service';
import { AuthMailService } from './auth-mail.service';

export interface AuthUser {
  id: string;
  username: string;
  display_name: string | null;
  /** 可空唯一邮箱（account-lifecycle-v1）；null = 未填写 */
  email?: string | null;
  platform_role: 'super_admin' | 'none';
  default_project?: string | null;
  /** 界面语言偏好（BCP-47）；null/缺省 = 未设置，前端按浏览器语言解析 */
  locale?: string | null;
  /** 显示时区偏好（IANA；null/缺省 = 跟随项目/平台，timezone-v2） */
  timezone?: string | null;
  /** 管理员代设密码后强制首登改密（account-lifecycle-v1） */
  must_change_password?: boolean;
}

/** 语言标签格式（BCP-47 子集）；支持哪些语言由前端注册表决定，服务端只做格式与长度校验 */
const LOCALE_TAG_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

const TOKEN_TTL_DAYS = 7;

/** 登录锁定策略（account-lifecycle-v1，PRD §5.3 为产品权威） */
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MINUTES = 15;

/** 通用邮箱格式（私有化部署不依赖外部校验服务） */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email: string | null | undefined): string | null {
  if (email === undefined || email === null) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    // 缺省构造兜底纯单测；生产由 DI 注入（TimeModule @Global）
    private readonly timezones: TimezoneService = new TimezoneService(undefined),
    @Optional() private readonly audit?: AuthAuditService,
    @Optional() private readonly tokens?: AuthTokenService,
    @Optional() private readonly mail?: AuthMailService,
  ) {}

  /** 邮件通道是否可用（用户管理建号弹窗据此显隐「发送设密邮件」；含库内配置 v1.1） */
  async mailStatus() {
    const cfg = await this.mail!.effectiveConfig();
    return { smtp_configured: cfg.enabled && Boolean(cfg.host) };
  }

  /**
   * 忘记密码（account-lifecycle-v2，AM-1/2/3）：
   * 命中 username 或 email 且账号 active 且有邮箱 → 60s 限流校验 → 签发重置令牌 → 发信。
   * 无论命中与否返回相同应答（防枚举）；审计 detail 只记 identifier 哈希前缀。
   */
  async forgotPassword(identifier: string) {
    const idf = (identifier ?? '').trim();
    if (idf) {
      const user = await this.prisma.saUser.findFirst({
        where: { OR: [{ username: idf }, { email: idf.toLowerCase() }] },
      });
      if (user?.email && user.status === 'active' && this.mail && this.tokens) {
        const mailCfg = await this.mail.effectiveConfig();
        if (!mailCfg.enabled || !mailCfg.host) {
          await this.audit?.record('auth_reset_request', 'anonymous', {
            identifier_hash: sha256Hex(idf.toLowerCase()).slice(0, 12),
          });
          return { ok: true };
        }
        await this.tokens.assertEmailQuota(user.email, 'both');
        const { token } = await this.tokens.issue(TOKEN_PURPOSES.passwordReset, user.id, user.email);
        const link = await this.mail.buildLink(`/sa/reset-password?token=${token}`);
        const sent = await this.mail.sendTemplate(user.email, user.locale, 'reset', { link, minutes: 30 });
        if (!sent) {
          await this.audit?.record('auth_mail_failed', user.username, { kind: 'reset', email_hash: sha256Hex(user.email).slice(0, 12) });
        }
      }
      await this.audit?.record('auth_reset_request', 'anonymous', {
        identifier_hash: sha256Hex(idf.toLowerCase()).slice(0, 12),
      });
    }
    return { ok: true };
  }

  /** 设密页不分重置/设密：两种用途按序尝试（purpose 不匹配的 consume 无副作用） */
  async setPasswordWithAnyPurpose(token: string, newPassword: string) {
    try {
      return await this.setPasswordWithToken(TOKEN_PURPOSES.passwordReset, token, newPassword);
    } catch (e) {
      if (e instanceof Error && 'errorCode' in e && (e as { errorCode?: string }).errorCode === 'auth.tokenLink.invalid') {
        return this.setPasswordWithToken(TOKEN_PURPOSES.accountSetup, token, newPassword);
      }
      throw e;
    }
  }

  /**
   * 通过令牌设新密码（重置或首登设密，purpose 由调用方定）：
   * 消费令牌 → 策略校验 → 写 hash、解除强制改密与锁定、吊销全部会话（AM-1/AM-4）。
   */
  async setPasswordWithToken(purpose: TokenPurpose, token: string, newPassword: string) {
    if (!this.tokens) throw badRequest({ code: 'auth.tokenLink.invalid', messageKey: 'auth:error.tokenLink.invalid', message: '链接已失效，请重新发起' });
    const row = await this.tokens.consume(purpose, token);
    const user = row.user_id
      ? await this.prisma.saUser.findUnique({ where: { id: row.user_id } })
      : null;
    if (!user || user.status !== 'active') {
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'auth.user.notFoundOrDisabled',
        messageKey: 'auth:error.user.notFoundOrDisabled',
        message: '用户不存在或已禁用',
      });
    }
    assertPasswordPolicy(newPassword, user.username);
    await this.prisma.saUser.update({
      where: { id: user.id },
      data: {
        password_hash: hashPassword(newPassword),
        must_change_password: false,
        failed_login_count: 0,
        locked_until: null,
      },
    });
    await this.prisma.saUserToken.deleteMany({ where: { user_id: user.id } });
    await this.audit?.record('auth_reset_complete', user.username, { user_id: user.id, purpose });
    return { ok: true };
  }

  /**
   * 登录：锁定检查 → 校验密码（失败计数，5 次锁 15 分钟）→ 签发 token。
   * 用户不存在不计数（防探测）；审计成功/失败/锁定三类事件。
   */
  async login(username: string, password: string) {
    const user = await this.prisma.saUser.findUnique({ where: { username } });
    if (!user || user.status !== 'active') {
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'auth.login.invalidCredentials',
        messageKey: 'auth:error.login.invalidCredentials',
        message: '用户名或密码错误',
      });
    }
    const now = Date.now();
    if (user.locked_until && user.locked_until.getTime() > now) {
      const minutes = Math.max(1, Math.ceil((user.locked_until.getTime() - now) / 60000));
      await this.audit?.record('auth_login_locked', username, {
        username,
        locked_until: user.locked_until.toISOString(),
      });
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'auth.login.locked',
        messageKey: 'auth:error.login.locked',
        params: { minutes },
        message: `账号已锁定，请 ${minutes} 分钟后再试`,
      });
    }
    if (!verifyPassword(password, user.password_hash)) {
      const failCount = user.failed_login_count + 1;
      const reachedLimit = failCount >= LOGIN_MAX_ATTEMPTS;
      await this.prisma.saUser.update({
        where: { id: user.id },
        data: reachedLimit
          ? { failed_login_count: 0, locked_until: new Date(now + LOGIN_LOCK_MINUTES * 60000) }
          : { failed_login_count: failCount },
      });
      await this.audit?.record('auth_login_failed', username, { username, fail_count: failCount });
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'auth.login.invalidCredentials',
        messageKey: 'auth:error.login.invalidCredentials',
        message: '用户名或密码错误',
      });
    }

    // 成功：清零锁定状态、记录最近登录
    if (user.failed_login_count > 0 || user.locked_until) {
      await this.prisma.saUser.update({
        where: { id: user.id },
        data: { failed_login_count: 0, locked_until: null, last_login_at: new Date(now) },
      });
    } else {
      await this.prisma.saUser.update({ where: { id: user.id }, data: { last_login_at: new Date(now) } });
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(now + TOKEN_TTL_DAYS * 24 * 3600 * 1000);
    await this.prisma.saUserToken.create({
      data: { user_id: user.id, token, expires_at: expiresAt },
    });
    await this.audit?.record('auth_login_success', username, { username });

    return {
      token,
      user: {
        ...this.toUser(user),
        // 实例级平台时区下发（phase: clklog-analytics-timezone-v1）：前端初始化展示基调
        platform_timezone: this.timezones.platformTz,
      },
    };
  }

  /** 登出：撤销 token */
  async logout(token: string) {
    await this.prisma.saUserToken.deleteMany({ where: { token } });
    return { ok: true };
  }

  /** 校验 token，返回用户（供 AuthGuard 用） */
  async validateToken(token: string): Promise<AuthUser> {
    const record = await this.prisma.saUserToken.findUnique({
      where: { token },
      include: { user: true },
    });
    if (!record) {
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'auth.token.invalid',
        messageKey: 'auth:error.token.invalid',
        message: '无效的 token',
      });
    }
    if (record.expires_at && record.expires_at.getTime() < Date.now()) {
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'auth.token.expired',
        messageKey: 'auth:error.token.expired',
        message: 'token 已过期',
      });
    }
    if (record.user.status !== 'active') {
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'auth.user.disabled',
        messageKey: 'auth:error.user.disabled',
        message: '用户已禁用',
      });
    }
    return this.toUser(record.user);
  }

  /** 当前用户信息（附实例级平台时区，phase: clklog-analytics-timezone-v1） */
  async me(user: AuthUser) {
    return { ...user, platform_timezone: this.timezones.platformTz };
  }

  /**
   * 更新个人偏好（默认项目 / 界面语言）：**部分更新**，只写传入的字段。
   * 不传的字段保持已存值（避免「只改语言顺手清空默认项目」这类静默丢失）。
   */
  async updatePreferences(
    user: AuthUser,
    dto: { default_project?: string | null; locale?: string | null; timezone?: string | null },
  ) {
    const data: { default_project?: string | null; locale?: string | null; timezone?: string | null } = {};
    if ('default_project' in dto) data.default_project = dto.default_project ?? null;
    if ('timezone' in dto) {
      const tz = dto.timezone ?? null;
      if (tz !== null && !isValidTimeZoneName(tz)) {
        throw badRequest({
          code: 'auth.timezone.invalid',
          messageKey: 'auth:error.timezone.invalid',
          message: 'timezone 不是合法的 IANA 时区名',
        });
      }
      data.timezone = tz;
    }
    if ('locale' in dto) {
      const locale = dto.locale ?? null;
      if (locale !== null && !LOCALE_TAG_RE.test(locale)) {
        throw badRequest({
          code: 'auth.locale.invalid',
          messageKey: 'auth:error.locale.invalid',
          message: 'locale 不是合法的语言标签',
        });
      }
      data.locale = locale;
    }
    if (Object.keys(data).length === 0) {
      throw badRequest({
        code: 'auth.preferences.empty',
        messageKey: 'auth:error.preferences.empty',
        message: '没有可更新的偏好字段',
      });
    }

    const updated = await this.prisma.saUser.update({
      where: { id: user.id },
      data,
      select: { default_project: true, locale: true, timezone: true },
    });
    return { ok: true, default_project: updated.default_project, locale: updated.locale, timezone: updated.timezone };
  }

  /** 编辑本人基本资料（显示名 / 邮箱，account-lifecycle-v1）：部分更新 */
  async updateProfile(user: AuthUser, dto: { display_name?: string; email?: string | null }) {
    const data: { display_name?: string | null; email?: string | null } = {};
    if ('display_name' in dto) data.display_name = dto.display_name?.trim() || null;
    if ('email' in dto) {
      const email = normalizeEmail(dto.email);
      if (email !== null && !EMAIL_RE.test(email)) {
        throw badRequest({
          code: 'auth.email.invalid',
          messageKey: 'auth:error.email.invalid',
          message: '邮箱格式不正确',
        });
      }
      if (email !== null) {
        const dup = await this.prisma.saUser.findFirst({ where: { email, NOT: { id: user.id } } });
        if (dup) {
          throw conflict({
            code: 'auth.email.exists',
            messageKey: 'auth:error.email.exists',
            message: '邮箱已被其他账号使用',
          });
        }
      }
      data.email = email;
    }
    if (Object.keys(data).length === 0) {
      throw badRequest({
        code: 'auth.profile.empty',
        messageKey: 'auth:error.profile.empty',
        message: '没有可更新的资料字段',
      });
    }
    const updated = await this.prisma.saUser.update({
      where: { id: user.id },
      data,
      select: { display_name: true, email: true },
    });
    await this.audit?.record('auth_user_update', user.username, {
      user_id: user.id,
      changed_fields: Object.keys(data),
    });
    return { ok: true, display_name: updated.display_name, email: updated.email };
  }

  /**
   * 修改密码：验证旧密码，应用密码策略，更新哈希，吊销除当前会话外的所有 token。
   * 成功后解除「强制首登改密」标记并清零登录锁定状态（account-lifecycle-v1）。
   */
  async changePassword(
    user: AuthUser,
    dto: { old_password: string; new_password: string },
    currentToken: string,
  ) {
    const row = await this.prisma.saUser.findUnique({ where: { id: user.id } });
    if (!row || row.status !== 'active') {
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'auth.user.notFoundOrDisabled',
        messageKey: 'auth:error.user.notFoundOrDisabled',
        message: '用户不存在或已禁用',
      });
    }
    if (!verifyPassword(dto.old_password, row.password_hash)) {
      throw badRequest({
        code: 'auth.password.oldMismatch',
        messageKey: 'auth:error.password.oldMismatch',
        message: '旧密码错误',
      });
    }
    assertPasswordPolicy(dto.new_password, row.username);
    await this.prisma.saUser.update({
      where: { id: user.id },
      data: {
        password_hash: hashPassword(dto.new_password),
        must_change_password: false,
        failed_login_count: 0,
        locked_until: null,
      },
    });
    // 其他会话全部登出，保留当前会话
    await this.prisma.saUserToken.deleteMany({
      where: { user_id: user.id, token: { not: currentToken } },
    });
    await this.audit?.record('auth_password_change', user.username, { user_id: user.id });
    return { ok: true };
  }

  /** 创建登录账号（默认无平台帽子；管理员代设密码 → 强制首登改密） */
  async createUser(
    operator: string,
    dto: { username: string; password: string; display_name?: string; email?: string | null; send_setup_email?: boolean },
  ) {
    // 建号设密邮件模式（account-lifecycle-v2 AM-4）：免密码，发设密链接
    if (dto.send_setup_email) {
      return this.createUserWithSetupEmail(operator, dto);
    }
    assertPasswordPolicy(dto.password, dto.username);
    const exists = await this.prisma.saUser.findUnique({ where: { username: dto.username } });
    if (exists) {
      throw conflict({
        code: 'auth.username.exists',
        messageKey: 'auth:error.username.exists',
        message: '用户名已存在',
      });
    }
    const email = normalizeEmail(dto.email);
    if (email !== null && !EMAIL_RE.test(email)) {
      throw badRequest({
        code: 'auth.email.invalid',
        messageKey: 'auth:error.email.invalid',
        message: '邮箱格式不正确',
      });
    }
    if (email !== null) {
      const dup = await this.prisma.saUser.findFirst({ where: { email } });
      if (dup) {
        throw conflict({
          code: 'auth.email.exists',
          messageKey: 'auth:error.email.exists',
          message: '邮箱已被其他账号使用',
        });
      }
    }
    const created = await this.prisma.saUser.create({
      data: {
        username: dto.username,
        password_hash: hashPassword(dto.password),
        display_name: dto.display_name,
        email,
        platform_role: 'none',
        created_by: operator,
        must_change_password: true,
      },
      select: { id: true, username: true, display_name: true, email: true, platform_role: true, status: true },
    });
    await this.audit?.record('auth_user_create', operator, { user_id: created.id, username: dto.username });
    return created;
  }

  /**
   * 发送设密邮件建号（AM-4）：随机占位口令（不可知），邮箱必填；
   * 签发 72h 设密令牌 → 用户点链接自行设密。SMTP 未配置 → notConfigured。
   */
  private async createUserWithSetupEmail(
    operator: string,
    dto: { username: string; display_name?: string; email?: string | null },
  ) {
    await this.mail?.assertConfigured();
    const email = normalizeEmail(dto.email);
    if (!email) {
      throw badRequest({
        code: 'auth.email.required',
        messageKey: 'auth:error.email.required',
        message: '发送设密邮件必须填写邮箱',
      });
    }
    if (!EMAIL_RE.test(email)) {
      throw badRequest({
        code: 'auth.email.invalid',
        messageKey: 'auth:error.email.invalid',
        message: '邮箱格式不正确',
      });
    }
    const exists = await this.prisma.saUser.findUnique({ where: { username: dto.username } });
    if (exists) {
      throw conflict({
        code: 'auth.username.exists',
        messageKey: 'auth:error.username.exists',
        message: '用户名已存在',
      });
    }
    const dup = await this.prisma.saUser.findFirst({ where: { email } });
    if (dup) {
      throw conflict({
        code: 'auth.email.exists',
        messageKey: 'auth:error.email.exists',
        message: '邮箱已被其他账号使用',
      });
    }
    await this.tokens!.assertEmailQuota(email, 'both');
    const placeholder = hashPassword(randomBytes(24).toString('hex'));
    const created = await this.prisma.saUser.create({
      data: {
        username: dto.username,
        password_hash: placeholder,
        display_name: dto.display_name,
        email,
        platform_role: 'none',
        created_by: operator,
        must_change_password: false,
      },
      select: { id: true, username: true, display_name: true, email: true, platform_role: true, status: true },
    });
    const { token } = await this.tokens!.issue(TOKEN_PURPOSES.accountSetup, created.id, email);
    const link = await this.mail!.buildLink(`/sa/reset-password?token=${token}`);
    const sent = await this.mail!.sendTemplate(email, null, 'setup', { link, hours: 72 });
    await this.audit?.record(sent ? 'auth_setup_send' : 'auth_mail_failed', operator, {
      user_id: created.id,
      username: dto.username,
      email_hash: sha256Hex(email).slice(0, 12),
    });
    return { ...created, setup_email_sent: sent };
  }

  /** 用户列表 */
  async listUsers() {
    return this.prisma.saUser.findMany({
      select: {
        id: true,
        username: true,
        display_name: true,
        email: true,
        platform_role: true,
        status: true,
        last_login_at: true,
        created_by: true,
        created_at: true,
      },
      orderBy: { created_at: 'asc' },
    });
  }

  /** 编辑用户资料 / 平台角色（admin）；自我保护：不能改自己的平台角色 */
  async updateUser(
    actor: AuthUser,
    id: string,
    dto: { display_name?: string | null; email?: string | null; platform_role?: 'super_admin' | 'none' },
  ) {
    const target = await this.prisma.saUser.findUnique({ where: { id } });
    if (!target) {
      throw notFound({
        code: 'auth.user.notFound',
        messageKey: 'auth:error.user.notFound',
        message: '用户不存在',
      });
    }
    if (id === actor.id && 'platform_role' in dto) {
      throw conflict({
        code: 'auth.self.forbidden',
        messageKey: 'auth:error.self.forbidden',
        message: '不能对自己的账号执行该操作',
      });
    }
    const data: { display_name?: string | null; email?: string | null; platform_role?: string } = {};
    if ('display_name' in dto) data.display_name = dto.display_name?.trim() || null;
    if ('email' in dto) {
      const email = normalizeEmail(dto.email);
      if (email !== null && !EMAIL_RE.test(email)) {
        throw badRequest({
          code: 'auth.email.invalid',
          messageKey: 'auth:error.email.invalid',
          message: '邮箱格式不正确',
        });
      }
      if (email !== null) {
        const dup = await this.prisma.saUser.findFirst({ where: { email, NOT: { id } } });
        if (dup) {
          throw conflict({
            code: 'auth.email.exists',
            messageKey: 'auth:error.email.exists',
            message: '邮箱已被其他账号使用',
          });
        }
      }
      data.email = email;
    }
    if ('platform_role' in dto) {
      if (dto.platform_role !== 'super_admin' && dto.platform_role !== 'none') {
        throw badRequest({
          code: 'auth.platformRole.invalid',
          messageKey: 'auth:error.platformRole.invalid',
          message: 'platform_role 只支持 super_admin / none',
        });
      }
      data.platform_role = dto.platform_role;
    }
    if (Object.keys(data).length === 0) {
      throw badRequest({
        code: 'auth.profile.empty',
        messageKey: 'auth:error.profile.empty',
        message: '没有可更新的资料字段',
      });
    }
    await this.prisma.saUser.update({ where: { id }, data });
    await this.audit?.record('auth_user_update', actor.username, {
      user_id: id,
      changed_fields: Object.keys(data),
    });
    return { ok: true };
  }

  /** 禁用/启用用户（admin）；自我保护：不能禁用自己 */
  async setUserStatus(actor: AuthUser, id: string, status: 'active' | 'disabled') {
    if (id === actor.id) {
      throw conflict({
        code: 'auth.self.forbidden',
        messageKey: 'auth:error.self.forbidden',
        message: '不能对自己的账号执行该操作',
      });
    }
    const target = await this.prisma.saUser.findUnique({ where: { id } });
    if (!target) {
      throw notFound({
        code: 'auth.user.notFound',
        messageKey: 'auth:error.user.notFound',
        message: '用户不存在',
      });
    }
    await this.prisma.saUser.update({ where: { id }, data: { status } });
    // 禁用时撤销其所有 token
    if (status === 'disabled') {
      await this.prisma.saUserToken.deleteMany({ where: { user_id: id } });
    }
    await this.audit?.record('auth_user_status', actor.username, { user_id: id, status });
    return { ok: true };
  }

  /** 解锁登录锁定（admin）：清失败计数与锁定截止；幂等 */
  async unlockUser(actor: AuthUser, id: string) {
    const target = await this.prisma.saUser.findUnique({ where: { id } });
    if (!target) {
      throw notFound({
        code: 'auth.user.notFound',
        messageKey: 'auth:error.user.notFound',
        message: '用户不存在',
      });
    }
    await this.prisma.saUser.update({ where: { id }, data: { failed_login_count: 0, locked_until: null } });
    await this.audit?.record('auth_user_unlock', actor.username, { user_id: id });
    return { ok: true };
  }

  /**
   * 重置密码（admin，无邮件降级方案）：生成 12 位临时密码，仅当次响应返回；
   * 置强制首登改密、清锁定、吊销全部会话。自我保护：不能重置自己（走自助改密）。
   */
  async resetUserPassword(actor: AuthUser, id: string) {
    if (id === actor.id) {
      throw conflict({
        code: 'auth.self.forbidden',
        messageKey: 'auth:error.self.forbidden',
        message: '不能对自己的账号执行该操作',
      });
    }
    const target = await this.prisma.saUser.findUnique({ where: { id } });
    if (!target) {
      throw notFound({
        code: 'auth.user.notFound',
        messageKey: 'auth:error.user.notFound',
        message: '用户不存在',
      });
    }
    const temporary = generateTemporaryPassword();
    await this.prisma.saUser.update({
      where: { id },
      data: {
        password_hash: hashPassword(temporary),
        must_change_password: true,
        failed_login_count: 0,
        locked_until: null,
      },
    });
    await this.prisma.saUserToken.deleteMany({ where: { user_id: id } });
    await this.audit?.record('auth_password_reset', actor.username, { user_id: id });
    return { ok: true, temporary_password: temporary };
  }

  /**
   * 删除用户（admin）：拥有分析资产时拒绝（409 + 各类资产计数，提示先禁用）；
   * 否则事务内清理成员关系 / 组成员 / 资产 ACL / token 后删除账号。
   */
  async deleteUser(actor: AuthUser, id: string) {
    if (id === actor.id) {
      throw conflict({
        code: 'auth.self.forbidden',
        messageKey: 'auth:error.self.forbidden',
        message: '不能对自己的账号执行该操作',
      });
    }
    const target = await this.prisma.saUser.findUnique({ where: { id } });
    if (!target) {
      throw notFound({
        code: 'auth.user.notFound',
        messageKey: 'auth:error.user.notFound',
        message: '用户不存在',
      });
    }
    const [dashboards, cards, metrics, cohorts, tags, funnelTemplates, aiWorkspaces] = await Promise.all([
      this.prisma.dashboard.count({ where: { owner: id } }),
      this.prisma.card.count({ where: { owner: id } }),
      this.prisma.metaSavedMetric.count({ where: { owner: id } }),
      this.prisma.metaUserCohort.count({ where: { owner: id } }),
      this.prisma.metaUserTag.count({ where: { owner: id } }),
      this.prisma.metaFunnelTemplate.count({ where: { owner: id } }),
      this.prisma.aiWorkspace.count({ where: { user_id: id } }),
    ]);
    const owned = { dashboards, cards, metrics, cohorts, tags, funnel_templates: funnelTemplates, ai_workspaces: aiWorkspaces };
    if (Object.values(owned).some((n) => n > 0)) {
      throw conflict({
        code: 'auth.user.hasAssets',
        messageKey: 'auth:error.user.hasAssets',
        params: { total: Object.values(owned).reduce((a, b) => a + b, 0) },
        message: '该用户名下仍有资产（看板/卡片/指标/分群/标签/文件夹/AI 工作区），请先禁用账号或移交资产',
      });
    }
    await this.prisma.$transaction([
      this.prisma.saProjectMember.deleteMany({ where: { user_id: id } }),
      this.prisma.saMemberGroupUser.deleteMany({ where: { user_id: id } }),
      this.prisma.saAssetAcl.deleteMany({ where: { subject_type: 'user', subject_id: id } }),
      this.prisma.saUserToken.deleteMany({ where: { user_id: id } }),
      this.prisma.saUser.delete({ where: { id } }),
    ]);
    await this.audit?.record('auth_user_delete', actor.username, { user_id: id, username: target.username });
    return { ok: true };
  }

  // ---- 会话管理（phase: clklog-analytics-account-lifecycle-v3，PRD §5.4）----

  private toSession(row: { id: string; token: string; created_at: Date; expires_at: Date | null }, currentToken?: string) {
    return {
      id: row.id,
      created_at: row.created_at.toISOString(),
      expires_at: row.expires_at ? row.expires_at.toISOString() : null,
      ...(currentToken !== undefined ? { current: row.token === currentToken } : {}),
    };
  }

  /** 本人会话列表（当前会话置顶由前端做，此处带 current 标记） */
  async listMySessions(userId: string, currentToken: string) {
    const rows = await this.prisma.saUserToken.findMany({ where: { user_id: userId }, orderBy: { created_at: 'desc' } });
    return rows.map((r) => this.toSession(r, currentToken));
  }

  /** 管理员看任意用户会话（ops.user.manage；不带 current 标记避免泄露操作者视角） */
  async listSessionsOf(userId: string) {
    const rows = await this.prisma.saUserToken.findMany({ where: { user_id: userId }, orderBy: { created_at: 'desc' } });
    return rows.map((r) => this.toSession(r));
  }

  /** 吊销本人指定会话；不可吊销当前会话（AL3-5） */
  async revokeMySession(user: AuthUser, sessionId: string, currentToken: string) {
    const row = await this.prisma.saUserToken.findUnique({ where: { id: sessionId } });
    if (!row || row.user_id !== user.id) {
      throw notFound({ code: 'auth.session.notFound', messageKey: 'auth:error.session.notFound', message: '会话不存在' });
    }
    if (row.token === currentToken) {
      throw conflict({ code: 'auth.session.revokeCurrent', messageKey: 'auth:error.session.revokeCurrent', message: '不能吊销当前会话，请直接退出登录' });
    }
    await this.prisma.saUserToken.deleteMany({ where: { id: sessionId } });
    await this.audit?.record('auth_session_revoke', user.username, { user_id: user.id, scope: 'one', via: 'self' });
    return { ok: true };
  }

  /** 吊销除当前外全部会话（同改密副作用） */
  async revokeOtherSessions(user: AuthUser, currentToken: string) {
    const res = await this.prisma.saUserToken.deleteMany({ where: { user_id: user.id, token: { not: currentToken } } });
    await this.audit?.record('auth_session_revoke', user.username, { user_id: user.id, scope: 'others', via: 'self' });
    return { ok: true, revoked: res.count };
  }

  /** 管理员吊销指定用户指定会话；对象若是操作者当前会话 → 409（AL3-6） */
  async adminRevokeSession(actor: AuthUser, userId: string, sessionId: string, actorCurrentToken: string) {
    const target = await this.prisma.saUser.findUnique({ where: { id: userId } });
    if (!target) {
      throw notFound({ code: 'auth.user.notFound', messageKey: 'auth:error.user.notFound', message: '用户不存在' });
    }
    const row = await this.prisma.saUserToken.findUnique({ where: { id: sessionId } });
    if (!row || row.user_id !== userId) {
      throw notFound({ code: 'auth.session.notFound', messageKey: 'auth:error.session.notFound', message: '会话不存在' });
    }
    if (row.token === actorCurrentToken) {
      throw conflict({ code: 'auth.session.revokeCurrent', messageKey: 'auth:error.session.revokeCurrent', message: '不能吊销自己当前会话' });
    }
    await this.prisma.saUserToken.deleteMany({ where: { id: sessionId } });
    await this.audit?.record('auth_session_revoke', actor.username, { user_id: userId, scope: 'one', via: 'admin' });
    return { ok: true };
  }

  /** 管理员吊销指定用户全部会话（等价于强制其下线） */
  async adminRevokeAllSessions(actor: AuthUser, userId: string) {
    const res = await this.prisma.saUserToken.deleteMany({ where: { user_id: userId } });
    await this.audit?.record('auth_session_revoke', actor.username, { user_id: userId, scope: 'all', via: 'admin' });
    return { ok: true, revoked: res.count };
  }

  private toUser(u: {
    id: string;
    username: string;
    display_name: string | null;
    email?: string | null;
    platform_role: string;
    default_project?: string | null;
    locale?: string | null;
    timezone?: string | null;
    must_change_password?: boolean;
  }): AuthUser {
    return {
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      email: u.email ?? null,
      platform_role: u.platform_role === 'super_admin' ? 'super_admin' : 'none',
      default_project: u.default_project ?? null,
      locale: u.locale ?? null,
      timezone: u.timezone ?? null,
      must_change_password: u.must_change_password ?? false,
    };
  }
}
