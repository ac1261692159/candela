# PRD：前端交付优化与分片失败兜底（phase: clklog-analytics-frontend-delivery-v1）

> phase: clklog-analytics-frontend-delivery-v1
> 触发：2026-09-19 事故——clklog-manager 页面白屏、43 秒不可用。
> 下游：`docs/architecture/clklog-analytics-design-frontend-delivery-v1.md`

---

## 1. 事故与排查结论

| 事实 | 证据 |
|---|---|
| 服务器侧健康 | 出错分片 `GET /sa/assets/ai-CQEK4mE-.js` 在服务器本机 25 微秒返回 200，文件均在 |
| 页面跑的是当前构建 | 访问日志 referer = `index-BtUuLnad.js`（当前入口），不是版本错配 |
| 传输层是瓶颈 | 日志时间线：19 请求 / 1.2 MB / **43 秒**，请求间隔 2–3 秒（逐请求串行） |
| **JS 全程未压缩** | 响应头只有 `Content-Type: application/javascript` + `Content-Length: 1132673`，**无 `Content-Encoding`** |
| 根因 | nginx 全局 `gzip_types` 缺 `application/javascript`（.js 的默认 MIME），所有 JS 绕过 gzip |
| 缺缓存头 | 静态资源响应无 `Cache-Control`（文件名带内容 hash，本可长缓存） |
| 附带缺陷 | 请求不存在的分片回落 `index.html`（实测 200 / text/html / 481 字节）→ 版本错配时**静默白屏** |

---

## 2. 阶段目标与范围

1. **构建期预压缩**：产物随包提供 `.gz`，服务器 nginx 既有的 `gzip_static on` 自动生效——**不改任何 nginx 配置**。
2. **分片加载失败兜底**：动态导入失败时自动刷新一次自愈；仍失败给出可操作提示（13 语言）。
3. **明确边界**：需要动 nginx 的三项（长缓存头 / 缺失分片返回 404 / 部署配置漂移）不在本期，走 Puppet 仓库另议。

---

## 3. 验收标准

- [ ] **FD-1 压缩生效**：发版后 `curl -H 'Accept-Encoding: gzip' /sa/assets/index-*.js` 返回 `Content-Encoding: gzip`，字节数较原始下降 ≥60%（实测 -68%）；不带 `Accept-Encoding` 时回落原文件、状态 200。
- [ ] **FD-2 产物完整**：`target/web` 下 `*.js` / `*.css` / `*.svg` / `*.json` / `*.html`（>1KB）均有同名 `.gz`；构建日志打印原始与压缩后总量。
- [ ] **FD-3 无 gzip 环境降级**：镜像内没有 `gzip` 时构建不失败，只打印告警。
- [ ] **FD-4 失败自愈**：动态导入失败时自动刷新一次（`sessionStorage` 时间窗 30s 防循环）。
- [ ] **FD-5 可操作提示**：时间窗内的再次失败不再刷新，展示「平台已更新，请刷新页面」+ 刷新按钮。
- [ ] **FD-6 文案与门禁**：新增文案 13 门语言齐备；`arch_ratchet` / `i18n_check` / `i18n_scan` / jest / vitest / 两端 `tsc` 全绿。

---

## 4. 非目标

1. **不改 nginx 配置**：长缓存头、缺失分片 404、部署配置漂移三项如需处理，在真实 Puppet 仓库另开改动（用户明确要求 nginx 变更走 puppet）。
2. **不做拆包瘦身**：入口 1.1MB 的构成未做进一步优化（已核实其中不含多语言资源）；如需按路由/依赖细分包，另立一期。
3. **不引入 CDN / Service Worker**。
4. **不动后端与数据链路**。

---

## 5. 风险

- **`.gz` 与源文件不同步**：构建每次重新生成，且随同一份产物 rsync 发布，不存在跨版本混用。
- **磁盘增长**：预压缩会让 web 产物增加约 30%；与"assets 目录已堆积 13,367 文件 / 681MB"叠加需一起治理（保留策略属运维，另行处理）。
- **中间缓存误发 gzip**：nginx 侧 `gzip_vary off`，代理层理论上可能把 gzip 响应发给不支持 gzip 的客户端；现代客户端均支持，且本域名未启用代理缓存，风险可接受。

## 6. 发布说明

- 首屏传输量由 1.2MB 级降到约 380KB 级（同比例压缩所有文本类静态资源）。
- 页面遇到"平台刚更新、旧分片取不到"的情况会自动刷新一次；仍失败会提示刷新而不是白屏。
