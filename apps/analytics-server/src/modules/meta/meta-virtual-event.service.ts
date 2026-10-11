import { Injectable } from '@nestjs/common';
import { nanoid } from 'nanoid';
import { badRequest, notFound } from '../../i18n/domain-error';
import { PrismaService } from '../shared/prisma.service';
import {
  CreateMetaVirtualEventDto,
  UpdateMetaVirtualEventDto,
} from './dto/meta-virtual-event.dto';
import { FilterGroup } from '../../types/dsl.types';

export interface VirtualEventDefinition {
  events: string[];
  filters?: FilterGroup;
}

@Injectable()
export class MetaVirtualEventService {
  constructor(private readonly prisma: PrismaService) {}

  async list(projectName: string) {
    const items = await this.prisma.metaVirtualEvent.findMany({
      where: { project_name: projectName },
      orderBy: { updated_at: 'desc' },
    });
    return items.map((item) => this.toResponse(item));
  }

  async create(projectName: string, dto: CreateMetaVirtualEventDto) {
    const definition = this.normalizeDefinition(dto.definition_json);
    await this.validateDefinition(projectName, definition);

    const veId = `ve_${nanoid(10)}`;
    const [virtualEvent] = await this.prisma.$transaction([
      this.prisma.metaVirtualEvent.create({
        data: {
          ve_id: veId,
          project_name: projectName,
          display_name: dto.display_name,
          definition_json: JSON.stringify(definition),
          status: dto.status ?? 'visible',
        },
      }),
      this.prisma.metaEvent.upsert({
        where: { event_key_project_name: { event_key: veId, project_name: projectName } },
        update: {
          display_name: dto.display_name,
          event_type: 'virtual',
          status: dto.status ?? 'visible',
          connection_status: this.buildConnectionStatus(definition.events),
          availability_status: 'available',
          data_status: 'normal',
        },
        create: {
          event_key: veId,
          project_name: projectName,
          display_name: dto.display_name,
          event_type: 'virtual',
          status: dto.status ?? 'visible',
          connection_status: this.buildConnectionStatus(definition.events),
          availability_status: 'available',
          data_status: 'normal',
        },
      }),
    ]);

    return this.toResponse(virtualEvent);
  }

  async update(veId: string, projectName: string, dto: UpdateMetaVirtualEventDto) {
    const existing = await this.prisma.metaVirtualEvent.findUnique({
      where: { ve_id: veId },
    });
    if (!existing || existing.project_name !== projectName) {
      throw notFound({
        code: 'meta.virtualEvent.notFound',
        messageKey: 'meta:error.virtualEvent.notFound',
        message: '虚拟事件不存在',
      });
    }

    let definition: VirtualEventDefinition | undefined;
    if (dto.definition_json) {
      definition = this.normalizeDefinition(dto.definition_json);
      await this.validateDefinition(projectName, definition);
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.metaVirtualEvent.update({
        where: { ve_id: veId },
        data: {
          display_name: dto.display_name,
          definition_json: definition ? JSON.stringify(definition) : undefined,
          status: dto.status,
        },
      }),
      this.prisma.metaEvent.update({
        where: { event_key_project_name: { event_key: veId, project_name: projectName } },
        data: {
          display_name: dto.display_name,
          status: dto.status,
          ...(definition && {
            connection_status: this.buildConnectionStatus(definition.events),
          }),
        },
      }),
    ]);

    return this.toResponse(updated);
  }

  async delete(veId: string, projectName: string) {
    const existing = await this.prisma.metaVirtualEvent.findUnique({
      where: { ve_id: veId },
    });
    if (!existing || existing.project_name !== projectName) {
      throw notFound({
        code: 'meta.virtualEvent.notFound',
        messageKey: 'meta:error.virtualEvent.notFound',
        message: '虚拟事件不存在',
      });
    }

    await this.prisma.$transaction([
      this.prisma.metaVirtualEvent.delete({ where: { ve_id: veId } }),
      this.prisma.metaEvent.update({
        where: { event_key_project_name: { event_key: veId, project_name: projectName } },
        data: {
          is_deleted: true,
          deleted_at: new Date(),
          availability_status: 'hidden',
        },
      }),
    ]);

    return { success: true };
  }

  async findDefinition(veId: string, projectName: string): Promise<VirtualEventDefinition | null> {
    const item = await this.prisma.metaVirtualEvent.findUnique({
      where: { ve_id: veId },
    });
    if (!item || item.project_name !== projectName) return null;
    return this.normalizeDefinition(item.definition_json);
  }

  private normalizeDefinition(input: string | Record<string, unknown>): VirtualEventDefinition {
    const raw = typeof input === 'string' ? JSON.parse(input) : input;
    const events: string[] = Array.isArray(raw.events)
      ? raw.events
      : raw.event
        ? [raw.event as string]
        : [];
    return {
      events,
      filters: raw.filters as FilterGroup | undefined,
    };
  }

  private async validateDefinition(projectName: string, def: VirtualEventDefinition) {
    if (!def.events || def.events.length === 0) {
      throw badRequest({
        code: 'meta.virtualEvent.sourceEventsRequired',
        messageKey: 'meta:error.virtualEvent.sourceEventsRequired',
        message: '虚拟事件必须至少选择一个来源事件',
      });
    }

    const events = await this.prisma.metaEvent.findMany({
      where: {
        project_name: projectName,
        event_key: { in: def.events },
        is_deleted: false,
      },
    });
    const foundKeys = new Set(events.map((e) => e.event_key));
    const missing = def.events.filter((k) => !foundKeys.has(k));
    if (missing.length > 0) {
      throw badRequest({
        code: 'meta.virtualEvent.sourceEventsNotFound',
        messageKey: 'meta:error.virtualEvent.sourceEventsNotFound',
        params: { events: missing.join(', ') },
        message: `来源事件不存在: ${missing.join(', ')}`,
      });
    }

    const virtualSource = events.find((e) => e.event_type === 'virtual');
    if (virtualSource) {
      throw badRequest({
        code: 'meta.virtualEvent.virtualSourceNotAllowed',
        messageKey: 'meta:error.virtualEvent.virtualSourceNotAllowed',
        message: '虚拟事件不能作为另一个虚拟事件的来源事件',
      });
    }

    if (def.filters?.items?.length) {
      this.validateFilterScope(def.filters, '虚拟事件全局筛选');
    }
  }

  private validateFilterScope(group: FilterGroup, label: string) {
    for (const item of group.items) {
      if ('logic' in item) {
        this.validateFilterScope(item as FilterGroup, label);
      } else {
        const filterItem = item as any;
        if (filterItem.scope && filterItem.scope !== 'event') {
          throw badRequest({
            code: 'meta.virtualEvent.filterScopeEventOnly',
            messageKey: 'meta:error.virtualEvent.filterScopeEventOnly',
            params: { label },
            message: `${label}仅支持事件属性`,
          });
        }
      }
    }
  }

  private buildConnectionStatus(events: string[]): string {
    return `virtual_from:${events.join(',')}`;
  }

  private toResponse(item: any) {
    return {
      ve_id: item.ve_id,
      project_name: item.project_name,
      display_name: item.display_name,
      event_key: item.ve_id,
      status: item.status,
      definition_json: this.normalizeDefinition(item.definition_json),
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  }
}
