import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Consumer, ConsumerCrashEvent, KafkaMessage } from 'kafkajs';
import { appConfig } from '../../config/configuration';
import { KafkaService } from '../shared/kafka.service';
import { SaEventParser } from './sa-event-parser.service';
import { SaEventFlattener } from './sa-event-flattener.service';
import { SaEventWriter } from './sa-event-writer.service';
import { SaUserProfileWriter } from './sa-user-profile-writer.service';
import { DlqService } from './dlq.service';
import { MetaDiscoveryService } from './meta-discovery.service';
import { UserPropertyDiscoveryService } from './user-property-discovery.service';
import { ParsedSensorsMessage, SaEventRecord } from './ingestor.types';

@Injectable()
export class KafkaConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private consumer: Consumer;
  private running = false;
  private batch: SaEventRecord[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly kafkaService: KafkaService,
    private readonly parser: SaEventParser,
    private readonly flattener: SaEventFlattener,
    private readonly eventWriter: SaEventWriter,
    private readonly profileWriter: SaUserProfileWriter,
    private readonly dlq: DlqService,
    private readonly discovery: MetaDiscoveryService,
    private readonly userPropertyDiscovery: UserPropertyDiscoveryService,
  ) {}

  async onModuleInit() {
    if (process.env.ENABLE_INGESTOR !== 'true') {
      this.logger.log('ENABLE_INGESTOR 未设置，跳过 Kafka consumer 初始化');
      return;
    }

    const groupId = process.env.INGESTOR_REPLAY
      ? `${appConfig.kafka.consumerGroupId}-${appConfig.ingestor.replayGroupSuffix}-${Date.now()}`
      : appConfig.kafka.consumerGroupId;

    this.consumer = this.kafkaService.createConsumer(groupId);
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: appConfig.kafka.topic, fromBeginning: !!process.env.INGESTOR_REPLAY });

    this.logger.log(`Kafka consumer 已连接: groupId=${groupId}, topic=${appConfig.kafka.topic}`);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.consumer.run({
      eachBatchAutoResolve: true,
      eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
        for (const message of batch.messages) {
          await this.processMessage(message);
          await resolveOffset(message.offset);
          await heartbeat();
        }
        await this.flushIfNeeded(true);
        await commitOffsetsIfNecessary();
      },
    });
  }

  private async processMessage(message: KafkaMessage): Promise<void> {
    if (!message.value) return;

    const { messages, dlq } = this.parser.parse(message.value);
    if (dlq.length > 0) {
      this.dlq.writeBatch(dlq);
    }

    for (const sensorsMsg of messages) {
      try {
        await this.handleMessage(sensorsMsg);
      } catch (error) {
        this.logger.error(`处理消息失败: ${error.message}`, error.stack);
        this.dlq.write({
          payload: JSON.stringify(sensorsMsg),
          reason: `处理失败: ${error.message}`,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  private async handleMessage(message: ParsedSensorsMessage): Promise<void> {
    // 自动发现元数据
    await this.discovery.discover(message);

    if (message.type === 'track' || message.type === 'track_signup') {
      const record = this.flattener.flatten(message);
      this.batch.push(record);
      await this.flushIfNeeded();
    }

    if (
      message.type === 'track_signup' ||
      message.type === 'user_set' ||
      message.type === 'user_set_once' ||
      message.type === 'user_append' ||
      message.type === 'user_increment' ||
      message.type === 'user_unset' ||
      message.type === 'user_delete'
    ) {
      // 用户属性自动发现（登记 meta_user_property / 标记 hidden）
      await this.userPropertyDiscovery.discover(message);
      await this.profileWriter.write(message);
    }
  }

  private async flushIfNeeded(force = false): Promise<void> {
    const { batchSize, batchFlushMs } = appConfig.ingestor;

    if (this.batch.length >= batchSize || (force && this.batch.length > 0)) {
      await this.flush();
      return;
    }

    if (this.flushTimer) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.batch.length > 0) {
        this.flush().catch((err) => this.logger.error('定时 flush 失败', err));
      }
    }, batchFlushMs);
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const toWrite = this.batch.splice(0, this.batch.length);
    if (toWrite.length === 0) return;

    try {
      await this.eventWriter.writeBatch(toWrite);
    } catch (error) {
      // 写入失败，回退到 batch 重试（简单实现）
      this.batch.unshift(...toWrite);
      throw error;
    }
  }

  onCrash(handler: (event: ConsumerCrashEvent) => void | Promise<void>): void {
    this.consumer?.on('consumer.crash', handler);
  }

  async onModuleDestroy() {
    this.logger.log('Kafka consumer 正在关闭...');
    await this.flush();
    await this.consumer?.disconnect();
    this.logger.log('Kafka consumer 已关闭');
  }
}
