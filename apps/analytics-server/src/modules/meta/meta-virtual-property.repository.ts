import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';

@Injectable()
export class MetaVirtualPropertyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(projectName: string, eventKey?: string) {
    const where: Record<string, unknown> = { project_name: projectName };
    if (eventKey !== undefined) {
      where.OR = [{ event_key: eventKey }, { event_key: null }];
    }
    return this.prisma.metaVirtualProperty.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });
  }

  async findForEventKeys(projectName: string, eventKeys: string[]) {
    return this.prisma.metaVirtualProperty.findMany({
      where: {
        project_name: projectName,
        OR: [{ event_key: null }, { event_key: { in: eventKeys } }],
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async findById(id: string, projectName: string) {
    return this.prisma.metaVirtualProperty.findFirst({
      where: { id, project_name: projectName },
    });
  }

  async findByKey(propKey: string, projectName: string, eventKey?: string) {
    if (eventKey) {
      const eventSpecific = await this.prisma.metaVirtualProperty.findFirst({
        where: { project_name: projectName, prop_key: propKey, event_key: eventKey },
      });
      if (eventSpecific) return eventSpecific;
    }
    return this.prisma.metaVirtualProperty.findFirst({
      where: { project_name: projectName, prop_key: propKey, event_key: null },
    });
  }

  async create(projectName: string, data: {
    prop_key: string;
    display_name?: string;
    data_type: string;
    expression: string;
    event_key?: string;
    description?: string;
  }) {
    return this.prisma.metaVirtualProperty.create({
      data: {
        project_name: projectName,
        ...data,
      },
    });
  }

  async update(id: string, projectName: string, data: Partial<{
    display_name: string;
    data_type: string;
    expression: string;
    event_key: string;
    description: string;
    status: string;
    invalid_reason: string | null;
  }>) {
    return this.prisma.metaVirtualProperty.updateMany({
      where: { id, project_name: projectName },
      data,
    });
  }

  async delete(id: string, projectName: string) {
    return this.prisma.metaVirtualProperty.deleteMany({
      where: { id, project_name: projectName },
    });
  }
}
