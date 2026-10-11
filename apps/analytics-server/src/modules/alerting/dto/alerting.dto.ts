import { Allow, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, Matches, ValidateIf } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { WINDOW_DAYS_OPTIONS } from '../alert-metric-eval';

/**
 * 查询参数 `project` 的规范化：Express 对**重复** query 参数返回数组
 * （`?project=a&project=b` → `['a','b']`），若原样传给 Prisma 会 500
 * （2026-09-15 线上：`Argument project_name … provided (String, String)`）。
 * 这里统一取首值，后续即使前端重复拼参数也不会再打穿到存储层。
 */
export function normalizeProjectParam(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first ? first : undefined;
}

class ProjectQueryDto {
  @Allow()
  @Transform(({ value }) => normalizeProjectParam(value))
  project?: string;
}

export class UpdateAlertRuleDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  // 上限 1e12：事件指标的当日量级可达千万（实测 base_performance_httprequest_report 单日 1000 万+），
  // 上限卡在 100 万会让「大于阈值」类告警永远命中，等于不可用（2026-09-15 验收实测）
  @Max(1_000_000_000_000)
  threshold?: number;

  @IsOptional()
  @IsIn(['critical', 'warning', 'info'])
  severity?: 'critical' | 'warning' | 'info';

  @IsOptional()
  @IsIn(['gt', 'gte', 'lt', 'lte'])
  comparator?: 'gt' | 'gte' | 'lt' | 'lte';

  @IsOptional()
  @Type(() => Number)
  @IsIn([1, 5, 15])
  window_minutes?: number;

  /** 指标规则的时间窗口（天）：1/2/7/30 */
  @IsOptional()
  @Type(() => Number)
  @IsIn(WINDOW_DAYS_OPTIONS)
  window_days?: number;

  /** 时间范围来源（metric-v2）：metric=跟随指标查询时间；rule=由本规则窗口指定 */
  @IsOptional()
  @IsIn(['metric', 'rule'])
  time_source?: 'metric' | 'rule';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  for_windows?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(1440)
  repeat_minutes?: number;

  @IsOptional()
  @IsBoolean()
  notify_on_resolve?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  contact_id?: string | null;

  /** 多联系人绑定（一条规则可发到多个渠道）；传空数组表示「全部启用联系人」 */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  contact_ids?: string[];
}

export class AlertEventListDto extends ProjectQueryDto {
  @IsOptional()
  @IsIn(['all', 'firing', 'resolved'])
  status?: 'all' | 'firing' | 'resolved';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class CreateContactDto {
  @IsString()
  @MaxLength(80)
  name!: string;

  /** 通道 key（注册表校验，见 channels/channel-registry.ts） */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  kind?: string;

  /** 通道专属选项：{ secret?, headers?, body_template?, provider? } */
  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;

  /** 是否启用（停用后不投递） */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  webhook_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  address?: string;

  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  /** 收件人界面语言（BCP-47，如 zh-CN / en-US）：通知按此语言渲染；不填 = 平台默认 */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string | null;

  /** 收件人时区（IANA，timezone-v2）：通知时间按此渲染；不填 = 项目/平台时区 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string | null;
}

/** 通道平台配置保存入参 */
export class SaveChannelConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** 暂停投递：保留配置与密钥，但此通道不参与任何投递（含平台邮件兜底） */
  @IsOptional()
  @IsBoolean()
  muted?: boolean;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  /** 密钥字段；留空表示不修改已存密钥 */
  @IsOptional()
  @IsObject()
  secret?: Record<string, unknown>;
}

/** 通道发送测试入参 */
export class TestChannelDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  webhook_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  chat_id?: string;

  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;
}

/** 编辑联系人（全部字段可选） */
export class UpdateContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  kind?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  webhook_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  address?: string;

  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** 收件人界面语言（BCP-47）：通知按此语言渲染；null = 平台默认 */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string | null;

  /** 收件人时区（IANA，timezone-v2）：通知时间按此渲染；不填 = 项目/平台时区 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string | null;
}

/** 数据保留策略入参（retain_days = null 表示永久保留） */
export class SaveRetentionDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  retain_days?: number | null;
}

export class CreateAlertRuleDto {
  @IsString()
  @MaxLength(80)
  name!: string;

  /** 指标告警（alerting-v4）：观测源 = 数据管理里的已保存指标 */
  @IsString()
  @MaxLength(64)
  metric_id!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1_000_000_000_000)
  threshold!: number;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  unit?: string;

  @IsOptional()
  @IsIn(['critical', 'warning', 'info'])
  severity?: 'critical' | 'warning' | 'info';

  @IsOptional()
  @IsIn(['gt', 'gte', 'lt', 'lte'])
  comparator?: 'gt' | 'gte' | 'lt' | 'lte';

  @IsOptional()
  @Type(() => Number)
  @IsIn([1, 5, 15])
  window_minutes?: number;

  /** 指标时间窗口天数（事件分析按天过滤 stat_date，无分钟级窗口） */
  @IsOptional()
  @Type(() => Number)
  @IsIn(WINDOW_DAYS_OPTIONS)
  window_days?: number;

  /** 时间范围来源（metric-v2）：metric=跟随指标查询时间；rule=由本规则窗口指定 */
  @IsOptional()
  @IsIn(['metric', 'rule'])
  time_source?: 'metric' | 'rule';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  for_windows?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(1440)
  repeat_minutes?: number;

  @IsOptional()
  @IsBoolean()
  notify_on_resolve?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  contact_id?: string | null;

  /** 多联系人绑定 */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  contact_ids?: string[];
}

/** 指标「测试取值」入参（只允许白名单窗口，保证有界） */
export class ProbeMetricDto {
  @IsOptional()
  @Type(() => Number)
  @IsIn(WINDOW_DAYS_OPTIONS)
  window_days?: number;

  /** 与规则同一口径试算：rule=按本规则窗口；metric（默认）=按指标查询时间 */
  @IsOptional()
  @IsIn(['metric', 'rule'])
  time_source?: 'metric' | 'rule';
}

/** 通知模板保存入参 */
export class UpdateTemplateDto {
  @IsString()
  @MaxLength(2000)
  body!: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  subject?: string;

  /** 收件人预览（timezone-v2）：带它则时间按该联系人时区渲染（不改模板与投递） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  contact_id?: number;
}

/** 通知模板预览入参（不落库） */
export class PreviewTemplateDto {
  @IsIn(['fire', 'resolve'])
  kind!: 'fire' | 'resolve';

  /** 通道组（chat/email/sms），不是具体通道 */
  @IsIn(['chat', 'email', 'sms'])
  channel!: 'chat' | 'email' | 'sms';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  subject?: string;

  /** 收件人预览（timezone-v2）：带它则时间按该联系人时区渲染（不改模板与投递） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  contact_id?: number;
}

/** 静默窗口只接受带偏移的 ISO 8601（ZQ-8-②：裸字符串按本地/UTC 解释曾不定） */
const ISO8601_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;

export class CreateMuteDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  rule_code?: string | null;

  @IsOptional()
  @Matches(ISO8601_WITH_OFFSET, { message: 'starts_at must be ISO 8601 with a timezone offset (e.g. 2026-09-17T08:00:00Z)' })
  starts_at?: string;

  @IsOptional()
  @Matches(ISO8601_WITH_OFFSET, { message: 'ends_at must be ISO 8601 with a timezone offset (e.g. 2026-09-17T08:00:00Z)' })
  ends_at?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  duration_hours?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class NotificationListDto extends ProjectQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
