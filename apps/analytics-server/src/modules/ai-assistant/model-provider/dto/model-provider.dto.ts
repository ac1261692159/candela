import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * 模型供应商写入口 DTO（phase: clklog-ai-model-providers-v1）。
 *
 * 只做粗粒度形状校验（必填、类型、长度、长度上限）：真正的合法性判定统一走
 * `config/deepseek-harness-config` 的 `validateProviderShape` / `assertHarnessProviderSet`，
 * 与启动期解析 YAML 用的是同一套规则，避免两处规则漂移。
 */
export class ModelProviderModelDto {
  @IsString()
  @MaxLength(191)
  id: string;

  @IsString()
  @MaxLength(191)
  display_name: string;

  /** 模型是否接受图片输入；缺省按 false（会话生成器据此声明 DSH 输入模态） */
  @IsOptional()
  @IsBoolean()
  supports_image?: boolean;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  reasoning_efforts: string[];

  @IsString()
  @MaxLength(64)
  default_reasoning_effort: string;
}

class ModelProviderFieldsDto {
  @IsString()
  @MaxLength(191)
  display_name: string;

  @IsIn(['openai_compatible', 'deepseek'])
  adapter: string;

  @IsIn(['openai-completions', 'openai-responses', 'anthropic-messages'])
  protocol: string;

  @IsString()
  @MaxLength(191)
  base_url: string;

  /** 缺省或空串 = 不修改已保存的密钥 */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  api_key?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ModelProviderModelDto)
  models: ModelProviderModelDto[];
}

export class CreateModelProviderDto extends ModelProviderFieldsDto {
  @Matches(/^[a-z0-9_-]+$/, { message: 'provider_id' })
  @MaxLength(64)
  provider_id: string;
}

export class UpdateModelProviderDto extends ModelProviderFieldsDto {}

export class SaveModelDefaultsDto {
  @IsString()
  @MaxLength(64)
  provider: string;

  @IsString()
  @MaxLength(191)
  model: string;

  @IsString()
  @MaxLength(64)
  reasoning_effort: string;
}

export class TestModelProviderDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  model?: string;
}
