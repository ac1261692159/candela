import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';

export class CreateMetaVirtualEventDto {
  @IsString()
  display_name: string;

  @IsObject()
  definition_json: Record<string, unknown>;

  @IsOptional()
  @IsIn(['visible', 'hidden'])
  status?: 'visible' | 'hidden';
}

export class UpdateMetaVirtualEventDto {
  @IsOptional()
  @IsString()
  display_name?: string;

  @IsOptional()
  @IsObject()
  definition_json?: Record<string, unknown>;

  @IsOptional()
  @IsIn(['visible', 'hidden'])
  status?: 'visible' | 'hidden';
}
