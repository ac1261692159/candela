import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Transporter } from 'nodemailer';
import { serverT } from '../../i18n/messages';
import { badRequest, domainError } from '../../i18n/domain-error';
import { PrismaService } from '../shared/prisma.service';
import { decryptSecret, encryptSecret, parseMasterKey } from '../alerting/channels/channel-crypto';
import { AUTH_MAIL_CONFIG, type AuthMailBoot, type SmtpRuntime } from './auth-mail.config';

/**
 * 账号域邮件（phase: clklog-analytics-account-lifecycle-v2 §5 + 增补 v1.1）。
 * 与告警 ALERT_SMTP_* 完全独立。
 * 配置解析链（v1.1）：库内已启用行（密码 AES-256-GCM 解密）> env AUTH_SMTP_* 快照，60 秒内存缓存热生效。
 * 模板按收件人 locale 渲染（mail 命名空间，13 门）；同步发送无队列（PRD 非目标）。
 */
const CONFIG_ROW_ID = 'singleton';
const CACHE_MS = 60_000;

@Injectable()
export class AuthMailService {
  private readonly logger = new Logger(AuthMailService.name);
  private transporter?: Transporter;
  private transportKey = '';
  private cache?: { cfg: SmtpRuntime; at: number };

  constructor(
    @Optional() @Inject(AUTH_MAIL_CONFIG) private readonly boot: AuthMailBoot | null = null,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  get enabled(): boolean {
    // 同步快捷判断仅看 env；精确判断走 effectiveConfig（API 层均用后者）
    return this.boot?.env.enabled ?? false;
  }

  /** 生效配置：DB 行 enabled → 库值；否则 env 快照。60s 缓存。 */
  async effectiveConfig(): Promise<SmtpRuntime> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.cfg;
    const envBase: SmtpRuntime = {
      enabled: this.boot?.env.enabled ?? false,
      host: this.boot?.env.host ?? '',
      port: this.boot?.env.port ?? 465,
      secure: this.boot?.env.secure ?? true,
      user: this.boot?.env.user ?? '',
      pass: this.boot?.env.pass ?? '',
      from: this.boot?.env.from ?? '',
      publicBaseUrl: this.boot?.env.publicBaseUrl ?? '',
    };
    let cfg = envBase;
    if (this.prisma) {
      const row = await this.prisma.saAuthMailConfig.findUnique({ where: { id: CONFIG_ROW_ID } }).catch(() => null);
      if (row?.enabled && row.host) {
        let pass = envBase.pass;
        let broken = false;
        if (row.secret_cipher) {
          const key = parseMasterKey(this.boot?.configKey);
          if (key) {
            try {
              pass = decryptSecret(row.secret_cipher, key);
            } catch {
              this.logger.warn('账号邮件配置密文无法解密（主密钥可能已轮换），整体按未配置处理');
              broken = true;
            }
          } else {
            this.logger.warn('账号邮件配置存在密文但主密钥缺失（ALERT_CONFIG_KEY），整体按未配置处理');
            broken = true;
          }
        }
        cfg = broken
          ? { ...envBase, enabled: false, host: '', pass: '' }
          : { ...envBase, enabled: true, host: row.host, port: row.port, secure: row.secure, user: row.user, pass, from: row.mail_from };
      }
    }
    this.cache = { cfg, at: Date.now() };
    return cfg;
  }

  /** 未配置 SMTP 时的统一拒绝（调用方前置判断） */
  async assertConfigured() {
    const cfg = await this.effectiveConfig();
    if (!cfg.enabled || !cfg.host) {
      throw badRequest({
        code: 'auth.mail.notConfigured',
        messageKey: 'auth:error.mail.notConfigured',
        message: '未配置邮件服务，请联系管理员',
      });
    }
  }

  /** 业务链接拼装（§7）：publicBaseUrl + 路径 */
  async buildLink(path: string): Promise<string> {
    const cfg = await this.effectiveConfig();
    return `${cfg.publicBaseUrl.replace(/\/+$/, '')}${path}`;
  }

