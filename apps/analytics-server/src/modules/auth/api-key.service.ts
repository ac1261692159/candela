import { HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { PrismaService } from '../shared/prisma.service';
import { domainError, notFound } from '../../i18n/domain-error';

/**
 * 外部 AI 只读查询 API Key 管理。
 *
 * - key 只存哈希（sha256），明文仅在创建时返回一次。
 * - 独立于用户登录 token，可过期 / 撤销 / 审计（last_used_at）。
 * - 绑定 project_name 作为查询边界（AI 查询只能落在该 project）。
 */
@Injectable()
export class ApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  /** 对明文 key 做哈希（与存库一致） */
  hashKey(plain: string): string {
    return createHash('sha256').update(plain).digest('hex');
  }

  /**
   * 创建 API Key。返回明文 key（仅此一次）。
   * 所有参数可选：name 缺省自动生成；project_name 默认 clklogapp；key 格式 sk-tp-<48位随机串>。
   */
  async create(dto: { name?: string; project_name?: string; expires_at?: string | null }) {
    const plain = this.generateKey();
    const keyHash = this.hashKey(plain);
    const name = dto.name?.trim() || this.autoName();
    const row = await this.prisma.saApiKey.create({
      data: {
        name,
        key_hash: keyHash,
        project_name: dto.project_name?.trim() || 'clklogapp',
        expires_at: dto.expires_at ? new Date(dto.expires_at) : null,
      },
    });
    return {
      id: row.id,
      name: row.name,
      project_name: row.project_name,
      status: row.status,
      expires_at: row.expires_at,
      // 明文 key 仅此一次返回
      api_key: plain,
    };
  }

  /** 生成 key：sk-tp- + 48 位 base62 随机串 */
  private generateKey(): string {
    return `sk-tp-${randomBytes(36).toString('base64url')}`;
  }

  /** 自动名称：key-YYYYMMDD-HHmmss */
  private autoName(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `key-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /** 列表（不返回 key 明文 / 哈希） */
  async list() {
    const rows = await this.prisma.saApiKey.findMany({
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        name: true,
        project_name: true,
        status: true,
        expires_at: true,
        last_used_at: true,
        created_at: true,
      },
    });
    return rows;
  }

  /** 吊销 */
  async revoke(id: string) {
    const row = await this.prisma.saApiKey.findUnique({ where: { id } });
    if (!row) {
      throw notFound({
        code: 'auth.apiKey.notFound',
        messageKey: 'auth:error.apiKey.notFound',
        params: { id },
        message: `API Key 不存在: ${id}`,
      });
    }
    await this.prisma.saApiKey.update({ where: { id }, data: { status: 'revoked' } });
    return { ok: true };
  }

  /** 删除（物理删除，供彻底清理） */
  async remove(id: string) {
    const row = await this.prisma.saApiKey.findUnique({ where: { id } });
    if (!row) {
      throw notFound({
        code: 'auth.apiKey.notFound',
        messageKey: 'auth:error.apiKey.notFound',
        params: { id },
        message: `API Key 不存在: ${id}`,
      });
    }
    await this.prisma.saApiKey.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * 校验明文 key，返回可用的 key 记录（含 project_name 边界）。
   * 不通过抛 401（DomainError）。
   */
  async validate(plain: string) {
    const keyHash = this.hashKey(plain);
    const row = await this.prisma.saApiKey.findUnique({ where: { key_hash: keyHash } });
    if (!row) {
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'auth.apiKey.invalid',
        messageKey: 'auth:error.apiKey.invalid',
        message: '无效的 API Key',
      });
    }
    if (row.status !== 'active') {
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'auth.apiKey.revoked',
        messageKey: 'auth:error.apiKey.revoked',
        message: 'API Key 已吊销',
      });
    }
    if (row.expires_at && row.expires_at.getTime() < Date.now()) {
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'auth.apiKey.expired',
        messageKey: 'auth:error.apiKey.expired',
        message: 'API Key 已过期',
      });
    }
    // 更新审计时间（异步，不阻塞查询）
    this.prisma.saApiKey
      .update({ where: { id: row.id }, data: { last_used_at: new Date() } })
      .catch(() => undefined);
    return { id: row.id, name: row.name, project_name: row.project_name };
  }
}
