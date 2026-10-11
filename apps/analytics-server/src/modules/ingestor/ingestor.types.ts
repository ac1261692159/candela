export type SensorsType =
  | 'track'
  | 'track_signup'
  | 'user_set'
  | 'user_set_once'
  | 'user_append'
  | 'user_increment'
  | 'user_unset'
  | 'user_delete';

export interface ParsedSensorsMessage {
  type: SensorsType;
  event?: string;
  distinct_id: string;
  user_key?: string;
  time: string | number;
  project_name: string;
  properties: Record<string, unknown>;
  original_id?: string;
  crc: string;
}

export interface SaEventRecord {
  project_name: string;
  event: string;
  log_time: string;
  stat_date: string;
  distinct_id: string;
  user_key: string;
  device_id: string;
  url_path: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  country: string;
  province: string;
  city: string;
  os: string;
  browser: string;
  model: string;
  app_version: string;
  lib: string;
  is_first_day: number;
  event_session_id: string;
  properties: string;
  crc: string;
  ingest_time: string;
}

/** 与 ClickHouse DDL 的 DEFAULT 一致：现网单项目，消息缺省时兜底 */
export const DEFAULT_PROJECT_NAME = 'clklogapp';

export interface UserProfileRecord {
  project_name: string;
  distinct_id: string;
  user_key: string;
  properties: string;
  updated_at: string;
}

export interface DlqRecord {
  payload: string;
  reason: string;
  timestamp: string;
}
