import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { chmod, chown, readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { DeepseekHarnessProviderConfig } from '../../config/deepseek-harness-config';
import { domainError } from '../../i18n/domain-error';
import { ModelProviderRegistryService } from './model-provider/model-provider-registry.service';
import { WorkspacePathsService } from './workspace/workspace-paths.service';

const CAPABILITY_ENV = 'CLKLOG_MODEL_CAPABILITY';
const MODEL_RELAY_BASE = 'http://127.0.0.1:39100/model';
const DEFAULT_MODEL_KEY = 'agent-default-model';

@Injectable()
export class HarnessSettingsService {
  private readonly logger = new Logger(HarnessSettingsService.name);

  constructor(
    private readonly paths: WorkspacePathsService,
    private readonly providers: ModelProviderRegistryService,
  ) {}

  async prepare(userId: string, project: string): Promise<void> {
    // 供应商与默认模型来自注册表（库优先）；max_tokens 等运行时护栏仍取部署配置
    const config = this.paths.harnessConfig();
    const snapshot = this.providers.snapshot();
    if (!snapshot.configured) {
      // 最后一道防线：不写出没有任何 provider 的 cordis.patch.yml
      throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
        code: 'ai.provider.noneConfigured',
        messageKey: 'ai:error.provider.noneConfigured',
      });
    }
    const runtimePaths = await this.paths.runtimePaths(userId, project);
    const systemUser = await this.paths.systemUser();
    await this.paths.ensureOwnedDirectory(runtimePaths.dshHome);
    await this.paths.ensureOwnedDirectory(runtimePaths.instances);
    const providers = Object.fromEntries(
      Object.entries(snapshot.providers).map(([providerId, provider]) => [
        this.routeId(providerId),
        this.providerProfile(providerId, provider, config.runtime.max_tokens),
      ]),
    );
    const patch = [
      {
        id: 'llm-pi-ai',
        config: { providers },
      },
      {
        id: 'agent-default-model',
        config: {
          provider: this.routeId(snapshot.defaults.provider),
          model: snapshot.defaults.model,
        },
      },
    ];
    const destination = join(runtimePaths.dshHome, 'cordis.patch.yml');
    const temporary = `${destination}.next-${randomBytes(6).toString('hex')}`;
    await writeFile(
      temporary,
      yaml.dump(patch, { noRefs: true, lineWidth: 120, sortKeys: false }),
      { mode: 0o600 },
    );
    await chmod(temporary, 0o600);
    if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
      await chown(temporary, systemUser.uid, systemUser.gid);
    }
    await rename(temporary, destination);
    await this.reconcileModelSettings(
      runtimePaths.dshHome,
      this.routeId(snapshot.defaults.provider),
      snapshot.defaults.model,
      snapshot.defaults.reasoning_effort,
      systemUser.uid,
      systemUser.gid,
    );
  }

  routeId(providerId: string): string {
    const readable = providerId.replace(/_/g, '-');
    const suffix = createHash('sha256').update(providerId).digest('hex').slice(0, 8);
    return `clklog-${readable}-${suffix}`;
  }

  private providerProfile(
    providerId: string,
    provider: DeepseekHarnessProviderConfig,
    maxTokens: number,
  ) {
    return {
      displayName: provider.display_name,
      apiKeyEnv: CAPABILITY_ENV,
      api: provider.protocol,
      baseURL: `${MODEL_RELAY_BASE}/${providerId}`,
      defaultContextWindow: 262_144,
      defaultMaxTokens: maxTokens,
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.display_name,
        contextWindow: 262_144,
        maxTokens,
        // 图片能力必须显式声明，DSH 才不会把图片附件挡在门外（见实现方案 §8.1）
        input: model.supports_image ? ['text', 'image'] : ['text'],
        reasoningEfforts: Object.fromEntries(
          model.reasoning_efforts.map((effort) => [effort, effort === 'off' ? null : effort]),
        ),
      })),
    };
  }

  /**
   * 把 `agent-default-model` 对齐到当前默认模型。
   *
   * 关键点：**合并写而不是覆盖**——DSH 会往同一个 `settings.yaml` 写别的偏好，
   * 整文件覆盖会把它们抹掉。因此读现有 YAML → 只改我们的键 → 原子替换；
   * 值相同时不写（省 IO，也避免与另一个存活容器抢文件）；解析失败时保留原文件并告警，
   * 宁可这一轮默认模型不生效，也不写坏用户数据。
   */
  private async reconcileModelSettings(
    dshHome: string,
    provider: string,
    model: string,
    reasoningEffort: string,
    uid: number,
    gid: number,
  ): Promise<void> {
    const destination = join(dshHome, 'settings.yaml');
    let existing: Record<string, unknown> = {};
    let content: string | null = null;
    try {
      content = await readFile(destination, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (content !== null) {
      try {
        const parsed = yaml.load(content);
        existing = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      } catch (error) {
        this.logger.error(
          `settings.yaml is not parsable; keeping the existing file (default model not applied): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      const current = existing[DEFAULT_MODEL_KEY] as Record<string, unknown> | undefined;
      if (
        current &&
        current.provider === provider &&
        current.model === model &&
        current.reasoningEffort === reasoningEffort
      ) {
        return;
      }
    }
    const merged = {
      ...existing,
      [DEFAULT_MODEL_KEY]: { provider, model, reasoningEffort },
    };
    const temporary = `${destination}.next-${randomBytes(6).toString('hex')}`;
    await writeFile(temporary, yaml.dump(merged, { noRefs: true, lineWidth: 120, sortKeys: false }), {
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
      await chown(temporary, uid, gid);
    }
    await rename(temporary, destination);
  }
}
