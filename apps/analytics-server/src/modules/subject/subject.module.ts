import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { SubjectController } from './subject.controller';
import { SubjectRepository } from './subject.repository';
import { SubjectService } from './subject.service';

@Module({
  imports: [SharedModule],
  controllers: [SubjectController],
  providers: [SubjectRepository, SubjectService],
  exports: [SubjectService],
})
export class SubjectModule {}
