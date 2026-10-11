import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/** 关闭时等待连接池收尾的上限：supervisor 宽限 10s，各关闭钩子必须各自有限（2026-09-18 事故） */
const DISCONNECT_BUDGET_MS = 2_000;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    this.logger.log('Prisma 连接中...');
    await this.$connect();
    this.logger.log('Prisma 已连接');
  }

  async onModuleDestroy() {
    this.logger.log('Prisma 断开连接');
    const startedAt = Date.now();
    let timedOut = false;
    await Promise.race([
      this.$disconnect(),
      new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => {
          timedOut = true;
          resolvePromise();
        }, DISCONNECT_BUDGET_MS);
        timer.unref?.();
      }),
    ]);
    // 超时不再等：进程退出后由 MySQL 侧回收连接，重启本身不能被连接池拖住
    this.logger.log(`Prisma 已断开（${Date.now() - startedAt}ms${timedOut ? '，达到上限后放弃等待' : ''}）`);
  }
}
