import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { AiAssistantController } from './ai-assistant.controller';
import { AiContextSanitizerService } from './ai-context-sanitizer.service';
import { HarnessBrokerClientService } from './harness-broker-client.service';
import { HarnessGatewayService } from './harness-gateway.service';
import { HarnessRuntimeManagerService } from './harness-runtime-manager.service';
import { HarnessSettingsService } from './harness-settings.service';
import { HarnessWebProxyService } from './harness-web-proxy.service';
import { ModelProviderAdminController } from './model-provider/model-provider-admin.controller';
import { ModelProviderProbeService } from './model-provider/model-provider-probe.service';
import { ModelProviderRegistryService } from './model-provider/model-provider-registry.service';
import { ModelProviderStoreService } from './model-provider/model-provider-store.service';
import { PageBridgeController } from './page-bridge.controller';
import { PageBridgeService } from './page-bridge.service';
import { WorkspaceAdminController } from './workspace/workspace-admin.controller';
import { WorkspaceController } from './workspace/workspace.controller';
import { WorkspacePathsService } from './workspace/workspace-paths.service';
import { WorkspaceService } from './workspace/workspace.service';
import { WorkspaceSyncService } from './workspace/workspace-sync.service';
import { WorkspaceTemplateService } from './workspace/workspace-template.service';

@Module({
  imports: [SharedModule],
  controllers: [
    AiAssistantController,
    ModelProviderAdminController,
    PageBridgeController,
    WorkspaceAdminController,
    WorkspaceController,
  ],
  providers: [
    AiContextSanitizerService,
    HarnessBrokerClientService,
    HarnessGatewayService,
    HarnessRuntimeManagerService,
    HarnessSettingsService,
    HarnessWebProxyService,
    ModelProviderProbeService,
    ModelProviderRegistryService,
    ModelProviderStoreService,
    PageBridgeService,
    WorkspacePathsService,
    WorkspaceService,
    WorkspaceSyncService,
    WorkspaceTemplateService,
  ],
  exports: [
    HarnessRuntimeManagerService,
    HarnessWebProxyService,
    ModelProviderRegistryService,
    ModelProviderStoreService,
    WorkspacePathsService,
    WorkspaceService,
    WorkspaceTemplateService,
  ],
})
export class AiAssistantModule {}
