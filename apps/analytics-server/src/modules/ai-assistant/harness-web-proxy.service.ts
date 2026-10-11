import { Injectable, Logger } from '@nestjs/common';
import { notFound } from '../../i18n/domain-error';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { IncomingMessage, request as httpRequest, ServerResponse } from 'http';
import { createConnection, Socket } from 'net';
import type { NextFunction, Request, Response } from 'express';
import { HarnessRuntimeContext, HarnessRuntimeManagerService } from './harness-runtime-manager.service';

const MAX_REWRITE_BYTES = 32 * 1024 * 1024;
const UPSTREAM_CONNECT_TIMEOUT_MS = 45_000;
const UPSTREAM_HTTP_TIMEOUT_MS = 5 * 60_000;
const RUNTIME_ID = /^air_[a-zA-Z0-9_-]{20,}$/;
const ACCESS_TOKEN = /^(\d{13})\.([A-Za-z0-9_-]{32,})$/;
const ACCESS_IN_PATH = /\/\d{13}\.[A-Za-z0-9_-]{32,}/g;
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function redactHarnessPath(path: string): string {
  return path.replace(ACCESS_IN_PATH, '/<access>');
}

export function isDeadHarnessSocket(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ECONNREFUSED') return true;
  const message = error instanceof Error ? error.message : '';
  return /connect (ENOENT|ECONNREFUSED) .*runtime\.sock/.test(message);
}

function isClientAbort(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ABORT_ERR') return true;
  const message = error instanceof Error ? error.message : '';
  return message === 'aborted' || message === 'request aborted';
}

@Injectable()
export class HarnessWebProxyService {
  private readonly logger = new Logger(HarnessWebProxyService.name);
  private readonly signingKey = randomBytes(32);

  constructor(private readonly runtimes: HarnessRuntimeManagerService) {}

  async renewConnection(userId: string, project: string, tabId: string, runtimeId: string) {
    if (!RUNTIME_ID.test(runtimeId ?? '')) {
      throw notFound({
        code: 'ai.proxy.connectionMissing',
        messageKey: 'ai:error.proxy.connectionMissing',
        message: 'harness_connection_missing',
      });
    }
    const runtime = await this.runtimes.getAuthorizedRuntime(runtimeId);
    if (runtime.userId !== userId || runtime.project !== project || runtime.tabId !== tabId) {
      throw notFound({
        code: 'ai.proxy.connectionMissing',
        messageKey: 'ai:error.proxy.connectionMissing',
        message: 'harness_connection_missing',
      });
    }
    await this.runtimes.authorizeCapability(runtime.capability, runtimeId);
    const expires = Date.now() + 24 * 60 * 60_000;
    return { prefix: this.externalPrefix(runtimeId, this.signedAccess(runtimeId, expires)), expires_at: expires };
  }

