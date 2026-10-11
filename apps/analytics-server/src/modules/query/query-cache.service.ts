import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../shared/redis.service';
import { EventAnalysisQuery } from '../../types/dsl.types';

@Injectable()
export class QueryCacheService {
  private readonly logger = new Logger(QueryCacheService.name);
  private readonly prefix = 'sa:query:';
  private readonly ttlSeconds = 300;

  constructor(private readonly redis: RedisService) {}

  async get<T>(dsl: object): Promise<T | null> {
    const key = this.generateKey(dsl);
    try {
      return await this.redis.get<T>(key);
    } catch (error) {
      this.logger.warn('查询缓存读取失败，降级为直接查询', error.message);
      return null;
    }
  }

  async set<T>(dsl: object, data: T): Promise<void> {
    const key = this.generateKey(dsl);
    try {
      await this.redis.set(key, data, this.ttlSeconds);
    } catch (error) {
      this.logger.warn('查询缓存写入失败', error.message);
    }
  }

  private generateKey(dsl: object): string {
    return this.redis.generateCacheKey(this.prefix, dsl);
  }
}