  /** 发送模板邮件；返回是否成功（失败不抛错，由调用方审计 auth_mail_failed） */
  async sendTemplate(
    to: string,
    locale: string | null | undefined,
    kind: 'reset' | 'setup' | 'invite' | 'inviteNotify' | 'test',
    params: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const cfg = await this.effectiveConfig();
      const subject = serverT(locale, `mail.${kind}.subject`, params);
      const text = serverT(locale, `mail.${kind}.body`, params);
      const transporter = await this.getTransporter(cfg);
      await transporter.sendMail({ from: cfg.from, to, subject, text });
      return true;
    } catch (error) {
      this.logger.warn(`账号邮件发送失败 [${kind}] → ${to}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  // ---- 管理端（phase 增补 v1.1，权限 ops.user.manage 的调用方在 controller）----

  /** 管理端视图：宁可缺失不可泄露——只报 has_password，永不输出明文/密文 */
  async adminView() {
    const row = this.prisma
      ? await this.prisma.saAuthMailConfig.findUnique({ where: { id: CONFIG_ROW_ID } }).catch(() => null)
      : null;
    if (row) {
      return {
        source: row.enabled && row.host ? ('db' as const) : ('none' as const),
        stored: true,
        enabled: row.enabled,
        host: row.host,
        port: row.port,
        secure: row.secure,
        user: row.user,
        from: row.mail_from,
        has_password: Boolean(row.secret_cipher),
        updated_by: row.updated_by,
        updated_at: row.updated_at.toISOString(),
      };
    }
    const env = this.boot?.env;
    return {
      source: env?.enabled ? ('env' as const) : ('none' as const),
      stored: false,
      enabled: env?.enabled ?? false,
      host: env?.host ?? '',
      port: env?.port ?? 465,
      secure: env?.secure ?? true,
      user: env?.user ?? '',
      from: env?.from ?? '',
      has_password: Boolean(env?.pass),
      updated_by: null,
      updated_at: null,
    };
  }

  /** 保存配置：pass 不传/空 = 保留旧密文；传新值需主密钥在位，否则 400 */
  async saveConfig(
    operator: string,
    dto: { enabled: boolean; host: string; port?: number; secure?: boolean; user?: string; from?: string; pass?: string },
  ) {
    if (!this.prisma) throw domainError(HttpStatus.INTERNAL_SERVER_ERROR, { code: 'auth.mail.configStoreUnavailable', messageKey: 'auth:error.mail.storeUnavailable', message: '配置存储不可用' });
    const host = (dto.host ?? '').trim();
    if (dto.enabled && !host) {
      throw badRequest({ code: 'auth.mail.hostRequired', messageKey: 'auth:error.mail.hostRequired', message: '启用邮件服务必须填写 SMTP 主机' });
    }
    const existing = await this.prisma.saAuthMailConfig.findUnique({ where: { id: CONFIG_ROW_ID } });
    let cipher = existing?.secret_cipher ?? null;
    if (dto.pass) {
      const key = parseMasterKey(this.boot?.configKey);
      if (!key) {
        throw badRequest({
          code: 'auth.mail.configKeyMissing',
          messageKey: 'auth:error.mail.configKeyMissing',
          message: '未注入凭证主密钥（ALERT_CONFIG_KEY），无法保存密码',
        });
      }
      cipher = encryptSecret(dto.pass, key);
    }
    const data = {
      enabled: dto.enabled,
      host,
      port: dto.port && dto.port > 0 ? dto.port : 465,
      secure: dto.secure ?? true,
      user: (dto.user ?? '').trim(),
      mail_from: (dto.from ?? '').trim(),
      secret_cipher: cipher,
      updated_by: operator,
    };
    await this.prisma.saAuthMailConfig.upsert({ where: { id: CONFIG_ROW_ID }, create: { id: CONFIG_ROW_ID, ...data }, update: data });
    this.cache = undefined;
    this.transporter = undefined;
    return this.adminView();
  }

  /** 测试邮件：以生效配置发送 mail.test 模板（AM-11） */
  async sendTest(to: string, locale?: string | null) {
    await this.assertConfigured();
    const sent = await this.sendTemplate(to, locale, 'test', {});
    if (!sent) {
      throw domainError(HttpStatus.BAD_GATEWAY, {
        code: 'auth.mail.testFailed',
        messageKey: 'auth:error.mail.testFailed',
        message: '测试邮件发送失败，请检查 SMTP 配置与日志',
      });
    }
    return { sent: true };
  }

  private async getTransporter(cfg: SmtpRuntime): Promise<Transporter> {
    const key = `${cfg.host}:${cfg.port}:${cfg.secure}:${cfg.user}:${cfg.pass.length}`;
    if (this.transporter && this.transportKey === key) return this.transporter;
    const nodemailer = await import('nodemailer');
    this.transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    });
    this.transportKey = key;
    return this.transporter;
  }
}
