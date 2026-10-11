import { Body, Controller, Post } from '@nestjs/common';
import { AiQueryService } from './ai-query.service';
import { AiQueryDto } from './dto/ai-query.dto';
import {
  RequireApiKey,
  CurrentApiKey,
  ApiKeyIdentity,
} from '../../common/decorators/api-key.decorator';

/**
 * 外部 AI 只读查询端点。
 * 认证：@RequireApiKey() → X-API-Key 头（或 Authorization: Bearer <key>）。
 */
@Controller('sa/api/ai')
export class AiQueryController {
  constructor(private readonly aiQueryService: AiQueryService) {}

  /** POST /sa/api/ai/query */
  @RequireApiKey()
  @Post('query')
  query(@Body() dto: AiQueryDto, @CurrentApiKey() identity: ApiKeyIdentity) {
    return this.aiQueryService.query(dto, identity);
  }
}
