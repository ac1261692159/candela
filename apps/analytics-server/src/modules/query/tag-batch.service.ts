import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { MISSING_COHORT_BATCH } from './cohort-member-sql';

@Injectable()
export class TagBatchService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    project: string,
    tagId: string,
  ): Promise<{ batch_id: string; ready: boolean; subject_id: string }> {
    const row = await this.prisma.metaUserTag.findFirst({
      where: { project_name: project, tag_id: tagId, status: 'ready' },
      select: { batch_id: true, subject_id: true },
    });
    if (!row?.batch_id) return { batch_id: MISSING_COHORT_BATCH, ready: false, subject_id: '' };
    return { batch_id: row.batch_id, ready: true, subject_id: row.subject_id || '' };
  }
}
