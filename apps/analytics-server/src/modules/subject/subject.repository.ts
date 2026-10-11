import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../shared/prisma.service';

@Injectable()
export class SubjectRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(projectName: string) {
    return this.prisma.metaAnalysisSubject.findMany({
      where: { project_name: projectName },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
    });
  }

  findById(subjectId: string, projectName: string) {
    return this.prisma.metaAnalysisSubject.findFirst({
      where: { subject_id: subjectId, project_name: projectName },
    });
  }

  findByName(name: string, projectName: string) {
    return this.prisma.metaAnalysisSubject.findUnique({
      where: { project_name_name: { project_name: projectName, name } },
    });
  }

  create(data: Prisma.MetaAnalysisSubjectCreateInput) {
    return this.prisma.metaAnalysisSubject.create({ data });
  }

  update(subjectId: string, projectName: string, data: Prisma.MetaAnalysisSubjectUncheckedUpdateInput) {
    return this.prisma.metaAnalysisSubject.updateMany({
      where: { subject_id: subjectId, project_name: projectName },
      data,
    });
  }

  delete(subjectId: string, projectName: string) {
    return this.prisma.metaAnalysisSubject.deleteMany({
      where: { subject_id: subjectId, project_name: projectName, is_preset: false },
    });
  }

  countCohorts(projectName: string, subjectId: string) {
    return this.prisma.metaUserCohort.count({
      where: { project_name: projectName, subject_id: subjectId },
    });
  }

  countTags(projectName: string, subjectId: string) {
    return this.prisma.metaUserTag.count({
      where: { project_name: projectName, subject_id: subjectId },
    });
  }

  findCardsReferencing(projectName: string, subjectId: string) {
    return this.prisma.card.findMany({
      where: { project_name: projectName, dsl_json: { contains: subjectId } },
      select: { card_id: true, name: true },
      take: 20,
    });
  }

  findEventMaterializedColumn(projectName: string, propKey: string) {
    return this.prisma.metaEventProperty.findFirst({
      where: {
        project_name: projectName,
        prop_key: propKey,
        is_materialized: true,
        materialized_column: { not: null },
      },
      select: { materialized_column: true },
    });
  }

  findUserMaterializedColumn(projectName: string, propKey: string) {
    return this.prisma.metaUserProperty.findFirst({
      where: { project_name: projectName, prop_key: propKey, materialized_column: { not: null } },
      select: { materialized_column: true },
    });
  }

  backfillEmptyCohorts(projectName: string, subjectId: string) {
    return this.prisma.metaUserCohort.updateMany({
      where: { project_name: projectName, subject_id: '' },
      data: { subject_id: subjectId },
    });
  }

  backfillEmptyTags(projectName: string, subjectId: string) {
    return this.prisma.metaUserTag.updateMany({
      where: { project_name: projectName, subject_id: '' },
      data: { subject_id: subjectId },
    });
  }
}
