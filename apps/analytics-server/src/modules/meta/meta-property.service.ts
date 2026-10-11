import { Injectable } from '@nestjs/common';
import { MetaPropertyRepository } from './meta-property.repository';
import { MetaVirtualEventService } from './meta-virtual-event.service';
import { UpdateMetaPropertyDto } from './dto/meta-property.dto';

@Injectable()
export class MetaPropertyService {
  constructor(
    private readonly repository: MetaPropertyRepository,
    private readonly virtualEvents: MetaVirtualEventService,
  ) {}

  async getEventProperties(eventKey: string, projectName: string) {
    const def = await this.virtualEvents.findDefinition(eventKey, projectName);
    const keys = def?.events?.length ? def.events : [eventKey];
    const lists = await Promise.all(
      keys.map((key) => this.repository.findEventProperties(key, projectName)),
    );
    const seen = new Set<string>();
    const merged: Awaited<ReturnType<MetaPropertyRepository['findEventProperties']>> = [];
    for (const list of lists) {
      for (const prop of list) {
        if (seen.has(prop.prop_key)) continue;
        seen.add(prop.prop_key);
        merged.push(prop);
      }
    }
    return merged;
  }

  async getUserProperties(projectName: string) {
    return this.repository.findUserProperties(projectName);
  }

  async updateEventProperty(id: string, dto: UpdateMetaPropertyDto) {
    return this.repository.updateEventProperty(id, {
      display_name: dto.display_name,
      data_type: dto.data_type,
      status: dto.status,
    });
  }

  async updateUserProperty(id: string, dto: UpdateMetaPropertyDto) {
    return this.repository.updateUserProperty(id, {
      display_name: dto.display_name,
      data_type: dto.data_type,
      status: dto.status,
    });
  }

  /**
   * 属性物化（M8）：生成物化列名，返回待执行的 ALTER 语句。
   * 实际执行 ALTER TABLE 需要管理员确认，本期先返回 DDL 不自动执行。
   */
  async materializeEventProperty(id: string, projectName: string) {
    const prop = await this.repository.findEventPropertyById(id);
    if (!prop || prop.project_name !== projectName) {
      throw new Error('属性不存在');
    }
    const columnName = this.generateMaterializedColumnName(prop.prop_key);
    const ddl = `ALTER TABLE clklog_sa.sa_events ADD COLUMN IF NOT EXISTS ${columnName} ${this.clickHouseType(prop.data_type)} MATERIALIZED JSONExtract${this.extractFunc(prop.data_type)}(properties, '${prop.prop_key}')`;
    return { prop, columnName, ddl };
  }

  async materializeUserProperty(id: string, projectName: string) {
    const prop = await this.repository.findUserPropertyById(id);
    if (!prop || prop.project_name !== projectName) {
      throw new Error('属性不存在');
    }
    const columnName = this.generateMaterializedColumnName(prop.prop_key);
    const ddl = `ALTER TABLE clklog_sa.sa_events ADD COLUMN IF NOT EXISTS ${columnName} ${this.clickHouseType(prop.data_type)} MATERIALIZED JSONExtract${this.extractFunc(prop.data_type)}(properties, '${prop.prop_key}')`;
    return { prop, columnName, ddl };
  }

  private generateMaterializedColumnName(propKey: string): string {
    const snake = propKey.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    return `p_${snake}`;
  }

  private clickHouseType(dataType: string): string {
    switch (dataType) {
      case 'number':
        return 'Float64';
      case 'boolean':
        return 'UInt8';
      case 'datetime':
        return 'DateTime64(3)';
      case 'list':
      case 'object':
      case 'object_group':
        return 'String';
      case 'string':
      default:
        return 'String';
    }
  }

  private extractFunc(dataType: string): string {
    switch (dataType) {
      case 'number':
        return 'Float';
      case 'boolean':
        return 'Bool';
      case 'datetime':
        return 'String'; // 物化列类型为 DateTime64 时，需配合 parseDateTimeBestEffort；简化先用 String
      case 'list':
      case 'object':
      case 'object_group':
        return 'Raw';
      case 'string':
      default:
        return 'String';
    }
  }
}
