import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { badRequest, domainError } from '../../i18n/domain-error';
import {
  createServer,
  IncomingHttpHeaders,
  IncomingMessage,
  request as httpRequest,
  Server,
  ServerResponse,
} from 'http';
import { request as httpsRequest } from 'https';
import { chmod, chown, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import { DeepseekHarnessProviderConfig } from '../../config/deepseek-harness-config';
import { HarnessRuntimeContext, HarnessRuntimeManagerService } from './harness-runtime-manager.service';
import { ModelProviderRegistryService } from './model-provider/model-provider-registry.service';
import { PageBridgeService } from './page-bridge.service';
import { WorkspacePathsService } from './workspace/workspace-paths.service';
import { assertHarnessDsl, pageSchema } from './analysis-tool-policy';
import { EVENT_CHART_CAPABILITY, SQL_CHART_CAPABILITY } from './chart-proposal';

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_INTERNAL_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_MODEL_RESPONSE_BYTES = 32 * 1024 * 1024;
const MODEL_TIMEOUT_MS = 10 * 60_000;
const INTERNAL_TIMEOUT_MS = 5 * 60_000;
const MODEL_REQUESTS_PER_MINUTE = 60;
const MODEL_CONCURRENCY_PER_RUNTIME = 2;
const PROVIDER_ID = /^[a-z0-9_-]+$/;
const MODEL_PATHS = new Set(['/chat/completions', '/responses', '/messages']);
const RESOURCE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const CARD_TYPES = new Set(['event', 'funnel', 'retention', 'sql']);

@Injectable()
export class HarnessGatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HarnessGatewayService.name);
  private server?: Server;
  private socketPath?: string;
  private readonly modelRequestWindows = new Map<string, number[]>();
  private readonly activeModelRequests = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly paths: WorkspacePathsService,
    private readonly runtimes: HarnessRuntimeManagerService,
    private readonly pageBridge: PageBridgeService,
    private readonly providers: ModelProviderRegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.paths.harnessConfig().enabled) return;
    try {
      await this.start();
    } catch (error) {
      this.logger.error(
        `Harness 安全网关暂不可用，分析主服务继续启动: ${this.errorMessage(error)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    if (server) {
      const startedAt = Date.now();
      // `server.close()` 只停止接受新连接，会一直等已建立的连接自然结束——AI 面板的 SSE 流是长连接，
      // 于是关闭流程被拖过 supervisor 的 10s 宽限 → SIGKILL（2026-09-18 事故）。
      // 这里直接销毁存量连接：网关重启后由面板的续期/重连机制恢复。
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      this.logger.log(`Harness 安全网关已关闭（${Date.now() - startedAt}ms）`);
    }
    if (this.socketPath) await unlink(this.socketPath).catch(() => undefined);
  }

  private async start(): Promise<void> {
    const root = await this.paths.root();
    const systemUser = await this.paths.systemUser();
    const directory = join(root, 'gateway', 'runtime');
    const socketPath = join(directory, 'server.sock');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await unlink(socketPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    const server = createServer((request, response) => {
      void this.route(request, response).catch((error) => this.sendError(response, error));
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolvePromise();
      });
    });
    await chmod(socketPath, 0o660);
    if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
      await chown(socketPath, systemUser.uid, systemUser.gid);
    }
    this.server = server;
    this.socketPath = socketPath;
    this.logger.log(`Harness 安全网关已监听 Unix Socket (${socketPath})`);
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const runtime = await this.authorize(request);
    const url = new URL(request.url ?? '/', 'http://clklog-gateway');
    if (url.pathname.startsWith('/model/')) {
      await this.proxyModel(request, response, runtime, url.pathname);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/tools/page/read') {
      this.sendJson(response, 200, this.pageBridge.read(this.identity(runtime)));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/tools/page/propose-sql') {
      const body = await this.readJson(request);
      const result = await this.pageBridge.propose(this.identity(runtime), 'sql_edit', {
        sql: this.stringField(body.sql),
        expected_revision: Number(body.expected_revision),
        reason: this.stringField(body.reason),
      });
      this.sendJson(response, 200, result);
      return;
    }
    if (
      request.method === 'POST' &&
      url.pathname === '/tools/page/request-sql-execution'
    ) {
      const body = await this.readJson(request);
      const result = await this.pageBridge.propose(this.identity(runtime), 'sql_execute', {
        sql: this.stringField(body.sql),
        expected_revision: Number(body.expected_revision),
        reason: this.stringField(body.reason),
      });
      this.sendJson(response, 200, result);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/tools/report/schema') {
      const schema = await this.internalApi(runtime, 'GET', '/sa/api/report/schema') as Record<string, unknown>;
      const event = url.searchParams.get('event_key');
      if (event) {
        if (!Array.isArray(schema.events) || !schema.events.some((item) => item.event_key === event)) {
          throw domainError(HttpStatus.NOT_FOUND, {
            code: 'ai.gateway.schemaEventUnavailable',
            messageKey: 'ai:error.gateway.schemaEventUnavailable',
            message: 'schema_event_unavailable',
          });
        }
        const props = await this.internalApi(runtime, 'GET', `/sa/api/meta/events/${encodeURIComponent(event)}/properties`);
        const allowed = new Set((schema.event_properties as { prop_key: string }[]).map((p) => p.prop_key));
        schema.event_properties = Array.isArray(props) ? props.filter((p) => allowed.has(p.prop_key)).map((p) => ({
          event_key: event, prop_key: p.prop_key, data_type: p.data_type, display_name: p.display_name,
        })) : [];
        schema.events = (schema.events as { event_key: string }[]).filter((item) => item.event_key === event);
      }
      this.sendJson(response, 200, pageSchema(schema, url.searchParams.get('keyword') ?? '', Number(url.searchParams.get('page') ?? 1)));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/tools/query/capabilities') {
      const capabilities = await this.internalApi(runtime, 'GET', '/sa/api/query/capabilities') as object;
      this.sendJson(response, 200, { ...capabilities, pages: ['event', 'funnel', 'retention', 'sql'],
        unavailable: ['user scope 属性关联查询'],
        sql_chart: SQL_CHART_CAPABILITY,
        event_chart: EVENT_CHART_CAPABILITY,
        workflow: '先读页面和字典，查询与填表分离；SQL 任意查询需绑定 SQL 页；字段名称/币种/金额属性必须核验。'
          + 'SQL 自动推荐失败时用 clklog_propose_sql_chart 填字段设置；事件分析用 clklog_propose_event_chart 提图表配置，用户确认后才生效。' });
      return;
    }
    const analysis = url.pathname.match(/^\/tools\/query\/(event|funnel|retention)$/);
    if (request.method === 'POST' && analysis) {
      const body = { ...await this.readJson(request), project: runtime.project };
      assertHarnessDsl(body);
      this.sendJson(response, 200, await this.internalApi(runtime, 'POST', `/sa/api/query/${analysis[1]}`, body));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/tools/page/propose-analysis') {
      const body = await this.readJson(request);
      assertHarnessDsl(body.dsl);
      const dsl = await this.internalApi(runtime, 'POST', '/sa/api/query/validate', body) as Record<string, unknown>;
      this.sendJson(response, 200, await this.pageBridge.propose(this.identity(runtime), 'analysis_edit', {
        page: this.stringField(body.page), dsl, sql: '',
        expected_revision: Number(body.expected_revision), reason: this.stringField(body.reason),
      }));
      return;
    }
    if (
      request.method === 'POST'
      && (url.pathname === '/tools/page/propose-sql-chart' || url.pathname === '/tools/page/propose-event-chart')
    ) {
      const body = await this.readJson(request);
      const chart = body.chart ?? body.chart_config;
      if (!chart || typeof chart !== 'object' || Array.isArray(chart)) {
        throw badRequest({
          code: 'ai.gateway.chartNotObject',
          messageKey: 'ai:error.gateway.chartNotObject',
          message: 'chart 必须是对象',
        });
      }
      this.sendJson(response, 200, await this.pageBridge.propose(this.identity(runtime), 'analysis_chart_edit', {
        sql: '',
        chart_config: chart as Record<string, unknown>,
        expected_revision: Number(body.expected_revision),
        reason: this.stringField(body.reason),
      }));
      return;
    }
    if (await this.routeCatalogTools(request, response, runtime, url)) return;
    this.sendJson(response, 404, { message: 'gateway_path_not_allowed' });
  }

  private authorize(request: IncomingMessage): Promise<HarnessRuntimeContext> {
    const authorization = request.headers.authorization;
    const prefix = 'Bearer ';
    if (!authorization?.startsWith(prefix)) {
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'ai.gateway.runtimeCapabilityRequired',
        messageKey: 'ai:error.gateway.runtimeCapabilityRequired',
        message: 'runtime_capability_required',
      });
    }
    const runtimeHeader = request.headers['x-clklog-runtime-id'];
    if (typeof runtimeHeader !== 'string') {
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'ai.gateway.runtimeIdentityRequired',
        messageKey: 'ai:error.gateway.runtimeIdentityRequired',
        message: 'runtime_identity_required',
      });
    }
    return this.runtimes.authorizeCapability(
      authorization.slice(prefix.length).trim(),
      runtimeHeader,
    );
  }

  private identity(runtime: HarnessRuntimeContext) {
    return {
      user_id: runtime.userId,
      project_name: runtime.project,
      tab_id: runtime.tabId,
    };
  }

  /** 看板/卡片目录与 SQL 卡静默执行、SQL 页切卡 */
  private async routeCatalogTools(
    request: IncomingMessage,
    response: ServerResponse,
    runtime: HarnessRuntimeContext,
    url: URL,
  ): Promise<boolean> {
    if (request.method === 'GET' && url.pathname === '/tools/catalog/dashboards') {
      this.sendJson(response, 200, await this.internalApi(runtime, 'GET', '/sa/api/report/dashboards'));
      return true;
    }
    const dashboardMatch = url.pathname.match(/^\/tools\/catalog\/dashboards\/([^/]+)$/);
    if (request.method === 'GET' && dashboardMatch) {
      const dbId = decodeURIComponent(dashboardMatch[1]);
      if (!RESOURCE_ID.test(dbId)) {
        throw badRequest({
          code: 'ai.gateway.dashboardIdInvalid',
          messageKey: 'ai:error.gateway.dashboardIdInvalid',
          message: 'dashboard_id_invalid',
        });
      }
      this.sendJson(
        response,
        200,
        await this.internalApi(runtime, 'GET', `/sa/api/report/dashboards/${encodeURIComponent(dbId)}`),
      );
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/tools/catalog/cards') {
      const type = url.searchParams.get('type');
      const qs = type && CARD_TYPES.has(type) ? `?type=${encodeURIComponent(type)}` : '';
      this.sendJson(response, 200, await this.internalApi(runtime, 'GET', `/sa/api/report/cards${qs}`));
      return true;
    }
    const cardMatch = url.pathname.match(/^\/tools\/catalog\/cards\/([^/]+)$/);
    if (request.method === 'GET' && cardMatch) {
      const cardId = decodeURIComponent(cardMatch[1]);
      if (!RESOURCE_ID.test(cardId)) {
        throw badRequest({
          code: 'ai.gateway.cardIdInvalid',
          messageKey: 'ai:error.gateway.cardIdInvalid',
          message: 'card_id_invalid',
        });
      }
      this.sendJson(
        response,
        200,
        await this.internalApi(runtime, 'GET', `/sa/api/report/cards/${encodeURIComponent(cardId)}`),
      );
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/tools/catalog/cards/execute') {
      const body = await this.readJson(request);
      const cardId = this.stringField(body.card_id).trim();
      if (!RESOURCE_ID.test(cardId)) {
        throw badRequest({
          code: 'ai.gateway.cardIdInvalid',
          messageKey: 'ai:error.gateway.cardIdInvalid',
          message: 'card_id_invalid',
        });
      }
      const payload: Record<string, unknown> = {};
      if (body.time_range && typeof body.time_range === 'object' && !Array.isArray(body.time_range)) {
        payload.time_range = body.time_range;
      }
      if (typeof body.limit === 'number') payload.limit = body.limit;
      this.sendJson(
        response,
        200,
        await this.internalApi(
          runtime,
          'POST',
          `/sa/api/report/cards/${encodeURIComponent(cardId)}/execute`,
          payload,
        ),
      );
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/tools/page/load-sql-card') {
      const body = await this.readJson(request);
      const cardId = this.stringField(body.card_id).trim();
      if (!RESOURCE_ID.test(cardId)) {
        throw badRequest({
          code: 'ai.gateway.cardIdInvalid',
          messageKey: 'ai:error.gateway.cardIdInvalid',
          message: 'card_id_invalid',
        });
      }
      const card = (await this.internalApi(
        runtime,
        'GET',
        `/sa/api/report/cards/${encodeURIComponent(cardId)}`,
      )) as Record<string, unknown>;
      if (card.type !== 'sql') {
        throw badRequest({
          code: 'ai.gateway.sqlCardOnly',
          messageKey: 'ai:error.gateway.sqlCardOnly',
          message: '仅 sql 卡片可加载到编辑器',
        });
      }
      const dsl =
        card.dsl && typeof card.dsl === 'object' && !Array.isArray(card.dsl)
          ? (card.dsl as Record<string, unknown>)
          : {};
      const sql = String(dsl.sql_text ?? dsl.sql ?? '').trim();
      if (!sql) {
        throw badRequest({
          code: 'ai.gateway.cardSqlMissing',
          messageKey: 'ai:error.gateway.cardSqlMissing',
          message: '卡片未保存 SQL',
        });
      }
      const snapshot = this.pageBridge.read(this.identity(runtime));
      const expected =
        Number.isSafeInteger(Number(body.expected_revision)) && Number(body.expected_revision) >= 0
          ? Number(body.expected_revision)
          : snapshot.revision;
      const result = await this.pageBridge.propose(this.identity(runtime), 'sql_load_card', {
        sql,
        expected_revision: expected,
        reason: this.stringField(body.reason) || '切换 SQL 卡片',
        card_id: cardId,
        card_name: typeof card.name === 'string' ? card.name : cardId,
      });
      this.sendJson(response, 200, result);
      return true;
    }
    return false;
  }

  private async proxyModel(
    request: IncomingMessage,
    response: ServerResponse,
    runtime: HarnessRuntimeContext,
    pathname: string,
  ): Promise<void> {
    if (request.method !== 'POST') {
      throw domainError(HttpStatus.METHOD_NOT_ALLOWED, {
        code: 'ai.gateway.modelMethodNotAllowed',
        messageKey: 'ai:error.gateway.modelMethodNotAllowed',
        message: 'model_method_not_allowed',
      });
    }
    const match = pathname.match(/^\/model\/([a-z0-9_-]+)(\/.*)$/);
    if (!match || !PROVIDER_ID.test(match[1]) || !MODEL_PATHS.has(match[2])) {
      throw domainError(HttpStatus.NOT_FOUND, {
        code: 'ai.gateway.modelPathNotAllowed',
        messageKey: 'ai:error.gateway.modelPathNotAllowed',
        message: 'model_path_not_allowed',
      });
    }
    const providerId = match[1];
    const provider = this.providers.provider(providerId);
    if (!provider?.resolved_api_key) {
      throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
        code: 'ai.gateway.providerNotConfigured',
        messageKey: 'ai:error.gateway.providerNotConfigured',
        message: 'provider_not_configured',
      });
    }
    const body = await this.readJson(request);
    this.validateModelRequest(provider, body, match[2]);
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const release = this.acquireModelPermit(runtime.runtimeId);
    const startedAt = Date.now();
    let upstreamStatus = 502;
    let responseBytes = 0;
    const base = new URL(provider.base_url);
    const targetPath = `${base.pathname.replace(/\/$/, '')}${match[2]}${base.search}`;
    const headers: Record<string, string> = {
      accept: request.headers.accept ?? 'application/json',
      'content-type': 'application/json',
      'content-length': String(payload.byteLength),
      authorization: `Bearer ${provider.resolved_api_key}`,
      'user-agent': 'clklog-harness-gateway/1.0',
    };
    if (provider.protocol === 'anthropic-messages') {
      headers['x-api-key'] = provider.resolved_api_key;
      headers['anthropic-version'] =
        typeof request.headers['anthropic-version'] === 'string'
          ? request.headers['anthropic-version']
          : '2023-06-01';
      if (typeof request.headers['anthropic-beta'] === 'string') {
        headers['anthropic-beta'] = request.headers['anthropic-beta'];
      }
    }
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const transport = base.protocol === 'https:' ? httpsRequest : httpRequest;
        const upstream = transport(
          {
            protocol: base.protocol,
            hostname: base.hostname,
            port: base.port || undefined,
            method: 'POST',
            path: targetPath,
            headers,
            timeout: MODEL_TIMEOUT_MS,
          },
          (upstreamResponse) => {
            upstreamStatus = upstreamResponse.statusCode ?? 502;
            const forwarded = this.responseHeaders(upstreamResponse.headers);
            response.writeHead(upstreamStatus, forwarded);
            upstreamResponse.on('data', (chunk: Buffer) => {
              responseBytes += chunk.byteLength;
              if (responseBytes > MAX_MODEL_RESPONSE_BYTES) {
                upstreamResponse.destroy(new Error('model_response_too_large'));
              }
            });
            upstreamResponse.pipe(response);
            upstreamResponse.once('end', resolvePromise);
            upstreamResponse.once('error', reject);
          },
        );
        upstream.once('timeout', () => upstream.destroy(new Error('model_timeout')));
        const deadline = setTimeout(() => upstream.destroy(new Error('model_deadline_exceeded')), MODEL_TIMEOUT_MS);
        deadline.unref();
        const disconnected = () => { if (!response.writableEnded) upstream.destroy(new Error('model_client_disconnected')); };
        response.once('close', disconnected);
        upstream.once('close', () => {
          clearTimeout(deadline);
          response.off('close', disconnected);
        });
        upstream.once('error', reject);
        upstream.end(payload);
      });
      this.auditModelCall(runtime, providerId, String(body.model), {
        status: upstreamStatus,
        elapsedMs: Date.now() - startedAt,
        requestBytes: payload.byteLength,
        responseBytes,
      });
    } catch (error) {
      this.auditModelCall(runtime, providerId, String(body.model), {
        status: upstreamStatus,
        elapsedMs: Date.now() - startedAt,
        requestBytes: payload.byteLength,
        responseBytes,
        error: error instanceof Error ? error.message : 'model_gateway_failed',
      });
      throw error;
    } finally {
      release();
    }
  }

  private acquireModelPermit(runtimeId: string): () => void {
    const now = Date.now();
    const recent = (this.modelRequestWindows.get(runtimeId) ?? [])
      .filter((timestamp) => now - timestamp < 60_000);
    const active = this.activeModelRequests.get(runtimeId) ?? 0;
    if (recent.length >= MODEL_REQUESTS_PER_MINUTE) {
      throw domainError(HttpStatus.TOO_MANY_REQUESTS, {
        code: 'ai.gateway.modelRateLimitExceeded',
        messageKey: 'ai:error.gateway.modelRateLimitExceeded',
        message: 'model_rate_limit_exceeded',
      });
    }
    if (active >= MODEL_CONCURRENCY_PER_RUNTIME) {
      throw domainError(HttpStatus.TOO_MANY_REQUESTS, {
        code: 'ai.gateway.modelConcurrencyLimitExceeded',
        messageKey: 'ai:error.gateway.modelConcurrencyLimitExceeded',
        message: 'model_concurrency_limit_exceeded',
      });
    }
    recent.push(now);
    this.modelRequestWindows.set(runtimeId, recent);
    this.activeModelRequests.set(runtimeId, active + 1);
    return () => {
      const current = this.activeModelRequests.get(runtimeId) ?? 1;
      if (current <= 1) this.activeModelRequests.delete(runtimeId);
      else this.activeModelRequests.set(runtimeId, current - 1);
    };
  }

  private auditModelCall(
    runtime: HarnessRuntimeContext,
    provider: string,
    model: string,
    result: {
      status: number;
      elapsedMs: number;
      requestBytes: number;
      responseBytes: number;
      error?: string;
    },
  ): void {
    this.logger.log(JSON.stringify({
      event: 'harness_model_call',
      runtime_id: runtime.runtimeId,
      user_id: runtime.userId,
      project_name: runtime.project,
      provider,
      model,
      status: result.status,
      elapsed_ms: result.elapsedMs,
      request_bytes: result.requestBytes,
      response_bytes: result.responseBytes,
      ...(result.error ? { error_code: result.error.slice(0, 120) } : {}),
    }));
  }

  private validateModelRequest(
    provider: DeepseekHarnessProviderConfig,
    body: Record<string, unknown>,
    endpoint: string,
  ): void {
    const modelId = typeof body.model === 'string' ? body.model : '';
    const model = provider.models.find((candidate) => candidate.id === modelId);
    if (!model) {
      throw badRequest({
        code: 'ai.gateway.modelNotAllowed',
        messageKey: 'ai:error.gateway.modelNotAllowed',
        message: 'model_not_allowed',
      });
    }
    const maxTokens = this.paths.harnessConfig().runtime.max_tokens;
    for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens'] as const) {
      if (body[key] === undefined) continue;
      const value = Number(body[key]);
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw badRequest({
          code: 'ai.gateway.invalidMaxTokens',
          messageKey: 'ai:error.gateway.invalidMaxTokens',
          message: 'invalid_max_tokens',
        });
      }
      body[key] = Math.min(value, maxTokens);
    }
    if (
      endpoint === '/chat/completions'
      && body.max_tokens === undefined
      && body.max_completion_tokens === undefined
    ) {
      body.max_tokens = maxTokens;
    }
    if (endpoint === '/responses' && body.max_output_tokens === undefined) {
      body.max_output_tokens = maxTokens;
    }
    if (typeof body.reasoning_effort === 'string') {
      if (!model.reasoning_efforts.includes(body.reasoning_effort)) {
        throw badRequest({
          code: 'ai.gateway.reasoningEffortNotAllowed',
          messageKey: 'ai:error.gateway.reasoningEffortNotAllowed',
          message: 'reasoning_effort_not_allowed',
        });
      }
    }
    this.normalizeMessageRoles(body);
  }

  /** Official DSH emits OpenAI `developer`; DeepSeek-compatible APIs only accept system/user/assistant/tool. */
  private normalizeMessageRoles(body: Record<string, unknown>): void {
    for (const key of ['messages', 'input'] as const) {
      const value = body[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const row = item as Record<string, unknown>;
        if (row.role === 'developer') row.role = 'system';
      }
    }
  }

  private internalApi(
    runtime: HarnessRuntimeContext,
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const port = this.config.get<number>('server.port');
    return new Promise((resolvePromise, reject) => {
      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          timeout: INTERNAL_TIMEOUT_MS,
          headers: {
            authorization: `Bearer ${runtime.userToken}`,
            'x-project-name': runtime.project,
            accept: 'application/json',
            ...(payload
              ? {
                  'content-type': 'application/json',
                  'content-length': String(payload.byteLength),
                }
              : {}),
          },
        },
        async (response) => {
          try {
            const raw = await this.readResponse(response);
            const envelope = JSON.parse(raw || '{}') as {
              code?: number;
              message?: string;
              data?: unknown;
            };
            if ((response.statusCode ?? 500) >= 400 || envelope.code !== 0) {
              reject(
                new HttpException(
                  typeof envelope.message === 'string' ? envelope.message : 'internal_tool_failed',
                  response.statusCode ?? 502,
                ),
              );
              return;
            }
            resolvePromise(envelope.data);
          } catch (error) {
            reject(error);
          }
        },
      );
      upstream.once('timeout', () => upstream.destroy(new Error('internal_tool_timeout')));
      upstream.once('error', reject);
      upstream.end(payload);
    });
  }

  private async readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const declared = Number(request.headers['content-length'] ?? 0);
    if (!Number.isFinite(declared) || declared > MAX_REQUEST_BYTES) {
      throw domainError(HttpStatus.PAYLOAD_TOO_LARGE, {
        code: 'ai.gateway.requestTooLarge',
        messageKey: 'ai:error.gateway.requestTooLarge',
        message: 'request_too_large',
      });
    }
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.byteLength;
      if (received > MAX_REQUEST_BYTES) {
        throw domainError(HttpStatus.PAYLOAD_TOO_LARGE, {
          code: 'ai.gateway.requestTooLarge',
          messageKey: 'ai:error.gateway.requestTooLarge',
          message: 'request_too_large',
        });
      }
      chunks.push(buffer);
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw badRequest({
        code: 'ai.gateway.invalidJson',
        messageKey: 'ai:error.gateway.invalidJson',
        message: 'invalid_json',
      });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw badRequest({
        code: 'ai.gateway.invalidJsonObject',
        messageKey: 'ai:error.gateway.invalidJsonObject',
        message: 'invalid_json_object',
      });
    }
    return value as Record<string, unknown>;
  }

  private async readResponse(response: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.byteLength;
      if (received > MAX_INTERNAL_RESPONSE_BYTES) {
        throw domainError(HttpStatus.BAD_GATEWAY, {
          code: 'ai.gateway.toolResponseTooLarge',
          messageKey: 'ai:error.gateway.toolResponseTooLarge',
          message: 'tool_response_too_large',
        });
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private responseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (
        value === undefined ||
        ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'set-cookie', 'transfer-encoding', 'upgrade'].includes(name)
      ) {
        continue;
      }
      result[name] = value;
    }
    result['cache-control'] = 'no-store';
    return result;
  }

  private stringField(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  private sendJson(response: ServerResponse, status: number, payload: unknown): void {
    if (response.headersSent) return;
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(`${JSON.stringify(payload)}\n`);
  }

  private sendError(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = error instanceof HttpException ? error.getStatus() : 502;
    const message = error instanceof HttpException
      ? this.exceptionMessage(error)
      : 'harness_gateway_failed';
    this.sendJson(response, status, { message });
  }

  private exceptionMessage(error: HttpException): string {
    const response = error.getResponse();
    if (typeof response === 'string') return response.slice(0, 300);
    const message = (response as { message?: unknown }).message;
    return typeof message === 'string' ? message.slice(0, 300) : 'harness_gateway_failed';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown';
  }
}
