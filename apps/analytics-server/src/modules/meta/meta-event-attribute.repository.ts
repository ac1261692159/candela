import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';

export interface EventAttributeFilter {
  project_name: string;
  data_type?: string[];
  status?: string;
  keyword?: string;
}

export interface EventAttributePagination {
  page: number;
  pageSize: number;
}

export interface EventAttributeSort {
  sort_by?: 'prop_key' | 'event_count' | 'updated_at';
  sort_order?: 'asc' | 'desc';
}

@Injectable()
export class MetaEventAttributeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(
    filter: EventAttributeFilter,
    sort: EventAttributeSort,
    pagination: EventAttributePagination,
  ) {
    const where: any = {
      project_name: filter.project_name,
    };

    if (filter.data_type && filter.data_type.length > 0) {
      where.data_type = { in: filter.data_type };
    }
    if (filter.status) {
      where.status = filter.status;
    }
    if (filter.keyword) {
      where.OR = [
        { prop_key: { contains: filter.keyword } },
        { display_name: { contains: filter.keyword } },
        { remark: { contains: filter.keyword } },
      ];
    }

    // 分页必须有序且**唯一**：批量发现导入后大量行 updated_at 完全相同，
    // 只按它排序时 LIMIT/OFFSET 翻页会重复+漏项（实测 459 行只翻到 260 个不同 prop_key，
    // 被漏掉的属性在「选择属性」下拉里永远搜不到），这里统一用 prop_key 兜底。
    const primary = sort.sort_by ?? 'updated_at';
    const orderBy: any =
      primary === 'prop_key'
        ? [{ prop_key: sort.sort_order ?? 'asc' }]
        : [{ [primary]: sort.sort_order ?? 'desc' }, { prop_key: 'asc' }];

    const skip = (pagination.page - 1) * pagination.pageSize;
    const [items, total] = await Promise.all([
      this.prisma.metaEventAttribute.findMany({
        where,
        orderBy,
        skip,
        take: pagination.pageSize,
      }),
      this.prisma.metaEventAttribute.count({ where }),
    ]);

    return { items, total, page: pagination.page, pageSize: pagination.pageSize };
  }

  async findByKey(propKey: string, projectName: string) {
    return this.prisma.metaEventAttribute.findUnique({
      where: { project_name_prop_key: { project_name: projectName, prop_key: propKey } },
    });
  }

  async upsert(
    propKey: string,
    projectName: string,
    data: Partial<{
      display_name: string;
      data_type: string;
      remark: string;
      status: string;
      event_count: number;
    }>,
  ) {
    return this.prisma.metaEventAttribute.upsert({
      where: { project_name_prop_key: { project_name: projectName, prop_key: propKey } },
      update: data,
      create: {
        project_name: projectName,
        prop_key: propKey,
        ...data,
      },
    });
  }

  async incrementEventCount(propKey: string, projectName: string) {
    return this.prisma.metaEventAttribute.update({
      where: { project_name_prop_key: { project_name: projectName, prop_key: propKey } },
      data: { event_count: { increment: 1 } },
    });
  }

  async refreshEventCounts(projectName: string) {
    const rows = await this.prisma.metaEventProperty.groupBy({
      by: ['project_name', 'prop_key'],
      where: { project_name: projectName },
      _count: { event_key: true },
    });

    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      await this.prisma.$transaction(
        chunk.map((row) =>
          this.prisma.metaEventAttribute.upsert({
            where: {
              project_name_prop_key: { project_name: row.project_name, prop_key: row.prop_key },
            },
            update: { event_count: row._count.event_key },
            create: {
              project_name: row.project_name,
              prop_key: row.prop_key,
              event_count: row._count.event_key,
            },
          }),
        ),
      );
    }
  }

  async findAssociatedEvents(propKey: string, projectName: string) {
    return this.prisma.metaEventProperty.findMany({
      where: { project_name: projectName, prop_key: propKey },
      include: { event: true },
      orderBy: { updated_at: 'desc' },
    });
  }
}
