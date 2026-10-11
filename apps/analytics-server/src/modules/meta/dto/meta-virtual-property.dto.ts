import { IsOptional, IsString, IsIn, IsNotEmpty } from 'class-validator';

export class CreateMetaVirtualPropertyDto {
  @IsString()
  @IsNotEmpty()
  prop_key: string;

  @IsOptional()
  @IsString()
  display_name?: string;

  @IsString()
  @IsIn(['string', 'number', 'boolean', 'datetime'])
  data_type: string;

  @IsString()
  @IsNotEmpty()
  expression: string;

  @IsOptional()
  @IsString()
  event_key?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateMetaVirtualPropertyDto {
  @IsOptional()
  @IsString()
  display_name?: string;

  @IsOptional()
  @IsString()
  @IsIn(['string', 'number', 'boolean', 'datetime'])
  data_type?: string;

  @IsOptional()
  @IsString()
  expression?: string;

  @IsOptional()
  @IsString()
  event_key?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @IsIn(['active', 'invalid', 'hidden'])
  status?: string;
}
