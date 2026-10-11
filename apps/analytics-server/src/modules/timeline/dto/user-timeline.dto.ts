import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * 时间输入：`YYYY-MM-DD HH:mm`，按**平台时区**解释（与采集落 `log_time` 的口径一致；
 * 服务端用 `parseChDateTimeInTz` 还原成 epoch，避免 naïve 字符串的时区歧义）。
 */
export const TIMELINE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

export class UserTimelineQueryDto {
  /** 分析主体（缺省 = 预置「用户」：if(user_key != '', user_key, distinct_id)） */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  subject_id?: string;

  /** 标识口径：subject（默认，走分析主体）/ user_property / event_property（按属性等值查） */
  @IsOptional()
  @IsIn(['subject', 'user_property', 'event_property'])
  id_kind?: 'subject' | 'user_property' | 'event_property';

  /** id_kind 为属性时的属性键（如 massid） */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  id_key?: string;

  /** 标识值 / 属性值 */
  @IsString()
  @MaxLength(200)
  value: string;

  @Matches(TIMELINE_TIME_PATTERN, { message: 'from 需为 YYYY-MM-DD HH:mm' })
  from: string;

  @Matches(TIMELINE_TIME_PATTERN, { message: 'to 需为 YYYY-MM-DD HH:mm' })
  to: string;

  /** 事件名多选（可选；给了会明显更快 —— 事件名是 sa_events 排序键首列） */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  events?: string[];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  /** 物化/单页条数（越界由 service 收敛） */
  @IsOptional()
  @IsInt()
  limit?: number;

  /** 服务端行级筛选：属性键 + 值（scope 默认事件属性） */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  filter_key?: string;

  @IsOptional()
  @IsIn(['event', 'user'])
  filter_scope?: 'event' | 'user';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  filter_value?: string;
}

/** 「查看前后行为」入参（anchor 取自某行的 log_time 原文） */
export class UserTimelineNeighborsDto extends UserTimelineQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/, { message: 'anchor 需为 ClickHouse 时间串' })
  anchor: string;

  @IsOptional()
  @IsInt()
  limit?: number;
}
