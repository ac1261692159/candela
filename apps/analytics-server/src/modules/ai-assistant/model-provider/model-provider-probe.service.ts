import { Injectable } from '@nestjs/common';
import { DeepseekHarnessProviderConfig } from '../../../config/deepseek-harness-config';
import { badRequest, notFound } from '../../../i18n/domain-error';
import { describeError, postJson } from '../../alerting/channels/http';
import { ModelProviderStoreService } from './model-provider-store.service';

/** 与模型出口网关同一套路径拼装：base_url 的 path/query 保留，端点接在其后 */
const ENDPOINTS: Record<string, { path: string; anthropic: boolean }> = {
  'openai-completions': { path: '/chat/completions', anthropic: false },
  'openai-responses': { path: '/responses', anthropic: false },
  'anthropic-messages': { path: '/messages', anthropic: true },
};
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_TOKENS = 16;
const DETAIL_LIMIT = 500;

export interface ModelProviderProbeResult {
  ok: boolean;
  status: number;
  elapsed_ms: number;
  model: string;
  /** 平台自己判定的失败原因（可本地化）；厂商侧错误看 detail */
  error_code?: string;
  error_key?: string;
  /** 厂商原始响应片段（截断，不含任何请求头/密钥） */
  detail?: string;
}

/**
 * 供应商连通性探测（phase: clklog-ai-model-providers-v1）。
 *
 * 按供应商的协议发一次**最小真实请求**（`max_tokens: 16`），复用网关的路径拼装与认证头，
 * 这样「测通了」与「网关能用」是同一件事。上游失败不抛异常：页面需要看到厂商原始错误。
 *
 * v1.2：测试结果逐个模型落库（`verified_json`），只有通过的模型才会进入助手的模型列表；
 * 供应商从**库行**读取而不是从有效配置快照读取——未验证的供应商在快照里是被过滤掉的，
 * 否则会陷入「要先测通才能测」的死循环。
 */
@Injectable()
export class ModelProviderProbeService {
  constructor(private readonly store: ModelProviderStoreService) {}

  /** 不带 model 时测该供应商下的**全部**模型（逐模型记录结果） */
  async test(
    providerId: string,
    requestedModel: string | undefined,
    operator: string,
  ): Promise<{ results: ModelProviderProbeResult[] }> {
    const load = await this.store.loadDatabase();
    const entry = load.entries.find((candidate) => candidate.row.provider_id === providerId);
    if (!entry) {
      throw notFound({
        code: 'ai.modelProvider.notFound',
        messageKey: 'ai:error.provider.notFound',
        params: { id: providerId },
      });
    }
    const models = requestedModel
      ? entry.shape.models.filter((candidate) => candidate.id === requestedModel)
      : entry.shape.models;
    if (models.length === 0) {
      throw badRequest({
        code: 'ai.modelProvider.testModelMissing',
        messageKey: 'ai:error.provider.testModelMissing',
        params: { provider: providerId, model: requestedModel ?? '' },
      });
    }
    const results: ModelProviderProbeResult[] = [];
    for (const model of models) {
      const result = entry.key.plain
        ? await this.probe({ ...entry.shape, configured: true }, model.id, entry.key.plain)
        : {
            ok: false,
            status: 0,
            elapsed_ms: 0,
            model: model.id,
            error_code: 'provider_not_configured',
            error_key: 'ai:error.gateway.providerNotConfigured',
          };
      await this.store.recordTest(providerId, model.id, result.ok, operator);
      await this.store.audit('ai_model_provider_test', {
        provider_id: providerId,
        model: model.id,
        ok: result.ok,
        status: result.status,
        elapsed_ms: result.elapsed_ms,
      }, operator);
      results.push(result);
    }
    return { results };
  }

  private async probe(
    provider: DeepseekHarnessProviderConfig,
    model: string,
    apiKey: string,
  ): Promise<ModelProviderProbeResult> {
    const endpoint = ENDPOINTS[provider.protocol];
    const base = new URL(provider.base_url);
    const url = `${base.origin}${base.pathname.replace(/\/$/, '')}${endpoint.path}${base.search}`;
    const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
    if (endpoint.anthropic) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
    const body = endpoint.anthropic
      ? { model, max_tokens: PROBE_MAX_TOKENS, messages: [{ role: 'user', content: 'ping' }] }
      : provider.protocol === 'openai-responses'
        ? { model, input: 'ping', max_output_tokens: PROBE_MAX_TOKENS }
        : {
            model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: PROBE_MAX_TOKENS,
            stream: false,
          };
    const startedAt = Date.now();
    try {
      const result = await postJson(url, body, { headers, timeoutMs: PROBE_TIMEOUT_MS });
      const elapsed = Date.now() - startedAt;
      const snippet = result.body.replace(/\s+/g, ' ').slice(0, DETAIL_LIMIT);
      return result.status >= 200 && result.status < 300
        ? { ok: true, status: result.status, elapsed_ms: elapsed, model }
        : { ok: false, status: result.status, elapsed_ms: elapsed, model, detail: snippet };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        elapsed_ms: Date.now() - startedAt,
        model,
        detail: describeError(error).slice(0, DETAIL_LIMIT),
      };
    }
  }
}
