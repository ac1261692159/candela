import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../shared/prisma.service';

@Injectable()
export class CohortRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(projectName: string, keyword?: string) {
    return this.prisma.metaUserCohort.findMany({
      where: {
        project_name: projectName,
        ...(keyword
          ? {
              OR: [
                { name: { contains: keyword } },
                { display_name: { contains: keyword } },
              ],
            }
          : {}),
      },
      orderBy: { updated_at: 'desc' },
    });
  }

  listReady(projectName: string, subjectId?: string, includeEmpty = false) {
    return this.prisma.metaUserCohort.findMany({
      where: {
        project_name: projectName,
        status: 'ready',
        ...(subjectId
          ? includeEmpty
            ? { OR: [{ subject_id: subjectId }, { subject_id: '' }] }
            : { subject_id: subjectId }
          : {}),
      },
      orderBy: { display_name: 'asc' },
    });
  }

  count(projectName: string) {
    return this.prisma.metaUserCohort.count({ where: { project_name: projectName } });
  }

  findById(cohortId: string, projectName: string) {
    return this.prisma.metaUserCohort.findFirst({
      where: { cohort_id: cohortId, project_name: projectName },
    });
  }

  findByName(name: string, projectName: string) {
    return this.prisma.metaUserCohort.findUnique({
      where: { project_name_name: { project_name: projectName, name } },
    });
  }

  create(data: Prisma.MetaUserCohortCreateInput) {
    return this.prisma.metaUserCohort.create({ data });
  }

  update(cohortId: string, projectName: string, data: Prisma.MetaUserCohortUpdateInput) {
    return this.prisma.metaUserCohort.updateMany({
      where: { cohort_id: cohortId, project_name: projectName },
      data,
    });
  }

  delete(cohortId: string, projectName: string) {
    return this.prisma.metaUserCohort.deleteMany({
      where: { cohort_id: cohortId, project_name: projectName },
    });
  }

  listDaily() {
    return this.prisma.metaUserCohort.findMany({
      where: { kind: { in: ['condition', 'sql'] }, schedule: 'daily' },
    });
  }

  /** 重启回收：「计算中」的行（含服务在计算中被杀留下的） */
  listPending(limit: number) {
    return this.prisma.metaUserCohort.findMany({
      where: { status: 'pending' },
      orderBy: { updated_at: 'asc' },
      take: limit,
    });
  }

  findCardsReferencing(projectName: string, cohortId: string) {
    return this.prisma.card.findMany({
      where: { project_name: projectName, dsl_json: { contains: cohortId } },
      select: { card_id: true, name: true },
      take: 20,
    });
  }

  /**
   * 看板级分群筛选（`Dashboard.cohort_filter_json`）也引用 `cohort_id`——
   * 漏掉它就会出现「删的时候说没引用、删完卡片刷新报分群不可用」。
   */
  findDashboardsReferencing(projectName: string, cohortId: string) {
    return this.prisma.dashboard.findMany({
      where: { project_name: projectName, cohort_filter_json: { contains: cohortId } },
      select: { db_id: true, name: true },
      take: 20,
    });
  }
}
