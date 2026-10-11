import { Type } from 'class-transformer';
import {
  Allow,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  ArrayMinSize,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** 创建全局卡片（不归属看板；加入看板走关联接口） */
export class CreateCardDto {
  @IsString()
  @MaxLength(100)
  name: string;

  /** 描述可为空；空串在 service 归一为 null */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string | null;

  @IsString()
  @IsIn(['event', 'funnel', 'retention', 'sql', 'text', 'metric'])
  type: 'event' | 'funnel' | 'retention' | 'sql' | 'text' | 'metric';

  // DSL 对象（EventAnalysisQuery / FunnelQuery / {sql_text} 等），由 service JSON.stringify 存储
  @Allow()
  dsl: unknown;

  @IsOptional()
  @IsString()
  @IsIn([
    'line',
    'bar',
    'table',
    'number',
    'pie',
    'funnel',
    'trend',
    'stack',
    'cumulative',
    'distribution',
    'nth_trend',
    'daily_trend',
  ])
  chart_type?: string;

  @IsOptional()
  @IsString()
  @IsIn(['auto', 'manual'])
  refresh_policy?: string;
}

/** 更新全局卡片 */
export class UpdateCardDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  /** 传空串表示清空描述 */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string | null;

  @IsOptional()
  @Allow()
  dsl?: unknown;

  @IsOptional()
  @IsString()
  @IsIn([
    'line',
    'bar',
    'table',
    'number',
    'pie',
    'funnel',
    'trend',
    'stack',
    'cumulative',
    'distribution',
    'nth_trend',
    'daily_trend',
  ])
  chart_type?: string;

  @IsOptional()
  @IsString()
  @IsIn(['auto', 'manual'])
  refresh_policy?: string;
}

/** 添加已有卡片到看板（布局入参） */
export class AddCardToDashboardDto {
  @IsString()
  card_id: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  position_x?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  position_y?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number;
}

/** 更新看板内卡片布局 */
export class UpdateCardLayoutDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  position_x?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  position_y?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number;
}

export class UpdateCardDisplayDto {
  @IsString()
  view: string;
}

export class ReorderCardsDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  card_ids: string[];
}

export class DashboardLayoutItemDto {
  @IsString()
  card_id: string;

  @IsInt()
  @Min(0)
  position_x: number;

  @IsInt()
  @Min(0)
  position_y: number;

  @IsInt()
  @Min(1)
  width: number;

  @IsInt()
  @Min(1)
  height: number;
}

export class SaveDashboardLayoutDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DashboardLayoutItemDto)
  items: DashboardLayoutItemDto[];
}
