import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';

@Injectable()
export class MetaPropertyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findEventProperties(eventKey: string, projectName: string) {
    return this.prisma.metaEventProperty.findMany({
      where: { event_key: eventKey, project_name: projectName },
      orderBy: { updated_at: 'desc' },
    });
  }

  async findUserProperties(projectName: string) {
    return this.prisma.metaUserProperty.findMany({
      where: { project_name: projectName },
      orderBy: { updated_at: 'desc' },
    });
  }

  async findEventPropertyById(id: string) {
    return this.prisma.metaEventProperty.findUnique({ where: { id } });
  }

  async findUserPropertyById(id: string) {
    return this.prisma.metaUserProperty.findUnique({ where: { id } });
  }

  async upsertEventProperty(
    eventKey: string,
    projectName: string,
    propKey: string,
    data: Partial<{
      display_name: string;
      data_type: string;
      sample_value: string;
      status: string;
    }>,
  ) {
    return this.prisma.metaEventProperty.upsert({
      where: {
        event_key_project_name_prop_key: {
          event_key: eventKey,
          project_name: projectName,
          prop_key: propKey,
        },
      },
      update: data,
      create: {
        event_key: eventKey,
        project_name: projectName,
        prop_key: propKey,
        ...data,
      },
    });
  }

  async upsertUserProperty(
    projectName: string,
    propKey: string,
    data: Partial<{
      display_name: string;
      data_type: string;
      status: string;
    }>,
  ) {
    return this.prisma.metaUserProperty.upsert({
      where: {
        project_name_prop_key: {
          project_name: projectName,
          prop_key: propKey,
        },
      },
      update: data,
      create: {
        project_name: projectName,
        prop_key: propKey,
        ...data,
      },
    });
  }

  async updateEventProperty(id: string, data: Partial<{
    display_name: string;
    data_type: string;
    status: string;
    is_materialized: boolean;
    materialized_column: string;
  }>) {
    return this.prisma.metaEventProperty.update({ where: { id }, data });
  }

  async updateUserProperty(id: string, data: Partial<{
    display_name: string;
    data_type: string;
    status: string;
    is_materialized: boolean;
    materialized_column: string;
  }>) {
    return this.prisma.metaUserProperty.update({ where: { id }, data });
  }
}
