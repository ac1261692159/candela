import { Injectable, Logger } from '@nestjs/common';
import { ClickHouseService } from '../shared/clickhouse.service';
import { DEFAULT_PROJECT_NAME, ParsedSensorsMessage, UserProfileRecord } from './ingestor.types';
import { formatChDateTimeMs } from '../time/format';
import { TimezoneService } from '../time/timezone.service';

@Injectable()
export class SaUserProfileWriter {
  private readonly logger = new Logger(SaUserProfileWriter.name);

  constructor(
    private readonly clickHouse: ClickHouseService,
    // 缺省构造兜底纯单测；生产由 DI 注入
    private readonly timezones: TimezoneService = new TimezoneService(undefined),
  ) {}

  async write(message: ParsedSensorsMessage): Promise<void> {
    const record = this.buildRecord(message);
    await this.clickHouse.insert<UserProfileRecord>('clklog_sa.sa_user_profiles', [record]);
  }

  private buildRecord(message: ParsedSensorsMessage): UserProfileRecord {
    let properties = message.properties || {};

    switch (message.type) {
      case 'user_set':
        // 全量覆盖
        break;
      case 'track_signup':
        properties = { ...properties, original_id: message.original_id };
        break;
      case 'user_set_once':
      case 'user_append':
      case 'user_increment':
      case 'user_unset':
      case 'user_delete':
        // TODO: 实现读-改-写语义
        this.logger.warn(`用户画像操作 ${message.type} 暂按覆盖写处理`);
        break;
    }

    return {
      // 与表结构对齐（ORDER BY (project_name, distinct_id)）：线上历史表缺该列，
      // 由 scripts/migrate-clickhouse 的幂等迁移补齐，见 docs/architecture/clklog-analytics-design-user-property-path-v1.md
      project_name: message.project_name || DEFAULT_PROJECT_NAME,
      distinct_id: message.distinct_id,
      user_key: message.user_key || '',
      properties: JSON.stringify(properties),
      updated_at: formatChDateTimeMs(new Date(message.time), this.timezones.platformTz),
    };
  }
}
