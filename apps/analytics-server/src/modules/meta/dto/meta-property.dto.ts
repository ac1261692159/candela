import { IsIn, IsOptional, IsString } from 'class-validator';

export class UpdateMetaPropertyDto {
  @IsOptional()
  @IsString()
  display_name?: string;

  @IsOptional()
  @IsIn(['string', 'number', 'boolean', 'datetime', 'list', 'object', 'object_group'])
  data_type?: 'string' | 'number' | 'boolean' | 'datetime' | 'list' | 'object' | 'object_group';

  @IsOptional()
  @IsIn(['pending', 'visible', 'hidden'])
  status?: 'pending' | 'visible' | 'hidden';
}
