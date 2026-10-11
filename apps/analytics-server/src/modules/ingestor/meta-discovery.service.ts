import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { RedisService } from '../shared/redis.service';
import { ParsedSensorsMessage } from './ingestor.types';

@Injectable()
export class MetaDiscoveryService {
  private readonly logger = new Logger(MetaDiscoveryService.name);
  private readonly dedupWindowSeconds = 300;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async discover(message: ParsedSensorsMessage): Promise<void> {
    const { project_name, event, type, properties } = message;

    if (type !== 'track' || !event) return;

    const dedupKey = `discovery:event:${project_name}:${event}`;
    const isKnown = await this.redis.sismember(dedupKey, event);
    if (isKnown) return;

    await this.ensureEvent(project_name, event);

    if (properties && typeof properties === 'object') {
      for (const propKey of Object.keys(properties)) {
        await this.ensureProperty(project_name, event, propKey, properties[propKey]);
      }
    }

    await this.redis.sadd(dedupKey, event);
    await this.redis.expire(dedupKey, this.dedupWindowSeconds);
  }

  /**
   * 确保事件存在；首次创建时记录 event_created 审计日志。
   * 事件的人工维护字段（display_name/remark/status）不被自动发现覆盖（红线/规范），
   * 仅首次登记；updated_at 由 @updatedAt 自动刷新。
   */
  private async ensureEvent(project: string, event: string): Promise<void> {
    const existing = await this.prisma.metaEvent.findUnique({
      where: {
        event_key_project_name: { event_key: event, project_name: project },
      },
      select: { event_key: true },
    });

    if (existing) return; // 已存在，不覆盖人工字段，不重复记日志

    await this.prisma.metaEvent.create({
      data: {
        event_key: event,
        project_name: project,
        status: 'pending',
      },
    });
    await this.log(project, event, null, 'event_created', null, 'pending');
  }

  /**
   * 确保属性存在；行为：
   * - 不存在 → 创建 + 记录 property_created
   * - 存在但 data_type 与上报不同 → 更新类型 + 记录 property_type_changed
   * - 存在且类型一致 → 跳过
   */
  private async ensureProperty(
    project: string,
    event: string,
    propKey: string,
    sampleValue: unknown,
  ): Promise<void> {
    const existing = await this.prisma.metaEventProperty.findUnique({
      where: {
        event_key_project_name_prop_key: {
          event_key: event,
          project_name: project,
          prop_key: propKey,
        },
      },
    });

    const dataType = this.inferType(sampleValue);

    if (existing) {
      // 类型变更检测：仅当类型确实变化时更新，避免高频写库
      if (existing.data_type !== dataType) {
        await this.prisma.metaEventProperty.update({
          where: { id: existing.id },
          data: { data_type: dataType, sample_value: String(sampleValue).substring(0, 500) },
        });
        await this.log(project, event, propKey, 'property_type_changed', existing.data_type, dataType);
        this.logger.warn(
          `属性类型变更: ${event}.${propKey} ${existing.data_type} → ${dataType}（project=${project}）`,
        );
      }
      return;
    }

    // 新建属性
    await this.prisma.metaEventProperty.create({
      data: {
        event_key: event,
        project_name: project,
        prop_key: propKey,
        data_type: dataType,
        sample_value: String(sampleValue).substring(0, 500),
        status: 'pending',
      },
    });

    await this.prisma.metaEventAttribute.upsert({
      where: { project_name_prop_key: { project_name: project, prop_key: propKey } },
      update: { event_count: { increment: 1 } },
      create: {
        project_name: project,
        prop_key: propKey,
        data_type: dataType,
        event_count: 1,
        status: 'pending',
      },
    });

    await this.log(project, event, propKey, 'property_created', null, dataType);
  }

  /**
   * 写入元数据发现审计日志（新增事件/新增属性/属性类型变更）。
   */
  private async log(
    project: string,
    event: string,
    propKey: string | null,
    changeType: string,
    fromValue: string | null,
    toValue: string | null,
  ): Promise<void> {
    try {
      await this.prisma.metaDiscoveryLog.create({
        data: {
          project_name: project,
          event_key: event,
          prop_key: propKey,
          change_type: changeType,
          from_value: fromValue,
          to_value: toValue,
        },
      });
    } catch (error) {
      // 审计日志失败不影响主流发现流程，仅记录告警
      this.logger.warn(`写入发现审计日志失败: ${error.message}`);
    }
  }

  private inferType(value: unknown): string {
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return 'number';
    if (value instanceof Date) return 'datetime';
    if (Array.isArray(value)) {
      if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
        return 'object_group';
      }
      return 'list';
    }
    if (typeof value === 'object' && value !== null) return 'object';
    return 'string';
  }
}
