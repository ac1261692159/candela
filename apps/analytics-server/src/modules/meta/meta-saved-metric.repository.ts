import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';

@Injectable()
export class MetaSavedMetricRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(projectName: string, kind?: string) {
    return this.prisma.metaSavedMetric.findMany({
      where: { project_name: projectName, ...(kind ? { kind } : {}) },
      orderBy: { updated_at: 'desc' },
    });
  }

  findById(metricId: string, projectName: string) {
    return this.prisma.metaSavedMetric.findFirst({
      where: { metric_id: metricId, project_name: projectName },
    });
  }

  findByName(name: string, projectName: string) {
    return this.prisma.metaSavedMetric.findUnique({
      where: { project_name_name: { project_name: projectName, name } },
    });
  }

  create(data: {
    metric_id: string;
    project_name: string;
    owner: string;
    name: string;
    display_name: string;
    remark?: string;
    kind: string;
    definition_json: string;
    format: string;
  }) {
    return this.prisma.metaSavedMetric.create({ data });
  }

  update(
    metricId: string,
    projectName: string,
    data: Partial<{ display_name: string; remark: string; definition_json: string; format: string }>,
  ) {
    return this.prisma.metaSavedMetric.updateMany({
      where: { metric_id: metricId, project_name: projectName },
      data,
    });
  }

  delete(metricId: string, projectName: string) {
    return this.prisma.metaSavedMetric.deleteMany({
      where: { metric_id: metricId, project_name: projectName },
    });
  }
}
