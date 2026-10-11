import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AuthUser } from '../../auth/auth.service';
import { RequirePermission } from '../../iam/require-permission';
import { HarnessRuntimeManagerService } from '../harness-runtime-manager.service';
import {
  CreateModelProviderDto,
  SaveModelDefaultsDto,
  TestModelProviderDto,
  UpdateModelProviderDto,
} from './dto/model-provider.dto';
import { ModelProviderProbeService } from './model-provider-probe.service';
import { ModelProviderRegistryService } from './model-provider-registry.service';
import { ModelProviderStoreService } from './model-provider-store.service';

/**
 * 模型供应商设置（phase: clklog-ai-model-providers-v1）。
 *
 * 与「AI Workspace 管理」共用 `ops.ai_workspace.manage`：该权限已把页面入口限给超管，
 * 密钥状态只回显末 4 位，普通成员既看不到入口也调不通这些接口。
 */
@Controller('sa/api/admin/ai')
@RequirePermission('ops.ai_workspace.manage')
export class ModelProviderAdminController {
  constructor(
    private readonly store: ModelProviderStoreService,
    private readonly registry: ModelProviderRegistryService,
    private readonly probe: ModelProviderProbeService,
    private readonly runtimes: HarnessRuntimeManagerService,
  ) {}

  @Get('model-providers')
  async view() {
    return {
      ...(await this.store.adminView()),
      applyable_runtimes: this.runtimes.countRuntimes(),
    };
  }

  @Post('model-providers')
  async create(@Body() body: CreateModelProviderDto, @CurrentUser() user: AuthUser) {
    await this.store.create(body.provider_id, body, user.username);
    await this.registry.refresh();
    return { ok: true, applyable_runtimes: this.runtimes.countRuntimes() };
  }

  @Put('model-providers/:providerId')
  async update(
    @Param('providerId') providerId: string,
    @Body() body: UpdateModelProviderDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.store.update(providerId, body, user.username);
    await this.registry.refresh();
    return { ok: true, applyable_runtimes: this.runtimes.countRuntimes() };
  }

  @Delete('model-providers/:providerId')
  async remove(@Param('providerId') providerId: string, @CurrentUser() user: AuthUser) {
    await this.store.remove(providerId, user.username);
    await this.registry.refresh();
    return { ok: true, applyable_runtimes: this.runtimes.countRuntimes() };
  }

  @Put('model-defaults')
  async saveDefaults(@Body() body: SaveModelDefaultsDto, @CurrentUser() user: AuthUser) {
    await this.store.saveDefaults(body, user.username);
    await this.registry.refresh();
    return { ok: true, applyable_runtimes: this.runtimes.countRuntimes() };
  }

  /** 不带 model 时测该供应商下全部模型；逐模型记录结果，通过的才进入助手模型列表 */
  @Post('model-providers/:providerId/test')
  async test(
    @Param('providerId') providerId: string,
    @Body() body: TestModelProviderDto,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.probe.test(providerId, body?.model, user.username);
    await this.registry.refresh();
    return result;
  }

  /** 立即应用：回收运行中的会话，让它们按新配置重建（默认是惰性生效，不打断对话） */
  @Post('model-providers/apply')
  async apply(@CurrentUser() user: AuthUser) {
    await this.registry.refresh();
    const recycled = await this.runtimes.recycleAll();
    await this.store.audit('ai_model_provider_apply', { recycled }, user.username);
    return { recycled };
  }
}
