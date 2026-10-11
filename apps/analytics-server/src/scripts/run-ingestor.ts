import './kafkajs-node24-polyfill';

import { NestFactory } from '@nestjs/core';

// 必须在加载 AppModule/Configuration 之前设置，避免 ingestor 进程抢占 Harness Socket。
process.env.ENABLE_INGESTOR = 'true';

let shuttingDown = false;

async function bootstrap() {
  const [{ AppModule }, { KafkaConsumerService }] = await Promise.all([
    import('../app.module'),
    import('../modules/ingestor/kafka-consumer.service'),
  ]);
  const app = await NestFactory.createApplicationContext(AppModule);
  const consumerService = app.get(KafkaConsumerService);

  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`收到 ${signal}，正在关闭 ingestor...`);
    try {
      await app.close();
    } catch (err) {
      console.error('关闭 ingestor 时出错', err);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    console.error('Ingestor 未捕获异常', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Ingestor 未处理的 Promise 拒绝', reason);
    process.exit(1);
  });

  // KafkaJS consumer 无法自行恢复时会发出 consumer.crash；
  // 本地开发直接退出，让 run_dev.sh 感知并终止整个 dev 会话。
  consumerService.onCrash(async (event) => {
    if (shuttingDown) return;
    console.error('Kafka consumer crash', event.payload);
    await app.close().catch(() => {});
    process.exit(1);
  });

  await consumerService.start();
  console.log('Ingestor 已启动，正在消费 Kafka...');
  const { backgroundWorkerSummary } = await import('../config/configuration');
  console.log(backgroundWorkerSummary());
}

bootstrap().catch((err) => {
  console.error('Ingestor 启动失败', err);
  process.exit(1);
});
