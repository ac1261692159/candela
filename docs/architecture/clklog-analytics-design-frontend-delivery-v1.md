# 实现方案：前端交付优化与分片失败兜底（phase: clklog-analytics-frontend-delivery-v1）

> phase: clklog-analytics-frontend-delivery-v1
> 上游：`docs/product/prd-clklog-analytics-frontend-delivery-v1.md`
> 本文是本期"预压缩产物契约"与"分片失败兜底"的 SSOT。

---

## 1. 阶段目标与范围

1. `scripts/build.sh` 增加预压缩步骤，产物带 `.gz`。
2. 前端：`vite:preloadError` 自愈 + 路由错误边界给出可操作提示。
3. 不改 nginx（长缓存 / 404 / 配置漂移走 Puppet 另议）。

---

## 2. 验收标准（实现层）

- [ ] **FD-a**：`scripts/build.sh` 在收集 `target/web` 之后、汇总产物之前，对 `*.js|*.css|*.svg|*.json|*.html` 且 >1KB 的文件生成同名 `.gz`；构建日志打印「原始 X KB → .gz Y KB」。
- [ ] **FD-b**：无 `gzip` 命令时跳过并告警，构建仍然成功（脚本 `set -e` 不得被中断）。
- [ ] **FD-c**：`main.tsx` 监听 `vite:preloadError`：距上次自愈 ≥30s 时写 `sessionStorage[clklog:chunk-reload]` 并 `location.reload()`；窗口内不再刷新。
- [ ] **FD-d**：`routes.tsx` 的 `ChunkErrorBoundary`（`LazyWrap` 内）捕获懒加载失败：无标记时按 FD-c 规则刷新；有标记时渲染 `Result`（标题 `common:error.chunkFailed`、按钮 `common:action.refresh`）。
- [ ] **FD-e**：断言落在 `src/chunk-error-boundary.spec.tsx`（首次失败触发刷新、窗口内展示提示与刷新按钮）。
- [ ] **FD-f**：门禁全绿（含 `i18n_check` 对新增 `common:error.chunkFailed` 的 13 语言校验）。

---

## 3. 非目标

与 PRD §4 一致。实现层补充：不改 `vite.config.ts` 的构建配置（不做 brotli / 不做拆包）；不引入 Service Worker；后端与部署脚本的 rsync 参数不变（`.gz` 随既有 rsync 一并同步，无需额外动作）。

---

## 4. 产物契约（预压缩）

| 项 | 约定 |
|---|---|
| 位置 | 与源文件同目录、同名 + `.gz`（`assets/foo.js` → `assets/foo.js.gz`） |
| 触发端 | `scripts/build.sh`（CI 内，`target/web`） |
| 生效端 | 服务器 nginx **既有** `gzip_static on`：客户端 `Accept-Encoding: gzip` 时自动改用 `.gz`，否则回落原文件 |
| 压缩级别 | `gzip -9`（离线压缩，不吃线上 CPU） |
| 覆盖范围 | `*.js` / `*.css` / `*.svg` / `*.json` / `*.html`，且原始 >1KB（更小的文件压缩收益低于协议开销） |
| 实测收益 | 入口分片 1,132,673 → 356,535 字节（-68%）；`query.service` 1.2MB → 386KB |

不改动的部分：rsync 同步策略、`web/index.html` 的生成方式、SPA 回退行为（缺失分片仍会回落 HTML——本期用前端兜底覆盖该场景，见 §5）。

---

## 5. 分片失败兜底

```
动态导入失败
├─ vite:preloadError（main.tsx，非路由场景也覆盖）
│   └─ 距上次自愈 ≥30s → sessionStorage 打点 + location.reload()
└─ ChunkErrorBoundary（routes.tsx，懒加载路由渲染失败）
    ├─ 无打点 → 同上（自愈）
    └─ 有打点 → Result 提示 + 刷新按钮（不再自动刷新，避免循环）
```

- 打点键 `clklog:chunk-reload`，值为时间戳；30 秒窗口够一次正常加载完成，又能在真正修复(重发版)后再次自愈。
- 文案键：`common:error.chunkFailed`（新增，13 语言）、按钮复用 `common:action.refresh`。

---

## 6. 风险与回滚

- **预压缩与源文件不同步**：每次构建重新生成、随同一产物发布，天然同步。
- **磁盘**：web 产物增加约 30%；与 assets 堆积问题（13,367 文件 / 681MB）合并治理，保留策略另行处理。
- **回滚**：删除 build.sh 的预压缩段即恢复原状（`.gz` 不被引用时无副作用）；前端兜底为纯增量逻辑，`git revert` 即可。

---

## 7. nginx 侧改动（已改真实 Puppet 仓库，待用户提交后 apply）

2026-09-20 把三项需要 HTTP 头的改动落到真实 Puppet 仓库的
`modules/clklog/files/nginx-clklog-manager.conf`（本仓库对照副本同步为
`puppet/clklog/files/nginx-clklog-manager.conf` 与 `scripts/nginx-clklog-manager.conf`）：

| 改动 | 内容 |
|---|---|
| 静态资源长缓存 | `location /sa/assets/` → `Cache-Control: public, max-age=31536000, immutable`（文件名含构建 hash） |
| 缺失分片返回 404 | 同 location 内 `try_files $uri =404`；此前回落 `/sa/index.html`（200 + text/html → 静默白屏） |
| 入口不可缓存 | `location = /sa/index.html` 与 `= /index.html` → `Cache-Control: no-cache` |
| **配置漂移修复（顺带）** | 该文件在真实仓库里还是旧版：补上 SSE 专用 location、`map $http_upgrade $harness_connection`、`location = /login`、`location /sa/` |

- 已在服务器上做过「换入候选 → `nginx -t` → 立即还原」的语法校验（通过），**线上运行配置未改动**。
- 生效方式：用户提交真实 Puppet 仓库后由 puppet 下发（服务器 `puppet` 服务显示非 active，可能需手动 apply）。apply 后 SSE 相关行为会与本仓库早已修复的版本对齐。

## 8. 后续（本期不做）

| 事项 | 说明 | 落点 |
|---|---|---|
| assets 目录堆积 | 13,367 文件 / 681MB，无保留策略（保留近 N 天以免老页面立刻失效） | `scripts/server-upgrade.sh` |
