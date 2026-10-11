import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kafka, Consumer, KafkaConfig, SASLMechanism } from 'kafkajs';
import { appConfig } from '../../config/configuration';
import { localForwardedSocketFactory } from './kafka-socket.factory';

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaService.name);
  private kafka: Kafka;

  onModuleInit() {
    const config: KafkaConfig = {
      clientId: appConfig.kafka.clientId,
      brokers: appConfig.kafka.brokers,
      ssl: appConfig.kafka.ssl,
      socketFactory: localForwardedSocketFactory,
      connectionTimeout: 10000,
      requestTimeout: 30000,
    };

    if (appConfig.kafka.sasl) {
      config.sasl = {
        mechanism: appConfig.kafka.sasl.mechanism as SASLMechanism,
        username: appConfig.kafka.sasl.username,
        password: appConfig.kafka.sasl.password,
      } as any;
    }

    this.kafka = new Kafka(config);
  }

  onModuleDestroy() {
    // consumer 由各业务方自行关闭
  }

  createConsumer(groupId: string): Consumer {
    this.logger.log(`创建 Kafka consumer: groupId=${groupId}`);
    return this.kafka.consumer({
      groupId,
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
      // runner 循环出错（如 ClickHouse/网络瞬时故障）时自动重启 runner，
      // 而不是触发 consumer.crash 导致整个 ingestor 进程退出（此前崩溃循环根因之一）。
      // KafkaJS runner 自带指数退避限速；真 crash 仍由 run-ingestor.ts 的 onCrash 兜底退出。
      retry: {
        retries: 5,
        initialRetryTime: 1000,
        restartOnFailure: async (error: Error) => {
          this.logger.warn(`Kafka runner 出错，将自动重启 runner: ${error.message}`);
          return true;
        },
      },
    });
  }

  async admin() {
    const admin = this.kafka.admin();
    await admin.connect();
    return admin;
  }
}
