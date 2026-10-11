import { IsOptional, IsString, IsIn, IsArray, ArrayMinSize, MaxLength } from 'class-validator';

export class ListMetaEventsQueryDto {
  @IsOptional()
  @IsString()
  project?: string;

  @IsOptional()
  @IsString()
  @IsIn(['pending', 'visible', 'hidden'])
  status?: string;

  @IsOptional()
  @IsString()
  @IsIn(['report', 'virtual', 'preset'])
  event_type?: string;

  @IsOptional()
  @IsString()
  @IsIn(['available', 'no_data', 'hidden', 'deprecated'])
  availability_status?: string;

  @IsOptional()
  @IsString()
  @IsIn(['normal', 'no_recent_data', 'abnormal'])
  data_status?: string;

  @IsOptional()
  @IsString()
  @IsIn(['auto', 'virtual_from', 'preset'])
  connection_status?: string;

  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @IsString()
  @IsIn(['first_seen_at', 'yesterday_count', 'recent_7d_count', 'updated_at'])
  sort_by?: string;

  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'])
  sort_order?: string;

  @IsOptional()
  @IsString()
  page?: string;

  @IsOptional()
  @IsString()
  pageSize?: string;

  @IsOptional()
  @IsString()
  @IsIn(['true', 'false', '1', '0'])
  exclude_hidden?: string;
}

export class UpdateMetaEventDto {
  @IsOptional()
  @IsString()
  display_name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  owner?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;

  @IsOptional()
  @IsString()
  @IsIn(['pending', 'visible', 'hidden'])
  status?: string;
}

export class CreateMetaEventDto {
  @IsString()
  event_key: string;

  @IsOptional()
  @IsString()
  display_name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  owner?: string;

  @IsOptional()
  @IsString()
  @IsIn(['pending', 'visible', 'hidden'])
  status?: string;
}

export class BatchMetaEventsDto {
  @IsString()
  @IsIn(['hide', 'show', 'deprecate', 'delete'])
  action: 'hide' | 'show' | 'deprecate' | 'delete';

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  event_keys: string[];
}
