import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class DatatableColumnDto {
  @IsString()
  @MaxLength(50)
  field_key!: string;

  @IsIn(['number', 'string', 'datetime', 'boolean'])
  data_type!: 'number' | 'string' | 'datetime' | 'boolean';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  display_name?: string;

  /** 前端会把解析结果原样回传（含主键标记与顺序）；服务端忽略，只用于兼容 whitelist 校验 */
  @IsOptional()
  @IsBoolean()
  is_primary?: boolean;

  @IsOptional()
  @IsNumber()
  sort_order?: number;
}

export class ParseDatatableDto {
  @IsString()
  @MinLength(1)
  csv_text!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => DatatableColumnDto)
  columns?: DatatableColumnDto[];
}

export class CreateDatatableDto extends ParseDatatableDto {
  @IsString()
  @MaxLength(50)
  table_key!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  remark?: string;
}

export class UpdateDatatableDto extends ParseDatatableDto {
  /** 增量（按主键 upsert）/ 替换（整表覆盖） */
  @IsIn(['incr', 'replace'])
  mode!: 'incr' | 'replace';
}

export class UpdateDatatableMetaDto {
  /** 只改备注，不动数据与结构 */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  remark?: string;
}

export class CreateBindingDto {
  @IsIn(['event_property', 'event_name', 'event_time'])
  target_type!: 'event_property' | 'event_name' | 'event_time';

  @IsString()
  @MaxLength(80)
  target_prop!: string;

  /** 方案 B：join 键列（数据表字段名），该列取值与 target_prop 的取值匹配 */
  @IsString()
  @MaxLength(50)
  key_column!: string;

  /** v1 单展示列：值映射用哪一列当业务名；不传则按 *_name / 文本列默认 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  label_field?: string;

  /** 派生属性的显示名覆盖；属性名与类型由服务端按 `<target_prop>@<field_key>` 生成，客户端不可改 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BindingFieldMappingDto)
  field_mappings?: BindingFieldMappingDto[];

  @IsOptional()
  @IsIn(['year', 'month', 'day', 'hour', 'minute', 'second'])
  granularity?: 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second';
}

export class BindingFieldMappingDto {
  @IsString()
  @MaxLength(50)
  field_key!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  display_name?: string;
}

export class UpdateBindingDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  key_column?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  label_field?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BindingFieldMappingDto)
  field_mappings?: BindingFieldMappingDto[];

  @IsOptional()
  @IsIn(['year', 'month', 'day', 'hour', 'minute', 'second'])
  granularity?: 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second';
}
