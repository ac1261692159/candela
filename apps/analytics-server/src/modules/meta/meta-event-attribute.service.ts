import { Injectable } from '@nestjs/common';
import {
  MetaEventAttributeRepository,
  EventAttributeFilter,
  EventAttributePagination,
  EventAttributeSort,
} from './meta-event-attribute.repository';

@Injectable()
export class MetaEventAttributeService {
  constructor(private readonly repository: MetaEventAttributeRepository) {}

  async list(
    filter: EventAttributeFilter,
    sort: EventAttributeSort,
    pagination: EventAttributePagination,
  ) {
    return this.repository.findMany(filter, sort, pagination);
  }

  async update(
    propKey: string,
    projectName: string,
    data: Partial<{ display_name: string; data_type: string; remark: string; status: string }>,
  ) {
    return this.repository.upsert(propKey, projectName, data);
  }

  async refreshCounts(projectName: string) {
    await this.repository.refreshEventCounts(projectName);
    return { success: true };
  }

  async detail(propKey: string, projectName: string) {
    const attribute = await this.repository.findByKey(propKey, projectName);
    const associated = await this.repository.findAssociatedEvents(propKey, projectName);
    return {
      prop_key: propKey,
      display_name: attribute?.display_name,
      data_type: attribute?.data_type,
      remark: attribute?.remark,
      status: attribute?.status,
      event_count: associated.length,
      events: associated.map((item) => ({
        event_key: item.event_key,
        display_name: item.event.display_name,
        data_type: item.data_type,
        status: item.status,
      })),
    };
  }
}
