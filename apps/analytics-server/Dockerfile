# syntax=docker/dockerfile:1
# analytics-server / analytics-ingestor 镜像（Candela 后端）
#
# 构建上下文：apps/analytics-server（自包含，不依赖兄弟应用）
#   docker build -t candela-server:<tag> -f apps/analytics-server/Dockerfile apps/analytics-server
#
# 三个 target：
#   runtime —— 运行用（生产依赖 + 编译产物 + 已生成的 Prisma Client），server 与 ingestor 共用
#   migrate —— 迁移/初始化用（保留 prisma CLI 与全部依赖），跑 migrate deploy / init-*/migrate-* 脚本
#   默认（builder）—— 只用于中间层缓存
#
# 刻意把 Prisma Client 的生成放在**构建期**（不是启动命令里）：
# 生产 supervisor 的 command 里跑 `npx prisma generate`，会让启动依赖 npm 网络且拖慢冷启；
# 容器化后由镜像固化，启动即 `node dist/.../main.js`。

ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-bookworm-slim
ARG NPM_REGISTRY=https://registry.npmmirror.com
# Debian 源镜像：国内环境由部署脚本传 mirrors.aliyun.com；留空则用镜像自带源
ARG APT_MIRROR=

# ---------------------------------------------------------------- deps
FROM ${NODE_IMAGE} AS deps
ARG NPM_REGISTRY
ARG APT_MIRROR
WORKDIR /app
# node:*-slim 不带 OpenSSL，Prisma 的 schema/query engine 会因无法识别 libssl 版本而失败
# （实测报 "Prisma failed to detect the libssl/openssl version to use"）。
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    fi \
 && apt-get update -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV npm_config_registry=${NPM_REGISTRY} npm_config_audit=false npm_config_fund=false
COPY package.json package-lock.json ./
# npm 11.19+ 的 allowScripts 门禁会跳过 postinstall；本镜像不依赖任何 postinstall：
# Prisma 引擎由显式 `prisma generate` 下载（见 builder）。
RUN npm ci

# ---------------------------------------------------------------- builder
FROM deps AS builder
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------- migrate
# 迁移/运维镜像：保留全部依赖（prisma CLI、ts-node）以便跑 migrate deploy 与初始化脚本
FROM deps AS migrate
ENV NODE_ENV=production TZ=UTC
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=builder /app/dist ./dist
# 运维脚本（migrate-runtime-db.sh 等）由 compose 以只读方式挂入 /app/ops
CMD ["node", "--version"]

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ARG NPM_REGISTRY
ARG APT_MIRROR
WORKDIR /app
# 同上：query engine 需要 libssl
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    fi \
 && apt-get update -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production TZ=UTC NPM_CONFIG_REGISTRY=${NPM_REGISTRY}
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY prisma ./prisma
COPY --from=builder /app/dist ./dist
# Prisma Client 已生成物随镜像带走（runtime 阶段没有 prisma CLI）
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
# DLQ（ingestor 消费失败落盘）与日志目录：运行时由 compose 挂卷覆盖
RUN mkdir -p /app/dlq /app/logs
# 与生产一致：进程以 root 运行（生产 supervisor 也是 user=root）
EXPOSE 3100
CMD ["node", "dist/main.js"]
