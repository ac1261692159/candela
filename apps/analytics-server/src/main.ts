import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import type { Express } from 'express';
import { AppModule } from './app.module';
import { appConfig, backgroundWorkerSummary } from './config/configuration';
import { HarnessWebProxyService } from './modules/ai-assistant/harness-web-proxy.service';

/** 收到信号后给在途请求的宽限：之后强制断开全部连接（supervisor 宽限 10s，这里不超 2s） */
const CONNECTION_DRAIN_GRACE_MS = 2_000;

async function bootstrap() {
  // 关闭默认 body 解析：数据表上传要承载整表 CSV/Excel 文本（解析器自身上限 10MB，
  // JSON 转义后还会膨胀），只对该路径放宽；其余接口保持 1MB，不把大 body 面暴露给所有接口。
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // CORS 头必须先于 Harness 代理注册：面板 iframe 是 sandbox 无 allow-same-origin 的 opaque origin，
  // 对它来说**所有**请求都是跨域，模块脚本（crossorigin）与 fetch 都要 Access-Control-Allow-Origin
  // 才放行；CORS 中间件只写响应头、不读请求体，因此不影响下面「代理要在 body 解析之前」的约束。
  app.enableCors({
    origin: appConfig.server.cors.origin,
    credentials: true,
  });

  // Harness 反向代理必须注册在**所有** body 解析之前：它自己读取原始流再转发给 Runtime，
  // 若让 json() 先跑，`application/json` 的请求体（引擎选择工作区/发消息用的 /api/session/create
  // 等 RPC）会被解析器吃掉，代理只能转发空 body，上游报 400 body is not JSON。
  // 见 test/ai-assistant/harness-proxy-order.spec.ts。
  const harnessProxy = app.get(HarnessWebProxyService);
  app.use('/sa/harness', harnessProxy.handle.bind(harnessProxy));

  app.use('/sa/api/meta/datatables', json({ limit: '32mb' }));
  // 分群 ID 名单走 JSON 体（`csv_text`）：单次最多 100 万行 ID ≈ 24MB，
  // 全局 1MB 会让几万行就 413（后端本来允许 100 万行，两边对不上）。
  app.use('/sa/api/meta/cohorts', json({ limit: '32mb' }));
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  // 根路径重定向到平台入口（前端 base=/sa/）：由应用自身响应，**不依赖宿主 nginx 的分流配置**——
  // 直连后端端口（:3100 / 容器内 3100）或 web 层不可达时，访问根路径仍能到正确入口。
  // 必须用 Express 实例的精确 `get('/')` 而不是 `app.use('/')`：后者前缀匹配所有路径，
  // 会把 /sa/api/* 与 /sa/harness 一起拦掉。
  const httpInstance = app.getHttpAdapter().getInstance() as Express;
  httpInstance.get('/', (_request, response) => {
    response.redirect(302, '/sa/');
  });

  app.enableShutdownHooks();

  const port = appConfig.server.port;
  await app.listen(port, '0.0.0.0');
  app.getHttpServer().on('upgrade', harnessProxy.handleUpgrade.bind(harnessProxy));

  // 关闭时主动排空存量连接（2026-09-18 事故，2026-09-20 复现验证）：
  // Node 的 server.close() 会等**所有**已建立连接结束——浏览器的 keep-alive、AI 面板经
  // /sa/harness 的 SSE 长连接都会把关闭拖过 supervisor 的 10s 宽限而被 SIGKILL，
  // 正在跑的 AI 会话随之被掐断（UI 报 `Bash · Error: tool call aborted`）。
  // 收到信号先断开空闲连接，短暂宽限后全断；实测无此步时持有 2 条空闲连接即 11s 被 SIGKILL。
  const drainConnections = () => {
    const server = app.getHttpServer() as {
      closeIdleConnections?: () => void;
      closeAllConnections?: () => void;
    };
    server.closeIdleConnections?.();
    setTimeout(() => server.closeAllConnections?.(), CONNECTION_DRAIN_GRACE_MS).unref?.();
  };
  process.once('SIGTERM', drainConnections);
  process.once('SIGINT', drainConnections);

  console.log(`Candela Analytics Server 运行在 http://0.0.0.0:${port}`);
  console.log(backgroundWorkerSummary());
}

bootstrap();