  handle(request: Request, response: Response, _next: NextFunction): void {
    void this.route(request, response).catch((error) => {
      const aborted = isClientAbort(error) || request.aborted || request.destroyed;
      const status = aborted
        ? 499
        : typeof (error as { getStatus?: () => number }).getStatus === 'function'
          ? (error as { getStatus: () => number }).getStatus()
          : isDeadHarnessSocket(error)
            ? 401
            : 502;
      const path = redactHarnessPath((request.url ?? '/').split('?')[0] ?? '/');
      const log = aborted ? this.logger.warn.bind(this.logger) : this.logger.error.bind(this.logger);
      log(
        `Harness 代理失败 ${request.method} ${path}: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
      if (response.headersSent || aborted) {
        if (!response.writableEnded) response.destroy();
        return;
      }
      response
        .status(status === 499 ? 400 : status)
        .set('cache-control', 'no-store')
        .send(status === 401 ? 'Harness 会话无效，请刷新页面' : 'Harness 暂不可用');
    });
  }

  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    void this.upgrade(request, socket, head).catch(() => {
      if (!socket.destroyed) this.rejectUpgrade(socket, 401);
    });
  }

  private async upgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const parsed = this.parseExternalPath(request.url ?? '/');
    if (!parsed || !this.validAccess(parsed.runtimeId, parsed.access)) {
      this.rejectUpgrade(socket, 401);
      return;
    }
    let runtime = await this.runtimes.getAuthorizedRuntime(parsed.runtimeId);
    try {
      await this.proxyUpgrade(request, socket, head, runtime, parsed.upstreamPath);
    } catch (error) {
      if (!isDeadHarnessSocket(error) || socket.destroyed) throw error;
      runtime = await this.runtimes.reviveRuntime(parsed.runtimeId);
      await this.initializeUpstream(runtime);
      await this.proxyUpgrade(request, socket, head, runtime, parsed.upstreamPath);
    }
  }

  private proxyUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
    runtime: HarnessRuntimeContext,
    upstreamPath: string,
  ): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const upstream = createConnection({ path: runtime.socketPath });
      upstream.once('error', reject);
      socket.once('error', () => upstream.destroy());
      upstream.once('connect', () => {
        const headers = this.upstreamHeaders(request, runtime);
        headers.connection = 'Upgrade';
        headers.upgrade = request.headers.upgrade ?? 'websocket';
        const lines = [`${request.method ?? 'GET'} ${upstreamPath} HTTP/1.1`];
        for (const [name, value] of Object.entries(headers)) {
          if (value === undefined) continue;
          lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
        let lastTouch = Date.now();
        const touch = () => {
          if (Date.now() - lastTouch < 60_000) return;
          lastTouch = Date.now();
          void this.runtimes.getAuthorizedRuntime(runtime.runtimeId).catch(() => socket.destroy());
        };
        socket.on('data', touch);
        upstream.on('data', touch);
        socket.pipe(upstream).pipe(socket);
        socket.once('close', () => resolvePromise());
        upstream.once('close', () => resolvePromise());
      });
    });
  }

  private async route(request: Request, response: Response): Promise<void> {
    const url = new URL(request.url, 'http://clklog-harness');
    if (url.pathname === '/bootstrap') {
      await this.bootstrap(url, response);
      return;
    }
    const parsed = this.parseMountedPath(request.url);
    if (!parsed || !this.validAccess(parsed.runtimeId, parsed.access)) {
      response.status(401).set('cache-control', 'no-store').send('Harness 会话无效，请刷新页面');
      return;
    }
    const body = await this.readIncomingBody(request);
    let runtime = await this.runtimes.getAuthorizedRuntime(parsed.runtimeId);
    try {
      await this.proxyHttp(request, response, runtime, parsed.upstreamPath, parsed.access, body);
    } catch (error) {
      if (!isDeadHarnessSocket(error) || response.headersSent) throw error;
      runtime = await this.runtimes.reviveRuntime(parsed.runtimeId);
      await this.initializeUpstream(runtime);
      await this.proxyHttp(request, response, runtime, parsed.upstreamPath, parsed.access, body);
    }
  }

  private async bootstrap(url: URL, response: Response): Promise<void> {
    const ticket = url.searchParams.get('ticket') ?? '';
    const runtime = await this.runtimes.consumeHostTicket(ticket);
    await this.initializeUpstream(runtime);
    const expires = Date.now() + 24 * 60 * 60_000;
    const access = this.signedAccess(runtime.runtimeId, expires);
    response.setHeader('referrer-policy', 'no-referrer');
    response.redirect(302, this.externalPrefix(runtime.runtimeId, access));
  }

  private readIncomingBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise<Buffer>((resolvePromise, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      const onData = (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > MAX_REWRITE_BYTES) {
          request.off('data', onData);
          reject(new Error('harness_request_too_large'));
          request.destroy();
        } else {
          chunks.push(chunk);
        }
      };
      request.on('data', onData);
      request.once('end', () => resolvePromise(Buffer.concat(chunks)));
      request.once('error', reject);
      if (request.readableEnded) resolvePromise(Buffer.concat(chunks));
    });
  }

  private proxyHttp(
    request: Request,
    response: Response,
    runtime: HarnessRuntimeContext,
    upstreamPath: string,
    access: string,
    body: Buffer,
  ): Promise<void> {
    const target = new URL(upstreamPath, 'http://harness-runtime');
    const events =
      target.pathname === '/plugins/events' || target.pathname.startsWith('/plugins/events/');
    const headers = this.upstreamHeaders(request, runtime);
    const method = (request.method ?? 'GET').toUpperCase();
    if (body.byteLength > 0 || (method !== 'GET' && method !== 'HEAD')) {
      headers['content-length'] = String(body.byteLength);
    } else {
      delete headers['content-length'];
    }
    return new Promise<void>((resolvePromise, reject) => {
      const upstream = httpRequest(
        {
          socketPath: runtime.socketPath,
          method: request.method,
          path: `${target.pathname}${target.search}`,
          headers,
          timeout: events ? 0 : UPSTREAM_HTTP_TIMEOUT_MS,
        },
        (upstreamResponse) => {
          const contentType = String(upstreamResponse.headers['content-type'] ?? '');
          const rewrite = /(?:text\/html|javascript|text\/css)/i.test(contentType);
          const headers = this.downstreamHeaders(
            upstreamResponse.headers,
            runtime.runtimeId,
            access,
            rewrite,
            events,
          );
          if (!rewrite) {
            response.writeHead(upstreamResponse.statusCode ?? 502, headers);
            upstreamResponse.pipe(response);
            upstreamResponse.once('end', resolvePromise);
            upstreamResponse.once('error', reject);
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          upstreamResponse.on('data', (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > MAX_REWRITE_BYTES) {
              upstreamResponse.destroy(new Error('harness_asset_too_large'));
              return;
            }
            chunks.push(chunk);
          });
          upstreamResponse.once('error', reject);
          upstreamResponse.once('end', () => {
            const body = this.rewriteBody(
              Buffer.concat(chunks).toString('utf8'),
              runtime.runtimeId,
              access,
              contentType,
            );
            const payload = Buffer.from(body, 'utf8');
            headers['content-length'] = String(payload.byteLength);
            response.writeHead(upstreamResponse.statusCode ?? 502, headers);
            response.end(payload, resolvePromise);
          });
        },
      );
      if (!events) {
        upstream.once('timeout', () => upstream.destroy(new Error('harness_upstream_timeout')));
      }
      upstream.once('error', reject);
      upstream.end(body);
    });
  }

  private parseExternalPath(value: string): {
    runtimeId: string;
    access: string;
    upstreamPath: string;
  } | null {
    const url = new URL(value, 'http://clklog-harness');
    const match = url.pathname.match(
      /^\/sa\/harness\/(air_[a-zA-Z0-9_-]{20,})\/(\d{13}\.[A-Za-z0-9_-]{32,})(\/.*)?$/,
    );
    if (!match) return null;
    return this.parsed(match[1], match[2], match[3] ?? '/', url);
  }

  private parseMountedPath(value: string): {
    runtimeId: string;
    access: string;
    upstreamPath: string;
  } | null {
    const url = new URL(value, 'http://clklog-harness');
    const match = url.pathname.match(
      /^\/(air_[a-zA-Z0-9_-]{20,})\/(\d{13}\.[A-Za-z0-9_-]{32,})(\/.*)?$/,
    );
    if (!match) return null;
    return this.parsed(match[1], match[2], match[3] ?? '/', url);
  }

  private parsed(runtimeId: string, access: string, path: string, url: URL) {
    if (!RUNTIME_ID.test(runtimeId)) return null;
    return {
      runtimeId,
      access,
      upstreamPath: `${path}${url.search}`,
    };
  }

  private upstreamHeaders(
    request: Pick<IncomingMessage, 'headers'>,
    runtime: HarnessRuntimeContext,
  ): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (
        value === undefined
        || HOP_HEADERS.has(name)
        || ['authorization', 'cookie', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'].includes(name)
      ) continue;
      result[name] = value;
    }
    result.host = '127.0.0.1:39200';
    result['accept-encoding'] = 'identity';
    if (typeof result.origin === 'string') result.origin = 'http://127.0.0.1:39200';
    if (runtime.upstreamCookie) result.cookie = runtime.upstreamCookie;
    return result;
  }

  private downstreamHeaders(
    source: IncomingMessage['headers'],
    runtimeId: string,
    access: string,
    rewritten: boolean,
    events = false,
  ): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(source)) {
      if (value === undefined || HOP_HEADERS.has(name)) continue;
      if (rewritten && ['content-length', 'content-encoding', 'etag'].includes(name)) continue;
      if (name === 'set-cookie') {
        continue;
      } else if (name === 'location') {
        result[name] = this.rewriteLocation(String(value), runtimeId, access);
      } else {
        result[name] = value;
      }
    }
    result['cache-control'] = events
      ? 'no-cache, no-store, no-transform'
      : (source['cache-control'] ?? 'no-store');
    result['referrer-policy'] = 'no-referrer';
    result['x-content-type-options'] = 'nosniff';
    if (events) {
      delete result['content-length'];
      delete result['content-encoding'];
      result['x-accel-buffering'] = 'no';
      const contentType = String(result['content-type'] ?? '');
      if (!/text\/event-stream/i.test(contentType)) {
        result['content-type'] = 'text/event-stream';
      }
    }
    return result;
  }

  private rewriteBody(
    body: string,
    runtimeId: string,
    access: string,
    contentType = 'text/html',
  ): string {
    const prefix = this.externalPrefix(runtimeId, access).replace(/\/$/, '');
    let rewritten = body
      .replace(/<base\s+href=["']\/["']/gi, `<base href="${prefix}/"`)
      .replace(/(["'`])(\/plugins(?=[/"'`?]))/g, `$1${prefix}$2`)
      .replace(/(["'`])(\/api(?=[/?]))/g, `$1${prefix}$2`)
      .replace(/(href|src)=(['"])\/(?!\/|sa\/harness\/)/gi, `$1=$2${prefix}/`)
      .replace(
        /const INTERNAL_BASE = ["']http:\/\/dsh\.internal["'];/g,
        'const INTERNAL_BASE = new URL(globalThis.location.href).href;',
      );
    if (/javascript/i.test(contentType)) {
      rewritten = rewritten.replace(
        /(?<![\w.])localStorage\b/g,
        'globalThis.__clklogStorage',
      );
    }
    if (/text\/html/i.test(contentType)) {
      rewritten = rewritten.replace(/<head([^>]*)>/i, `<head$1>${this.browserShim(prefix)}`);
    }
    return rewritten;
  }

  /**
   * Keep DSH's `"/api"` RPC channel intact; prefix `/api` and `/plugins` on fetch/WebSocket/script src.
   *
   * 续期消息只按**发送方身份**（`e.source === parent`）+ 前缀正则校验：面板 iframe 是
   * `sandbox` 无 `allow-same-origin` 的 opaque origin（`location.origin === "null"`），
   * 与父页面 origin 永远不相等，按 origin 比对会把合法的续期全部丢掉——平台重启后旧签名失效时
   * 面板就再也接不上新前缀，只能手动刷新（2026-09-16 线上故障的第二个成因）。
   */
  private browserShim(prefix: string): string {
    return `<script>(function(P){globalThis.__clklogStorage=(()=>{const m=new Map();return{getItem:k=>m.has(String(k))?m.get(String(k)):null,setItem:(k,v)=>m.set(String(k),String(v)),removeItem:k=>m.delete(String(k)),clear:()=>m.clear(),key:i=>Array.from(m.keys())[i]??null,get length(){return m.size}}})();const R=P.split("/")[3];function notify(type){parent.postMessage({type,runtime_id:R},"*")}globalThis.addEventListener("message",e=>{if(e.source!==parent||e.data?.type!=="clklog:harness-renewed")return;const n=String(e.data.prefix||"");if(n.startsWith("/sa/harness/"+R+"/")&&/^\\/sa\\/harness\\/air_[a-zA-Z0-9_-]+\\/\\d{13}\\.[a-zA-Z0-9_-]+\\/$/.test(n))P=n.replace(/\\/$/,"")});notify("clklog:harness-ready");try{var dq=function(){return !!document.querySelector('[role="dialog"],[aria-modal="true"]')};var dl=dq();new MutationObserver(function(){var n=dq();if(n===dl)return;dl=n;parent.postMessage({type:"clklog:harness-dialog",runtime_id:R,open:n},"*")}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["role","aria-modal"]})}catch(e){}function rw(v){try{const u=new URL(String(v),globalThis.location.href);if(u.host!==globalThis.location.host)return v;let p=u.pathname;const root="/sa/harness/"+R+"/";if(p.startsWith(root)){const slash=p.indexOf("/",root.length);p=slash<0?"/":p.slice(slash)}if(p==="/api"||p.startsWith("/api/")||p==="/plugins"||p.startsWith("/plugins/")){u.pathname=P+p;return u.href}return v}catch(e){return v}}const F=globalThis.fetch.bind(globalThis);function send(i,n){return F(i,n).then(r=>{if(r.status===401)notify("clklog:harness-unauthorized");return r})}globalThis.fetch=function(i,n){if(typeof i==="string"||i instanceof URL)return send(rw(i),n);if(typeof Request!=="undefined"&&i instanceof Request){const u=rw(i.url);if(u!==i.url)return send(new Request(u,i),n)}return send(i,n)};const WS=globalThis.WebSocket;if(WS){function W(u,p){return p===undefined?new WS(rw(u)):new WS(rw(u),p)}W.prototype=WS.prototype;Object.setPrototypeOf(W,WS);W.CONNECTING=WS.CONNECTING;W.OPEN=WS.OPEN;W.CLOSING=WS.CLOSING;W.CLOSED=WS.CLOSED;globalThis.WebSocket=W}function hookSrc(proto){const d=Object.getOwnPropertyDescriptor(proto,"src");if(d&&d.set)Object.defineProperty(proto,"src",{configurable:true,enumerable:!!d.enumerable,get:d.get,set(v){d.set.call(this,rw(v))}})}if(typeof HTMLScriptElement!=="undefined")hookSrc(HTMLScriptElement.prototype);if(typeof HTMLLinkElement!=="undefined")hookSrc(HTMLLinkElement.prototype);const SA=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){return SA.call(this,n,(n==="src"||n==="href")?rw(v):v)};try{var _oe=globalThis.onerror;globalThis.onerror=function(m,s,l,c,e){try{if(String(m).indexOf("startTime")>=0||(e&&String(e.message||"").indexOf("startTime")>=0))return true}catch(x){}return _oe?_oe.call(this,m,s,l,c,e):false};var PO=globalThis.PerformanceObserver;if(typeof PO==="function"){function WPO(cb){return new PO(function(list,obs){try{function keep(xs){return(xs||[]).filter(function(en){return en&&typeof en.startTime==="number"})}cb({getEntries:function(){return keep(list.getEntries())},getEntriesByType:function(t){return keep(list.getEntriesByType(t))},getEntriesByName:function(n,t){return keep(list.getEntriesByName(n,t))}},obs)}catch(ex){}})}WPO.prototype=PO.prototype;if(PO.supportedEntryTypes)WPO.supportedEntryTypes=PO.supportedEntryTypes;globalThis.PerformanceObserver=WPO}if(typeof globalThis.EventSource==="function"){var NES=globalThis.EventSource;function CES(url,opt){var href=rw(url);if(String(href).indexOf("/plugins/events")<0)return new NES(href,opt);return clklogSSE(href,F)}CES.prototype=NES.prototype;Object.setPrototypeOf(CES,NES);CES.CONNECTING=0;CES.OPEN=1;CES.CLOSED=2;globalThis.EventSource=CES}function clklogSSE(href,fetchFn){var ls={};function emit(t,d){var ev={type:t,data:d};(ls[t]||[]).forEach(function(fn){try{fn(ev)}catch(e){}});var h=es["on"+t];if(h)try{h(ev)}catch(e){}}var ac=typeof AbortController==="function"?new AbortController():null;var es={url:href,readyState:0,withCredentials:false,onopen:null,onmessage:null,onerror:null,addEventListener:function(t,fn){(ls[t]=ls[t]||[]).push(fn)},removeEventListener:function(t,fn){ls[t]=(ls[t]||[]).filter(function(x){return x!==fn})},close:function(){es.readyState=2;if(ac)try{ac.abort()}catch(e){}}};fetchFn(href,{headers:{Accept:"text/event-stream","Cache-Control":"no-cache"},cache:"no-store",signal:ac&&ac.signal}).then(function(r){if(es.readyState===2)return;es.readyState=1;emit("open","");if(!r.body||!r.body.getReader)throw new Error("no_stream");var reader=r.body.getReader();var dec=typeof TextDecoder==="function"?new TextDecoder():null;var buf="";function pump(){return reader.read().then(function(x){if(es.readyState===2)return;if(x.done){es.readyState=2;emit("error","");return}buf+=dec?dec.decode(x.value,{stream:true}):"";var p;while((p=buf.indexOf("\\n\\n"))>=0){var block=buf.slice(0,p);buf=buf.slice(p+2);var data="",ev="message";block.split(/\\r?\\n/).forEach(function(line){if(!line||line.charAt(0)===":")return;if(line.indexOf("data:")===0)data+=(data?"\\n":"")+line.slice(5).replace(/^ /,"");else if(line.indexOf("event:")===0)ev=line.slice(6).replace(/^ /,"")});if(data)emit(ev,data)}return pump()})}return pump()}).catch(function(){if(es.readyState!==2){es.readyState=2;emit("error","")}});return es}}catch(g){}})(${JSON.stringify(prefix)})</script>`;
  }

  private rewriteLocation(location: string, runtimeId: string, access: string): string {
    try {
      const target = new URL(location, 'http://127.0.0.1:39200');
      return `${this.externalPrefix(runtimeId, access).replace(/\/$/, '')}${target.pathname}${target.search}${target.hash}`;
    } catch {
      return this.externalPrefix(runtimeId, access);
    }
  }

  private signedAccess(runtimeId: string, expires: number): string {
    const payload = `${runtimeId}.${String(expires)}`;
    return `${String(expires)}.${createHmac('sha256', this.signingKey).update(payload).digest('base64url')}`;
  }

  private validAccess(runtimeId: string, access: string): boolean {
    const match = access.match(ACCESS_TOKEN);
    if (!match) return false;
    const expires = Number(match[1]);
    if (!Number.isSafeInteger(expires) || expires <= Date.now()) return false;
    const payload = `${runtimeId}.${match[1]}`;
    const expected = createHmac('sha256', this.signingKey).update(payload).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(match[2], 'base64url');
    } catch {
      return false;
    }
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }

  private externalPrefix(runtimeId: string, access: string): string {
    return `/sa/harness/${runtimeId}/${access}/`;
  }

  private initializeUpstream(runtime: HarnessRuntimeContext): Promise<void> {
    if (runtime.upstreamCookie) return Promise.resolve();
    return new Promise<void>((resolvePromise, reject) => {
      const upstream = httpRequest(
        {
          socketPath: runtime.socketPath,
          method: 'GET',
          path: `/?token=${encodeURIComponent(runtime.upstreamToken)}`,
          headers: { host: '127.0.0.1:39200', 'accept-encoding': 'identity' },
          timeout: UPSTREAM_CONNECT_TIMEOUT_MS,
        },
        (upstreamResponse) => {
          const cookies = upstreamResponse.headers['set-cookie'] ?? [];
          const cookie = cookies[0]?.split(';', 1)[0];
          upstreamResponse.resume();
          upstreamResponse.once('end', () => {
            if (
              !cookie
              || !/^[A-Za-z0-9_-]+=[A-Za-z0-9._-]+$/.test(cookie)
              || (upstreamResponse.statusCode ?? 500) >= 400
            ) {
              reject(new Error('harness_upstream_auth_failed'));
              return;
            }
            runtime.upstreamCookie = cookie;
            resolvePromise();
          });
        },
      );
      upstream.once('timeout', () => upstream.destroy(new Error('harness_upstream_timeout')));
      upstream.once('error', reject);
      upstream.end();
    });
  }

  private rejectUpgrade(socket: Socket, status: number): void {
    const label = status === 401 ? 'Unauthorized' : 'Not Found';
    socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\n\r\n`);
  }
}
