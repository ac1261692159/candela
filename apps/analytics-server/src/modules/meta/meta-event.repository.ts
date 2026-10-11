import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';

export interface MetaEventFilter {
  project_name: string;
  status?: string;
  event_type?: string;
  availability_status?: string;
  data_status?: string;
  connection_status?: string;
  keyword?: string;
  exclude_hidden?: boolean;
}

export interface MetaEventSort {
  sort_by?: 'first_seen_at' | 'yesterday_count' | 'recent_7d_count' | 'updated_at';
  sort_order?: 'asc' | 'desc';
}

export interface MetaEventPagination {
  page: number;
  pageSize: number;
}

@Injectable()
export class MetaEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(
    filter: MetaEventFilter,
    sort: MetaEventSort,
    pagination: MetaEventPagination,
  ) {
    const where: any = {
      project_name: filter.project_name,
      is_deleted: false,
    };
    if (filter.status) {
      where.status = filter.status;
    } else if (filter.exclude_hidden) {
      where.status = { not: 'hidden' };
    }
    if (filter.event_type) {
      where.event_type = filter.event_type;
    }
    if (filter.availability_status) {
      where.availability_status = filter.availability_status;
    }
    if (filter.data_status) {
      where.data_status = filter.data_status;
    }
    if (filter.connection_status) {
      where.connection_status = { startsWith: filter.connection_status };
    }
    if (filter.keyword) {
      where.OR = [
        { event_key: { contains: filter.keyword } },
        { display_name: { contains: filter.keyword } },
        { remark: { contains: filter.keyword } },
      ];
    }

    // 同 meta_event_attributes：first_seen_at 在批量发现导入后大量相同，
    // 只按它排序 + skip/take 会让翻页重复/漏事件，统一用 event_key 兜底保证顺序唯一。
    const orderBy: any = [
      { [sort.sort_by ?? 'first_seen_at']: sort.sort_order ?? 'desc' },
      { event_key: 'asc' },
    ];

    const skip = (pagination.page - 1) * pagination.pageSize;
    const [items, total] = await Promise.all([
      this.prisma.metaEvent.findMany({
        where,
        orderBy,
        skip,
        take: pagination.pageSize,
      }),
      this.prisma.metaEvent.count({ where }),
    ]);

    return { items, total, page: pagination.page, pageSize: pagination.pageSize };
  }

  async findByKey(eventKey: string, projectName: string) {
    return this.prisma.metaEvent.findUnique({
      where: { event_key_project_name: { event_key: eventKey, project_name: projectName } },
    });
  }

  async findManyByKeys(eventKeys: string[], projectName: string) {
    return this.prisma.metaEvent.findMany({
      where: {
        event_key: { in: eventKeys },
        project_name: projectName,
        is_deleted: false,
      },
    });
  }

  async upsert(
    eventKey: string,
    projectName: string,
    data: Partial<{
      display_name: string;
      description: string;
      owner: string;
      status: string;
      event_type: string;
      is_preset: boolean;
      availability_status: string;
      data_status: string;
      connection_status: string;
    }>,
  ) {
    return this.prisma.metaEvent.upsert({
      where: { event_key_project_name: { event_key: eventKey, project_name: projectName } },
      update: data,
      create: {
        event_key: eventKey,
        project_name: projectName,
        ...data,
      },
    });
  }

  async update(
    eventKey: string,
    projectName: string,
    data: Partial<{
      display_name: string;
      description: string;
      owner: string;
      status: string;
      event_type: string;
      yesterday_count: number;
      recent_7d_count: number;
      availability_status: string;
      data_status: string;
      connection_status: string;
      is_deleted: boolean;
      deleted_at: Date | null;
    }>,
  ) {
    return this.prisma.metaEvent.update({
      where: { event_key_project_name: { event_key: eventKey, project_name: projectName } },
      data,
    });
  }

  async batchUpdate(
    eventKeys: string[],
    projectName: string,
    data: Partial<{
      status: string;
      availability_status: string;
      is_deleted: boolean;
      deleted_at: Date | null;
    }>,
  ) {
    return this.prisma.metaEvent.updateMany({
      where: {
        event_key: { in: eventKeys },
        project_name: projectName,
      },
      data,
    });
  }
}
