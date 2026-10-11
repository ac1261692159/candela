import { Injectable, Optional } from '@nestjs/common';
import { DEFAULT_PROJECT_NAME, ParsedSensorsMessage, SaEventRecord, UserProfileRecord } from './ingestor.types';
import { formatChDate, formatChDateTimeMs, formatChDateTimeSeconds } from '../time/format';
import { ProjectTimeRegistry } from '../time/project-time-registry';
import { TimezoneService } from '../time/timezone.service';

@Injectable()
export class SaEventFlattener {
  // 缺省构造兜底纯单测；生产由 DI 注入。log_time 显式按平台时区渲染（ZQ-1）；
  // stat_date 自 v2 起按【项目时区??平台时区】切日（registry fail-open：坏配置不阻塞采集）
  constructor(
    private readonly timezones: TimezoneService = new TimezoneService(undefined),
    @Optional() private readonly projectTimes?: ProjectTimeRegistry,
  ) {}

  flatten(message: ParsedSensorsMessage): SaEventRecord {
    const props = message.properties || {};
    const logTime = new Date(message.time);

    return {
      project_name: message.project_name,
      event: message.event || '$undefined',
      log_time: formatChDateTimeMs(logTime, this.timezones.platformTz),
      stat_date: formatChDate(logTime, this.statTzOf(message.project_name)),
      distinct_id: message.distinct_id,
      user_key: message.user_key || '',
      device_id: this.extractString(props, 'device_id'),
      url_path: this.extractString(props, 'url_path') || this.extractString(props, '$url_path'),
      utm_source: this.extractString(props, 'utm_source') || this.extractString(props, '$utm_source'),
      utm_medium: this.extractString(props, 'utm_medium') || this.extractString(props, '$utm_medium'),
      utm_campaign: this.extractString(props, 'utm_campaign') || this.extractString(props, '$utm_campaign'),
      country: this.extractString(props, 'country') || this.extractString(props, '$country'),
      province: this.extractString(props, 'province') || this.extractString(props, '$province'),
      city: this.extractString(props, 'city') || this.extractString(props, '$city'),
      os: this.extractString(props, 'os') || this.extractString(props, '$os'),
      browser: this.extractString(props, 'browser') || this.extractString(props, '$browser'),
      model: this.extractString(props, 'model') || this.extractString(props, '$model'),
      app_version: this.extractString(props, 'app_version') || this.extractString(props, '$app_version'),
      lib: this.extractString(props, 'lib') || this.extractString(props, '$lib'),
      is_first_day: props.is_first_day === true || props.is_first_day === 1 ? 1 : 0,
      event_session_id: this.extractString(props, 'event_session_id') || '',
      properties: JSON.stringify(props),
      crc: message.crc,
      ingest_time: formatChDateTimeSeconds(new Date(), this.timezones.platformTz),
    };
  }

  /** 项目统计日历：项目时区 ?? 平台时区（v2 解析链） */
  private statTzOf(projectName: string): string {
    return this.projectTimes?.timeZoneOf(projectName, this.timezones.platformTz) ?? this.timezones.platformTz;
  }

  buildUserProfileRecord(message: ParsedSensorsMessage): UserProfileRecord {
    return {
      project_name: message.project_name || DEFAULT_PROJECT_NAME,
      distinct_id: message.distinct_id,
      user_key: message.user_key || '',
      properties: JSON.stringify(message.properties || {}),
      updated_at: formatChDateTimeMs(new Date(message.time), this.timezones.platformTz),
    };
  }

  private extractString(props: Record<string, unknown>, key: string): string {
    const value = props[key];
    if (value === null || value === undefined) return '';
    return String(value);
  }
}
