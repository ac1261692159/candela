import { Module } from '@nestjs/common';
import { ClickHouseService } from './clickhouse.service';
import { RedisService } from './redis.service';
import { KafkaService } from './kafka.service';
import { PrismaService } from './prisma.service';
import { AttributeResolverService } from './attribute-resolver.service';
import { ExpressionCompilerService } from './expression-compiler.service';

@Module({
  providers: [
    ClickHouseService,
    RedisService,
    KafkaService,
    PrismaService,
    AttributeResolverService,
    ExpressionCompilerService,
  ],
  exports: [
    ClickHouseService,
    RedisService,
    KafkaService,
    PrismaService,
    AttributeResolverService,
    ExpressionCompilerService,
  ],
})
export class SharedModule {}
