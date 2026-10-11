import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DlqRecord } from './ingestor.types';

@Injectable()
export class DlqService {
  private readonly logger = new Logger(DlqService.name);
  // 本地开发使用项目内目录，避免 /var/log 权限问题
  private readonly dlqDir = process.env.DLQ_DIR || path.resolve(__dirname, '../../../dlq');

  constructor() {
    if (!fs.existsSync(this.dlqDir)) {
      fs.mkdirSync(this.dlqDir, { recursive: true });
    }
  }

  write(record: DlqRecord): void {
    try {
      const date = new Date().toISOString().split('T')[0];
      const filePath = path.join(this.dlqDir, `dlq-${date}.jsonl`);
      const line = JSON.stringify(record) + '\n';
      fs.appendFileSync(filePath, line);
    } catch (error) {
      this.logger.error('写入 DLQ 失败', error);
    }
  }

  writeBatch(records: DlqRecord[]): void {
    for (const record of records) {
      this.write(record);
    }
  }
}
