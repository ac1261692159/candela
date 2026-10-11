import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { appConfig } from '../../config/configuration';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  onModuleInit() {
    const { host, port, db, password, keyPrefix } = appConfig.redis;
    this.client = new Redis({
      host,
      port,
      db,
      password: password || undefined,
      keyPrefix,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      lazyConnect: true,
    });

    this.client.on('error', (err) => {
      this.logger.error('Redis 连接错误', err);
    });
  }

  onModuleDestroy() {
    this.client?.disconnect();
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.client.get(key);
      return value ? (JSON.parse(value) as T) : null;
    } catch (error) {
      this.logger.warn(`Redis get 失败: ${key}`, error);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await this.client.setex(key, ttlSeconds, JSON.stringify(value));
    } catch (error) {
      this.logger.warn(`Redis set 失败: ${key}`, error);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (error) {
      this.logger.warn(`Redis del 失败: ${key}`, error);
    }
  }

  generateCacheKey(prefix: string, obj: object): string {
    const normalized = JSON.stringify(obj, (key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value)
          .sort()
          .reduce<Record<string, unknown>>((sorted, k) => {
            sorted[k] = value[k];
            return sorted;
          }, {});
      }
      return value;
    });
    const hash = crypto.createHash('sha256').update(normalized).digest('hex');
    return `${prefix}:${hash}`;
  }

  async sadd(key: string, ...members: string[]): Promise<void> {
    try {
      await this.client.sadd(key, ...members);
    } catch (error) {
      this.logger.warn(`Redis sadd 失败: ${key}`, error);
    }
  }

  async sismember(key: string, member: string): Promise<boolean> {
    try {
      return (await this.client.sismember(key, member)) === 1;
    } catch (error) {
      this.logger.warn(`Redis sismember 失败: ${key}`, error);
      return false;
    }
  }

  async expire(key: string, seconds: number): Promise<void> {
    try {
      await this.client.expire(key, seconds);
    } catch (error) {
      this.logger.warn(`Redis expire 失败: ${key}`, error);
    }
  }
}
