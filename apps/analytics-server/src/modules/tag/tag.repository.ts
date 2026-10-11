import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../shared/prisma.service';

@Injectable()
export class TagRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(projectName: string, keyword?: string) {
    return this.prisma.metaUserTag.findMany({
      where: {
        project_name: projectName,
        ...(keyword
          ? {
              OR: [{ name: { contains: keyword } }, { display_name: { contains: keyword } }],
            }
          : {}),
      },
      orderBy: { updated_at: 'desc' },
    });
  }

  listReady(projectName: string, subjectId?: string, includeEmpty = false) {
    return this.prisma.metaUserTag.findMany({
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
    return this.prisma.metaUserTag.count({ where: { project_name: projectName } });
  }

  findById(tagId: string, projectName: string) {
    return this.prisma.metaUserTag.findFirst({
      where: { tag_id: tagId, project_name: projectName },
    });
  }

  findByName(name: string, projectName: string) {
    return this.prisma.metaUserTag.findUnique({
      where: { project_name_name: { project_name: projectName, name } },
    });
  }

  create(data: Prisma.MetaUserTagCreateInput) {
    return this.prisma.metaUserTag.create({ data });
  }

  update(tagId: string, projectName: string, data: Prisma.MetaUserTagUncheckedUpdateInput) {
    return this.prisma.metaUserTag.updateMany({
      where: { tag_id: tagId, project_name: projectName },
      data,
    });
  }

  delete(tagId: string, projectName: string) {
    return this.prisma.metaUserTag.deleteMany({
      where: { tag_id: tagId, project_name: projectName },
    });
  }

  listDaily() {
    return this.prisma.metaUserTag.findMany({
      where: { kind: 'condition', schedule: 'daily' },
    });
  }

  findCardsReferencing(projectName: string, tagId: string) {
    return this.prisma.card.findMany({
      where: { project_name: projectName, dsl_json: { contains: tagId } },
      select: { card_id: true, name: true },
      take: 20,
    });
  }
}
