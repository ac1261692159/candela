import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { RedisService } from '../shared/redis.service';
import { ParsedSensorsMessage } from './ingestor.types';

/**
 * 用户属性自动发现服务。
 *
 * 从 user_set / user_set_once / track_signup 的 properties 提取用户属性字段，
 * 登记到 meta_user_property 元数据表；user_unset / user_delete 时将对应属性
 * status 置为 hidden。
 *
 * 设计契约见 docs/architecture/clklog-analytics-design.md §6.5。
 * 与事件属性（MetaDiscoveryService）保持一致：按「项目+属性」粒度 Redis 去重
 * 300s，新属性记 user_property_created，类型变更记 user_property_type_changed，
 * hidden 记 user_property_hidden，均写 metadiscoverylog 审计。
 */
@Injectable()
export class UserPropertyDiscoveryService {
  private readonly logger = new Logger(UserPropertyDiscoveryService.name);
  private static readonly dedupWindowSeconds = 300;

  // 提取用户属性的消息类型
  private static readonly EXTRACT_TYPES = new Set(['user_set', 'user_set_once', 'track_signup']);
  // 标记 hidden 的消息类型
  private static readonly HIDE_TYPES = new Set(['user_unset', 'user_delete']);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * 处理一条消息的用户属性发现。
   * - 提取类：登记 properties 中的用户属性
   * - 隐藏类：标记对应属性为 hidden
   */
  async discover(message: ParsedSensorsMessage): Promise<void> {
    const { project_name, type, properties } = message;
    if (!project_name || !type) return;

    if (UserPropertyDiscoveryService.EXTRACT_TYPES.has(type)) {
      if (properties && typeof properties === 'object') {
        for (const propKey of Object.keys(properties)) {
          await this.ensureUserProperty(project_name, propKey, properties[propKey]);
        }
      }
    } else if (UserPropertyDiscoveryService.HIDE_TYPES.has(type)) {
      if (properties && typeof properties === 'object') {
        for (const propKey of Object.keys(properties)) {
          await this.hideUserProperty(project_name, propKey);
        }
      }
    }
  }

  /**
   * 登记一个用户属性（不存在则创建，类型变化则更新）。
   */
  private async ensureUserProperty(
    project: string,
    propKey: string,
    sampleValue: unknown,
  ): Promise<void> {
    const dedupKey = `discovery:userprop:${project}:${propKey}`;
    const isKnown = await this.redis.sismember(dedupKey, propKey);
    if (isKnown) return;

    const existing = await this.prisma.metaUserProperty.findUnique({
      where: { project_name_prop_key: { project_name: project, prop_key: propKey } },
      select: { id: true, data_type: true, status: true },
    });

    const dataType = this.inferType(sampleValue);

    if (existing) {
      // 类型变更：检测并更新 + 审计（hidden 状态下重新出现则恢复为 active）
      if (existing.data_type !== dataType || existing.status === 'hidden') {
        await this.prisma.metaUserProperty.update({
          where: { id: existing.id },
          data: { data_type: dataType, status: existing.status === 'hidden' ? 'active' : existing.status },
        });
        if (existing.data_type !== dataType) {
          await this.logUserProperty(project, propKey, 'user_property_type_changed', existing.data_type, dataType);
          this.logger.warn(`用户属性类型变更: ${propKey} ${existing.data_type} → ${dataType}（project=${project}）`);
        } else {
          await this.logUserProperty(project, propKey, 'user_property_active', 'hidden', 'active');
        }
      }
    } else {
      // 新建属性
      await this.prisma.metaUserProperty.create({
        data: {
          project_name: project,
          prop_key: propKey,
          data_type: dataType,
          status: 'pending',
        },
      });
      await this.logUserProperty(project, propKey, 'user_property_created', null, dataType);
    }

    await this.redis.sadd(dedupKey, propKey);
    await this.redis.expire(dedupKey, UserPropertyDiscoveryService.dedupWindowSeconds);
  }

  /**
   * 用户删除/清空属性时，标记为 hidden（不删除，保留登记）。
   */
  private async hideUserProperty(project: string, propKey: string): Promise<void> {
    const existing = await this.prisma.metaUserProperty.findUnique({
      where: { project_name_prop_key: { project_name: project, prop_key: propKey } },
      select: { id: true, status: true },
    });
    if (!existing || existing.status === 'hidden') return;

    await this.prisma.metaUserProperty.update({
      where: { id: existing.id },
      data: { status: 'hidden' },
    });
    await this.logUserProperty(project, propKey, 'user_property_hidden', existing.status, 'hidden');
  }

  /**
   * 写用户属性发现审计日志（失败不影响主流）。
   */
  private async logUserProperty(
    project: string,
    propKey: string,
    changeType: string,
    fromValue: string | null,
    toValue: string | null,
  ): Promise<void> {
    try {
      await this.prisma.metaDiscoveryLog.create({
        data: {
          project_name: project,
          event_key: '__user_profile__', // 用户属性不属于具体事件，用占位事件键
          prop_key: propKey,
          change_type: changeType,
          from_value: fromValue,
          to_value: toValue,
        },
      });
    } catch (error) {
      this.logger.warn(`写入用户属性发现审计日志失败: ${error.message}`);
    }
  }

  private inferType(value: unknown): string {
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return 'number';
    if (value instanceof Date) return 'datetime';
    if (Array.isArray(value)) return 'list';
    if (typeof value === 'object' && value !== null) return 'object';
    return 'string';
  }
}
