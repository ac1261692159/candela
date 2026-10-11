import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ApiKeyService } from './api-key.service';
import { AuthAuditService } from './auth-audit.service';
import { AuthTokenService } from './auth-token.service';
import { AuthMailService } from './auth-mail.service';
import { AUTH_MAIL_CONFIG } from './auth-mail.config';
import { appConfig } from '../../config/configuration';
import { AiAssistantModule } from '../ai-assistant/ai-assistant.module';

@Module({
  imports: [SharedModule, AiAssistantModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    ApiKeyService,
    AuthAuditService,
    AuthTokenService,
    AuthMailService,
    // 配置在此注入：只有装配层 import configuration，服务本身保持可测（CI 无业务环境变量）
    { provide: AUTH_MAIL_CONFIG, useFactory: () => ({ env: appConfig.authMail, configKey: appConfig.alerting.configKey }) },
  ],
  exports: [AuthService, ApiKeyService, AuthAuditService, AuthTokenService, AuthMailService],
})
export class AuthModule {}
