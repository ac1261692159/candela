import { Injectable, Logger } from '@nestjs/common';
import { crcForEvent } from '../../common/utils/hash.util';
import { DlqRecord, ParsedSensorsMessage, SensorsType } from './ingestor.types';

@Injectable()
export class SaEventParser {
  private readonly logger = new Logger(SaEventParser.name);

  parse(payload: Buffer | string): { messages: ParsedSensorsMessage[]; dlq: DlqRecord[] } {
    const text = typeof payload === 'string' ? payload : payload.toString('utf-8');
    const dlq: DlqRecord[] = [];

    // ClkLog receiver 写入 Kafka 的格式：CSV 头部 + JSON 数组
    // 示例：ts,project_name,device_id,?,flag,client_ip,[{sensors events}]
    const jsonStart = text.indexOf('[');
    let rawJson = text;
    let csvProjectName = 'default';
    let csvClientIp = '';

    if (jsonStart > 0) {
      const header = text.slice(0, jsonStart);
      rawJson = text.slice(jsonStart);
      const fields = header.split(',');
      if (fields.length >= 2) csvProjectName = fields[1].trim() || csvProjectName;
      if (fields.length >= 6) csvClientIp = fields[5].trim() || csvClientIp;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (error) {
      dlq.push({ payload: text, reason: 'JSON 解析失败', timestamp: new Date().toISOString() });
      return { messages: [], dlq };
    }

    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const messages: ParsedSensorsMessage[] = [];

    for (const [index, item] of arr.entries()) {
      const result = this.parseSingle(item, text, csvProjectName, csvClientIp, index);
      if ('reason' in result) {
        dlq.push(result as DlqRecord);
      } else {
        messages.push(result as ParsedSensorsMessage);
      }
    }

    return { messages, dlq };
  }

  private parseSingle(
    item: unknown,
    rawPayload: string,
    csvProjectName: string,
    csvClientIp: string,
    index: number,
  ): ParsedSensorsMessage | DlqRecord {
    if (!item || typeof item !== 'object') {
      return { payload: rawPayload, reason: '消息不是对象', timestamp: new Date().toISOString() };
    }

    const data = item as Record<string, unknown>;
    const type = data.type as SensorsType;

    if (!this.isValidType(type)) {
      return { payload: rawPayload, reason: `未知 type: ${type}`, timestamp: new Date().toISOString() };
    }

    const distinct_id = this.extractString(data, 'distinct_id');
    if (!distinct_id) {
      return { payload: rawPayload, reason: '缺少 distinct_id', timestamp: new Date().toISOString() };
    }

    const properties = (data.properties as Record<string, unknown>) || {};
    const identities = (data.identities as Record<string, unknown>) || {};
    const project_name =
      this.extractString(data, 'project_name') ||
      (properties.project_name as string) ||
      csvProjectName;

    const user_key =
      this.extractString(identities, 'user_key') ||
      this.extractString(data, 'user_key') ||
      this.extractString(data, 'login_id');

    const rawTime = data.time;
    let time: string | number;
    if (typeof rawTime === 'number') {
      time = rawTime;
    } else if (typeof rawTime === 'string' && /^\d{10,}$/.test(rawTime)) {
      time = parseInt(rawTime, 10);
    } else if (typeof rawTime === 'string') {
      time = rawTime;
    } else {
      time = Date.now();
    }

    const message: ParsedSensorsMessage = {
      type,
      event: this.extractString(data, 'event'),
      distinct_id,
      user_key,
      time,
      project_name,
      properties: {
        ...properties,
        ...(csvClientIp ? { $client_ip: csvClientIp } : {}),
      },
      original_id:
        this.extractString(data, 'original_id') ||
        this.extractString(properties, '$track_signup_original_id'),
      // CRC 基于整条 Kafka 消息原文 + 数组下标，保证同消息内不同事件唯一，
      // 同时消息重放时 CRC 稳定（幂等）。
      crc: crcForEvent(rawPayload + '#' + index),
    };

    return message;
  }

  private isValidType(type: string): type is SensorsType {
    return [
      'track',
      'track_signup',
      'user_set',
      'user_set_once',
      'user_append',
      'user_increment',
      'user_unset',
      'user_delete',
    ].includes(type);
  }

  private extractString(data: Record<string, unknown>, key: string): string | undefined {
    const value = data[key];
    if (value === null || value === undefined) return undefined;
    return String(value);
  }
}
