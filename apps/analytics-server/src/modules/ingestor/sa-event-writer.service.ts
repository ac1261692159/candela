import { Injectable, Logger } from '@nestjs/common';
import { ClickHouseService } from '../shared/clickhouse.service';
import { SaEventRecord } from './ingestor.types';

@Injectable()
export class SaEventWriter {
  private readonly logger = new Logger(SaEventWriter.name);

  constructor(private readonly clickHouse: ClickHouseService) {}

  async writeBatch(rows: SaEventRecord[]): Promise<void> {
    if (rows.length === 0) return;

    try {
      await this.clickHouse.insert<SaEventRecord>('clklog_sa.sa_events', rows);
      this.logger.debug(`写入 ${rows.length} 条事件`);
    } catch (error) {
      this.logger.error(`事件写入失败: ${error.message}`, error.stack);
      throw error;
    }
  }
}
