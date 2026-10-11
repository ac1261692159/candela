import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * 外部 AI 只读查询入参。
 *
 * sql 为自由 SQL（必须单条 SELECT）；project 由 API Key 绑定（服务端强制，
 * 不可由请求覆盖）；time_range 用于强制注入时间边界（若 SQL 未自带）。
 */
export class AiQueryDto {
  @IsString()
  sql: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  limit?: number;
}
