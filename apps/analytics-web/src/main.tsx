import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { CHUNK_RELOAD_KEY } from './routes';
import { initI18n } from './i18n';
import { LocaleBridge } from './i18n/LocaleBridge';

/**
 * 分片加载失败自愈（2026-09-19 事故）。
 *
 * 发版会替换资产目录：停留在旧页面的浏览器请求不到对应分片，应用会卡在加载态（白屏）。
 * Vite 在动态导入失败时派发 `vite:preloadError`，这里自动刷新一次拿新入口；用时间窗防循环
 * （30 秒内已自愈过就不再刷新，交给路由错误边界给出可操作的提示）。
 */
const CHUNK_RELOAD_WINDOW_MS = 30_000;
window.addEventListener('vite:preloadError', () => {
  const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0);
  if (Date.now() - last < CHUNK_RELOAD_WINDOW_MS) return;
  sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  window.location.reload();
});

/**
 * 应用入口：先初始化 i18n（预载当前语言的全部命名空间）再渲染，避免首屏「键名闪烁」。
 * 语言相关装配集中在 src/i18n/（LocaleBridge 负责 antd / dayjs / <html lang>），本文件不含业务规则。
 */
initI18n().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <LocaleBridge>
        <BrowserRouter basename="/sa">
          <App />
        </BrowserRouter>
      </LocaleBridge>
    </React.StrictMode>,
  );
});
