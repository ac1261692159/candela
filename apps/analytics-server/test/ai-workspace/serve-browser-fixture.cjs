// Local browser verification of the real proxy shim in an opaque-origin iframe.
// Build the server first, then: node test/ai-workspace/serve-browser-fixture.cjs
// Open http://127.0.0.1:18189 and press the two verification buttons. No real credentials.
const { createServer } = require('node:http');
require('reflect-metadata');
const { HarnessWebProxyService } = require('../../dist/src/modules/ai-assistant/harness-web-proxy.service');
const runtime = 'air_browser_fixture_1234567890123456';
const oldPrefix = `/sa/harness/${runtime}/1000000000000.fixture_old`;
const newPrefix = `/sa/harness/${runtime}/2000000000000.fixture_new`;
const shim = new HarnessWebProxyService({}, {}).browserShim(oldPrefix);
const calls = [];
const child = `<!doctype html><html><head>${shim}</head><body><p>隔离 iframe 会话仍在。</p><script>
let count=0;
addEventListener('message',async e=>{
 if(e.source!==parent || e.data?.type!=='fixture-run')return;
 const response=await fetch(${JSON.stringify(oldPrefix)}+'/api/session/prompt',{method:'POST'});
 const body=await response.json();
 parent.postMessage({type:'fixture-result',count:++count,status:response.status,path:body.path},'*');
});
</script></body></html>`;
const parent = `<!doctype html><html lang="zh"><head><meta charset="UTF-8"><title>Harness 浏览器续期验证</title>
<style>body{font:16px system-ui;max-width:960px;margin:48px auto}button{padding:12px;margin-right:12px}pre{white-space:pre-wrap;background:#eee;padding:20px}iframe{width:100%;height:90px;border:1px solid #aaa}</style></head><body>
<h1>Harness 浏览器续期验证</h1><p>真实代理 shim · opaque-origin iframe · 合成签名 · 仅本地请求</p>
<button id="renew">续期并请求</button><button id="expired">验证 401 不重放</button><pre id="log">等待 iframe ready…</pre>
<iframe id="frame" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"></iframe>
<script>
const frame=document.getElementById('frame'),log=document.getElementById('log');let ready=0;
addEventListener('message',e=>{if(e.source!==frame.contentWindow)return;
 if(e.data?.type==='clklog:harness-ready'){ready++;log.textContent='iframe ready 次数='+ready+'；消息 origin='+e.origin;}
 if(e.data?.type==='clklog:harness-unauthorized')log.textContent+='\\n401 已上报宿主；未重放。';
 if(e.data?.type==='fixture-result')log.textContent+='\\n'+JSON.stringify(e.data)+'；iframe ready 次数='+ready;
});
frame.src=${JSON.stringify(oldPrefix + '/frame')};
document.getElementById('renew').onclick=()=>{frame.contentWindow.postMessage({type:'clklog:harness-renewed',prefix:${JSON.stringify(newPrefix + '/')}},'*');frame.contentWindow.postMessage({type:'fixture-run'},'*');};
document.getElementById('expired').onclick=()=>{frame.contentWindow.postMessage({type:'clklog:harness-renewed',prefix:${JSON.stringify(oldPrefix + '/')}},'*');frame.contentWindow.postMessage({type:'fixture-run'},'*');};
</script></body></html>`;
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(parent); }
  else if (req.url === oldPrefix + '/frame') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(child); }
  else if (req.url.endsWith('/api/session/prompt')) {
    calls.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = req.url.startsWith(newPrefix) ? 200 : 401;
    res.end(JSON.stringify({ path: req.url }));
  } else if (req.url === '/evidence') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ calls })); }
  else { res.statusCode = 404; res.end(); }
});
server.listen(18189, '127.0.0.1', () => console.log('Browser fixture: http://127.0.0.1:18189'));
process.on('SIGINT', () => server.close());
process.on('SIGTERM', () => server.close());
