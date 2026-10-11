import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { KafkaConsumerService } from './kafka-consumer.service';
import { SaEventParser } from './sa-event-parser.service';
import { SaEventFlattener } from './sa-event-flattener.service';
import { SaEventWriter } from './sa-event-writer.service';
import { SaUserProfileWriter } from './sa-user-profile-writer.service';
import { DlqService } from './dlq.service';
import { MetaDiscoveryService } from './meta-discovery.service';
import { UserPropertyDiscoveryService } from './user-property-discovery.service';

@Module({
  imports: [SharedModule],
  providers: [
    KafkaConsumerService,
    SaEventParser,
    SaEventFlattener,
    SaEventWriter,
    SaUserProfileWriter,
    DlqService,
    MetaDiscoveryService,
    UserPropertyDiscoveryService,
  ],
  exports: [KafkaConsumerService],
})
export class IngestorModule {}
