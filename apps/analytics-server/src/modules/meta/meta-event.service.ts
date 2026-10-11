import { Injectable, Logger } from '@nestjs/common';
import { MetaEventRepository, MetaEventFilter, MetaEventPagination, MetaEventSort } from './meta-event.repository';
import { ClickHouseService } from '../shared/clickhouse.service';
import { CreateMetaEventDto, UpdateMetaEventDto, BatchMetaEventsDto } from './dto/meta-event.dto';

@Injectable()
export class MetaEventService {
  private readonly logger = new Logger(MetaEventService.name);

  constructor(
    private readonly repository: MetaEventRepository,
    private readonly clickHouse: ClickHouseService,
  ) {}

  async listEvents(
    filter: MetaEventFilter,
    sort: MetaEventSort,
    pagination: MetaEventPagination,
  ) {
    return this.repository.findMany(filter, sort, pagination);
  }

  async updateEvent(eventKey: string, projectName: string, dto: UpdateMetaEventDto) {
    const data: any = {
      display_name: dto.display_name,
      description: dto.description,
      owner: dto.owner,
      remark: dto.remark,
      status: dto.status,
    };

    if (dto.status) {
      const event = await this.repository.findByKey(eventKey, projectName);
      const recentCount = event?.recent_7d_count ?? 0;
      data.availability_status = this.computeAvailabilityStatus(
        dto.status,
        recentCount,
        event?.is_deleted ?? false,
      );
    }

    return this.repository.update(eventKey, projectName, data);
  }

  async createEvent(projectName: string, dto: CreateMetaEventDto) {
    return this.repository.upsert(dto.event_key, projectName, {
      display_name: dto.display_name,
      description: dto.description,
      owner: dto.owner,
      status: dto.status ?? 'pending',
      event_type: 'report',
      availability_status: 'no_data',
      connection_status: 'auto',
    });
  }

  async batchEvents(projectName: string, dto: BatchMetaEventsDto) {
    const { action, event_keys: eventKeys } = dto;

    switch (action) {
      case 'hide':
        await this.repository.batchUpdate(eventKeys, projectName, { status: 'hidden' });
        await this.updateBatchAvailability(eventKeys, projectName);
        break;
      case 'show':
        await this.repository.batchUpdate(eventKeys, projectName, { status: 'visible' });
        await this.updateBatchAvailability(eventKeys, projectName);
        break;
      case 'deprecate':
        await this.repository.batchUpdate(eventKeys, projectName, {
          status: 'hidden',
          availability_status: 'deprecated',
        });
        break;
      case 'delete':
        await this.repository.batchUpdate(eventKeys, projectName, {
          is_deleted: true,
          deleted_at: new Date(),
          availability_status: 'hidden',
        });
        break;
    }

    return { success: true, affected: eventKeys.length };
  }

  async refreshStats(projectName: string) {
    const sql = `
      SELECT
        event,
        countIf(stat_date = today() - 1) AS yesterday_count,
        countIf(stat_date >= today() - 7) AS recent_7d_count
      FROM clklog_sa.sa_events
      WHERE project_name = {project: String}
        AND stat_date >= today() - 8
      GROUP BY event
    `;

    try {
      const rows = await this.clickHouse.query<{
        event: string;
        yesterday_count: string;
        recent_7d_count: string;
      }>(sql, { project: projectName });

      const statsMap = new Map(
        rows.map((r) => [
          r.event,
          {
            yesterday_count: parseInt(r.yesterday_count, 10),
            recent_7d_count: parseInt(r.recent_7d_count, 10),
          },
        ]),
      );

      const allEvents = await this.repository.findMany(
        { project_name: projectName },
        { sort_by: 'first_seen_at', sort_order: 'desc' },
        { page: 1, pageSize: 10000 },
      );

      for (const event of allEvents.items) {
        const stats = statsMap.get(event.event_key) ?? {
          yesterday_count: 0,
          recent_7d_count: 0,
        };
        const dataStatus = this.computeDataStatus(
          stats.yesterday_count,
          stats.recent_7d_count,
        );
        const availabilityStatus = this.computeAvailabilityStatus(
          event.status,
          stats.recent_7d_count,
          event.is_deleted,
        );

        await this.repository.update(event.event_key, projectName, {
          yesterday_count: stats.yesterday_count,
          recent_7d_count: stats.recent_7d_count,
          data_status: dataStatus,
          availability_status: availabilityStatus,
        });
      }

      this.logger.log(`已刷新项目 ${projectName} 的元事件统计`);
    } catch (error) {
      this.logger.error(`刷新元事件统计失败: ${error.message}`, error.stack);
      throw error;
    }
  }

  private async updateBatchAvailability(eventKeys: string[], projectName: string) {
    const events = await this.repository.findManyByKeys(eventKeys, projectName);
    for (const event of events) {
      const availabilityStatus = this.computeAvailabilityStatus(
        event.status,
        event.recent_7d_count,
        event.is_deleted,
      );
      await this.repository.update(event.event_key, projectName, { availability_status: availabilityStatus });
    }
  }

  private computeAvailabilityStatus(
    status: string,
    recent7dCount: number,
    isDeleted: boolean,
  ): string {
    if (isDeleted) return 'hidden';
    if (status === 'hidden') return 'hidden';
    if (status === 'deprecated' || status === 'pending') return 'deprecated';
    if (recent7dCount === 0) return 'no_data';
    return 'available';
  }

  private computeDataStatus(yesterdayCount: number, recent7dCount: number): string {
    if (recent7dCount === 0) return 'no_recent_data';
    if (yesterdayCount === 0 && recent7dCount > 0) return 'abnormal';
    return 'normal';
  }
}
