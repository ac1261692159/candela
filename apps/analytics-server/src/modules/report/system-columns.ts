/**
 * sa_events 物理系统字段（Builder 分组维度白名单）。
 * SQL 生成时仅允许此名单内的列名，防注入；与 SchemaService 返回的 system_columns 同源。
 *
 * `desc_key`：展示名文案键（i18n v1，前端优先用 key 渲染；`desc` 中文原值保留为兜底）。
 */
export const SYSTEM_COLUMNS: Array<{ name: string; type: string; desc: string; desc_key: string }> = [
  { name: 'event', type: 'String', desc: '事件名', desc_key: 'meta:systemColumn.event' },
  { name: 'log_time', type: 'DateTime64(3)', desc: '事件时间', desc_key: 'meta:systemColumn.logTime' },
  { name: 'stat_date', type: 'Date', desc: '统计日期', desc_key: 'meta:systemColumn.statDate' },
  { name: 'distinct_id', type: 'String', desc: '匿名用户 ID', desc_key: 'meta:systemColumn.distinctId' },
  { name: 'user_key', type: 'String', desc: '登录用户 ID', desc_key: 'meta:systemColumn.userKey' },
  { name: 'device_id', type: 'String', desc: '设备 ID', desc_key: 'meta:systemColumn.deviceId' },
  { name: 'url_path', type: 'String', desc: '页面路径', desc_key: 'meta:systemColumn.urlPath' },
  { name: 'os', type: 'String', desc: '操作系统', desc_key: 'meta:systemColumn.os' },
  { name: 'browser', type: 'String', desc: '浏览器', desc_key: 'meta:systemColumn.browser' },
  { name: 'country', type: 'String', desc: '国家', desc_key: 'meta:systemColumn.country' },
  { name: 'province', type: 'String', desc: '省份', desc_key: 'meta:systemColumn.province' },
  { name: 'city', type: 'String', desc: '城市', desc_key: 'meta:systemColumn.city' },
  { name: 'is_first_day', type: 'UInt8', desc: '是否首日', desc_key: 'meta:systemColumn.isFirstDay' },
  { name: 'properties', type: 'String(JSON)', desc: '事件属性 JSON', desc_key: 'meta:systemColumn.properties' },
  { name: 'project_name', type: 'String', desc: '项目名', desc_key: 'meta:systemColumn.projectName' },
];

/** 可作为分组维度的系统字段（排除 properties/project_name 等大字段与过滤列） */
export const GROUPABLE_SYSTEM_COLUMNS = SYSTEM_COLUMNS.filter(
  (c) => !['properties', 'project_name'].includes(c.name),
);
