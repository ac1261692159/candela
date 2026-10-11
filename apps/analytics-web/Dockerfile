# syntax=docker/dockerfile:1
# analytics-web 镜像（Candela 前端静态站点）
#
# 构建上下文：**仓库根**（不是 apps/analytics-web 本身）——本应用构建依赖兄弟应用与仓库脚本：
#   apps/analytics-web 的 tsc 会类型检查 spec 文件，而两个 spec 从兄弟应用引 JSON：
#     src/features/ai-analysis/dsl-form.spec.ts
#       → ../../../../analytics-harness-host/plugins/analytics-tools/analysis-cases.json
#   即「前端构建依赖 analytics-harness-host」。CI 在整仓构建所以看不出问题；
#   单独构建前端时若只给 analytics-web，tsc 会报 TS2307 直接失败（2026-10-10 实测）。
#   已登记为待解耦项，见 docs/architecture/candela-deploy-two-paths.md。
#
# 构建命令（上下文 = **仓库根**，即含 apps/、examples/、scripts/ 的目录）：
#   docker build -t candela-web:<tag> -f apps/analytics-web/Dockerfile .
#
# 产物布局与 CI scripts/build.sh 一致：
#   /usr/share/nginx/html/sa/…       vite 产物（base=/sa/）
#   /usr/share/nginx/html/index.html SPA 回退入口
#   *.gz                             预压缩（nginx gzip_static on）

ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-bookworm-slim
ARG NGINX_IMAGE=public.ecr.aws/docker/library/nginx:1.27-alpine

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /work
ENV npm_config_registry=${NPM_REGISTRY} npm_config_audit=false npm_config_fund=false
# 摆成与仓库一致的相对布局：apps/analytics-web/... 与 apps/analytics-harness-host/...
# 这样 spec 里的 ../../../../analytics-harness-host/... 能自然解析
COPY apps/analytics-web/package.json apps/analytics-web/package-lock.json ./apps/analytics-web/
RUN cd apps/analytics-web && npm ci
COPY apps/analytics-web ./apps/analytics-web
COPY apps/analytics-harness-host/plugins/analytics-tools/analysis-cases.json \
     ./apps/analytics-harness-host/plugins/analytics-tools/analysis-cases.json
# onboarding 页的 SDK 示例下载包由脚本现打（产物不入库）；脚本按 <root>/apps/analytics-web 定位
COPY examples ./examples
COPY scripts/build-sdk-demos.sh ./scripts/build-sdk-demos.sh
RUN bash scripts/build-sdk-demos.sh || true
RUN cd apps/analytics-web && npm run build
# 预压缩（宿主 nginx / 容器 nginx 都开 gzip_static：客户端不支持时自动回落原文件）
RUN cd apps/analytics-web && find dist -type f \
      \( -name '*.js' -o -name '*.css' -o -name '*.svg' -o -name '*.json' -o -name '*.html' \) \
      -size +1k ! -name '*.gz' -exec gzip -kf -9 {} \;

# ---------------------------------------------------------------- runtime
FROM ${NGINX_IMAGE} AS runtime
COPY --from=build /work/apps/analytics-web/dist /usr/share/nginx/html/sa
RUN cp /usr/share/nginx/html/sa/index.html /usr/share/nginx/html/index.html
COPY apps/analytics-web/docker/nginx-web.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
