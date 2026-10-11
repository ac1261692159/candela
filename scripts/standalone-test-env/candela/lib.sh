#!/usr/bin/env bash
# lib.sh — Candela（分析平台）部署共享库
#
# 被 init-db-*.sh / deploy-native.sh / deploy-docker.sh / verify.sh / wipe-databases.sh source。
# 复用上层 scripts/standalone-test-env/lib.sh 的通用函数（日志/口令/镜像/等待/compose），
# 本文件只放 manager 专属的：路径约定、口令契约、配置渲染、数据库客户端封装。
#
# 两套流程（native / docker）共用同一份「数据库初始化」与同一份「口令契约」，
# 差异只在加载方式：进程跑在宿主（native）还是容器里（docker）。见 docs/architecture/candela-deploy-two-paths.md。

set -euo pipefail

# manager 自己的部署根（口令与渲染配置放这里）
export BASE_DIR="${BASE_DIR:-/data/app/candela}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
. "$SELF_DIR/../lib.sh"
# 日志前缀改用本产品标签（父级 lib.sh 的 [clklog-testenv] 是中间件/社区版环境的标签）
LOG_TAG="[candela]"

# 中间件层口令（由 standalone-test-env 的中间件部署生成，此处只读复用，不重复生成）
MW_BASE_DIR="${MW_BASE_DIR:-/data/clklog-oss-test}"
MW_ENV="${MW_ENV:-$MW_BASE_DIR/config/deploy.env}"
# 中间件 ClickHouse 的 users.d（只读账号配置写这里；中间件侧已按目录挂载该目录）
MW_CH_USERS_D="${MW_CH_USERS_D:-$MW_BASE_DIR/middleware/clickhouse/users.d}"

# 密钥文件 = 服务运行时 .env（一份文件两用：部署期生成 + supervisord/compose 加载），
# 避免「密钥一份、服务 env 另一份」两处真相。权限 0600。
mkdir -p "$BASE_DIR/configs"
ENV_FILE="$BASE_DIR/configs/candela.env"

# 更名迁移守卫（2026-10-10 项目由 clklog_manager 更名 Candela）：
# 密钥文件路径随之改变，若不迁移会被当成"全新部署"重新生成全部口令——
# 而数据库里已有账号/超管仍是旧口令的哈希，表现为"部署成功但登录失败"。
# 因此旧文件存在且新文件不存在时，直接改名复用（密钥不变，服务与库继续对得上）。
LEGACY_ENV_FILE="$BASE_DIR/configs/clklog-manager.env"
if [ ! -f "$ENV_FILE" ] && [ -f "$LEGACY_ENV_FILE" ]; then
  mv "$LEGACY_ENV_FILE" "$ENV_FILE"
  echo "[candela] 已迁移密钥文件：clklog-manager.env → candela.env（口令保持不变）" >&2
fi

# 仓库源（部署时由本地 rsync 上来，用于构建）
# 目录结构与仓库同构（apps/ + examples/ + scripts/），这样 Dockerfile 可以用仓库根作为
# 构建上下文、与本仓库里的 Dockerfile 完全一致，不需要为部署另做一套路径。
SRC_DIR="${SRC_DIR:-$BASE_DIR/src}"
SRC_SERVER="$SRC_DIR/apps/analytics-server"
SRC_WEB="$SRC_DIR/apps/analytics-web"
SRC_COMMUNITY_ASSETS="$SRC_DIR/clklog_dc_config"
OPS_DIR="${OPS_DIR:-$BASE_DIR/ops}"
RELEASES_DIR="$BASE_DIR/releases"
CURRENT_LINK="$BASE_DIR/current"
PREVIOUS_LINK="$BASE_DIR/previous"
LOG_DIR="${LOG_DIR:-/data/logs/production/candela}"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/conf.d/candela.conf}"
SUPERVISOR_DIR="${SUPERVISOR_DIR:-/etc/supervisord.d}"
NODE_VERSION="24.20.0"
NODE_ROOT="${NODE_ROOT:-/opt/clklog}"
NODE_BIN="$NODE_ROOT/node-v${NODE_VERSION}-linux-x64/bin"
# 与生产 puppet/clklog/files/install-node24.sh 同版本同校验；两套流程与 harness 安装共用
NODE_VERSION_SHA256="2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2"

RUNTIME_DB="clklog_sa_meta"     # manager 元数据库（MySQL/Prisma）
RUNTIME_CH_DB="clklog_sa"       # manager 事件库（ClickHouse）
RUNTIME_DB_USER="clklog_sa_app"
COMMUNITY_DB="clklog"           # 社区版库（本仓库同时负责它的初始化）

# ---------------------------------------------------------------- 口令契约

# 读中间件层口令（缺失即报错：manager 复用中间件的 MySQL/CH/Redis，不能各建一套）
mw_require() {
  local key="$1" v
  v="$(sed -n "s/^${key}=//p" "$MW_ENV" 2>/dev/null | tail -1)"
  [ -n "$v" ] || die "中间件口令缺失：$key（读 $MW_ENV）。请先执行 scripts/standalone-test-env/deploy-middleware.sh"
  printf '%s' "$v"
}

# manager 专属口令：首次生成写入 manager 的 deploy.env，之后复用
# 生成后导出到环境，供 config.yaml 的 ${VAR} 占位符与脚本使用
load_manager_secrets() {
  MYSQL_ROOT_PASSWORD="$(mw_require MYSQL_ROOT_PASSWORD)"
  CLICKHOUSE_PASSWORD="$(mw_require CK_USER_PWD)"
  REDIS_PASSWORD="$(mw_require REDIS_PASSWORD)"

  MYSQL_PASSWORD="$(ensure_secret MYSQL_PASSWORD)"
  READONLY_CH_PASSWORD="$(ensure_secret READONLY_CH_PASSWORD)"
  CLICKHOUSE_CLEANUP_PASSWORD="$(ensure_secret CLICKHOUSE_CLEANUP_PASSWORD)"
  CLICKHOUSE_CLEANUP_USER="sa_cleanup"
  ADMIN_INIT_PASSWORD="$(ensure_secret ADMIN_INIT_PASSWORD)"
  # 凭证加密主密钥：32 字节 base64（openssl rand -base64 32），缺失则告警通道凭证无法保存
  if [ -z "$(get_env ALERT_CONFIG_KEY)" ]; then
    set_env_once ALERT_CONFIG_KEY "$(openssl rand -base64 32 | tr -d '\n')"
  fi
  ALERT_CONFIG_KEY="$(get_env ALERT_CONFIG_KEY)"

  export MYSQL_ROOT_PASSWORD CLICKHOUSE_PASSWORD REDIS_PASSWORD MYSQL_PASSWORD \
         READONLY_CH_PASSWORD CLICKHOUSE_CLEANUP_PASSWORD CLICKHOUSE_CLEANUP_USER \
         ADMIN_INIT_PASSWORD ALERT_CONFIG_KEY
}

# 连接地址：native 走宿主回环，docker 走 compose 服务名。
# 两套流程的唯一差异点，集中在这里，避免配置模板分叉。
set_endpoints() {
  local mode="$1"   # native | docker
  case "$mode" in
    native)
      MG_MYSQL_HOST="127.0.0.1"; MG_MYSQL_PORT="3306"
      MG_CH_HOST="127.0.0.1";    MG_CH_PORT="8123"; MG_CH_TCP_PORT="9000"
      MG_REDIS_HOST="127.0.0.1"; MG_REDIS_PORT="6379"
      MG_KAFKA_BROKER="127.0.0.1:19092"   # 中间件 Kafka 的 EXTERNAL listener（宿主可达）
      ;;
    docker)
      MG_MYSQL_HOST="mysql";   MG_MYSQL_PORT="3306"
      MG_CH_HOST="clickhouse"; MG_CH_PORT="8123"; MG_CH_TCP_PORT="9000"
      MG_REDIS_HOST="redis";   MG_REDIS_PORT="6379"
      MG_KAFKA_BROKER="kafka:9092"        # clklog-net 内网 listener
      ;;
    *) die "未知模式：$mode（native|docker）" ;;
  esac
  MG_DATABASE_URL="mysql://${RUNTIME_DB_USER}:${MYSQL_PASSWORD}@${MG_MYSQL_HOST}:${MG_MYSQL_PORT}/${RUNTIME_DB}"
  # 宿主运维视角：中间件端口都发布在宿主 127.0.0.1，运维/初始化脚本一律用它，
  # 与「应用在容器内用服务名寻址」解耦。
  OPS_MYSQL_HOST="127.0.0.1"; OPS_MYSQL_PORT="3306"
  OPS_CH_HOST="127.0.0.1";    OPS_CH_PORT="8123"
  export MG_MYSQL_HOST MG_MYSQL_PORT MG_CH_HOST MG_CH_PORT MG_CH_TCP_PORT \
         MG_REDIS_HOST MG_REDIS_PORT MG_KAFKA_BROKER MG_DATABASE_URL \
         OPS_MYSQL_HOST OPS_MYSQL_PORT OPS_CH_HOST OPS_CH_PORT
}

# 收敛服务运行时环境文件（$ENV_FILE）：
#   生成类密钥（首次写入后不改）从文件回读后原样保留，派生类（连接串/中间件口令）按当前形态重算。
# 该文件同时被 supervisord 命令 source、被 docker compose --env-file 加载。
write_service_env() {
  local f="$ENV_FILE"
  # 必须先把值读进变量：`cat > "$f" <<ENV` 会**先截断文件**再展开 heredoc 里的
  # $(...) 命令替换，直接在里面 $(get_env X) 读到的是空文件 → 写出空口令。
  # （2026-10-10 实测踩到：同键出现两值、DATABASE_URL 与 MYSQL_PASSWORD 不一致。）
  local v_mysql_pw v_ro_pw v_cleanup_pw v_admin_pw v_alert_key
  v_mysql_pw="$(get_env MYSQL_PASSWORD)"
  v_ro_pw="$(get_env READONLY_CH_PASSWORD)"
  v_cleanup_pw="$(get_env CLICKHOUSE_CLEANUP_PASSWORD)"
  v_admin_pw="$(get_env ADMIN_INIT_PASSWORD)"
  v_alert_key="$(get_env ALERT_CONFIG_KEY)"
  [ -n "$v_mysql_pw" ] || die "写入服务 env 前缺少 MYSQL_PASSWORD（先跑 load_manager_secrets）"
  # docker 方案的回滚元数据（DOCKER_*_TAG）与密钥同文件：它是覆盖写，必须显式保留——
  # 否则 native 形态重渲染会抹掉它们，从 native 切回 docker 后 `--skip-build`（回滚路径）
  # 读不到 tag（2026-10-10 实测踩到；deploy-docker.sh 的记录点已同步移到渲染之后）。
  local v_docker_server v_docker_ingestor v_docker_migrate v_docker_web
  v_docker_server="$(get_env DOCKER_SERVER_TAG)"
  v_docker_ingestor="$(get_env DOCKER_INGESTOR_TAG)"
  v_docker_migrate="$(get_env DOCKER_MIGRATE_TAG)"
  v_docker_web="$(get_env DOCKER_WEB_TAG)"

  mkdir -p "$(dirname "$f")"
  # umask 必须在子 shell 里改：直接 umask 077 会泄漏到整个脚本，
  # 使后续创建的发布目录/静态文件全变成 0600，nginx 读不到（2026-10-10 实测踩到）。
  (
    umask 077
    cat > "$f" <<ENV
# Candela 部署密钥与运行环境（部署期生成/收敛；0600；请勿提交仓库）
# ---- 生成类：首次生成后固定，轮换需同步数据库侧 ----
MYSQL_PASSWORD=$v_mysql_pw
READONLY_CH_PASSWORD=$v_ro_pw
CLICKHOUSE_CLEANUP_PASSWORD=$v_cleanup_pw
ADMIN_INIT_PASSWORD=$v_admin_pw
ALERT_CONFIG_KEY=$v_alert_key
# ---- 派生类：每次部署按当前形态重算 ----
CLICKHOUSE_PASSWORD=$CLICKHOUSE_PASSWORD
REDIS_PASSWORD=$REDIS_PASSWORD
CLICKHOUSE_CLEANUP_USER=$CLICKHOUSE_CLEANUP_USER
DATABASE_URL=$MG_DATABASE_URL
ENV
    if [ -n "$v_docker_server" ]; then
      {
        printf '# ---- docker 方案回滚元数据（native 部署时原样保留，见 deploy-docker.sh）----\n'
        printf 'DOCKER_SERVER_TAG=%s\n' "$v_docker_server"
        printf 'DOCKER_INGESTOR_TAG=%s\n' "$v_docker_ingestor"
        printf 'DOCKER_MIGRATE_TAG=%s\n' "$v_docker_migrate"
        printf 'DOCKER_WEB_TAG=%s\n' "$v_docker_web"
      } >> "$f"
    fi
  )
  chmod 0600 "$f"
}

# 大小写不敏感地解析元数据库里的真实表名（Prisma 模型名与 @@map 名大小写不一致，
# 直接写死表名会在 MySQL 大小写敏感环境下误判/误报）。
db_table() {  # $1 = 期望的表名（任意大小写）
  mg_mysql_db "$RUNTIME_DB" -N -B -e \
    "SELECT table_name FROM information_schema.tables WHERE table_schema='${RUNTIME_DB}' AND LOWER(table_name)=LOWER('$1') LIMIT 1" 2>/dev/null
}

# ---------------------------------------------------------------- Node

# 安装 Node 24（幂等；SHA256 校验）。
# 从 deploy-native.sh 提到共享库：docker 形态本身不需要宿主 Node，但 AI Harness 的 broker
# 由宿主 supervisor 拉起、workspace 组装也用宿主 npm——两者都要能自备 Node。
ensure_node24() {
  if [ -x "$NODE_BIN/node" ] && "$NODE_BIN/node" -v 2>/dev/null | grep -q "v${NODE_VERSION}"; then
    log "Node v${NODE_VERSION} 已就绪：$NODE_BIN"
    return 0
  fi
  local archive="node-v${NODE_VERSION}-linux-x64.tar.xz" tmp ok=0 url
  tmp="$(mktemp -d)"
  log "安装 Node v${NODE_VERSION} → $NODE_ROOT"
  for url in \
    "https://mirrors.aliyun.com/nodejs-release/v${NODE_VERSION}/${archive}" \
    "https://nodejs.org/dist/v${NODE_VERSION}/${archive}"; do
    if curl --fail --silent --show-error --location -o "$tmp/$archive" "$url"; then ok=1; break; fi
    warn "下载失败，换源重试：$url"
  done
  [ "$ok" = "1" ] || { rm -rf "$tmp"; die "Node 安装包下载失败（aliyun 与官方源均不可用）"; }
  printf '%s  %s\n' "$NODE_VERSION_SHA256" "$tmp/$archive" | sha256sum -c - >/dev/null \
    || { rm -rf "$tmp"; die "Node 安装包 SHA256 校验失败，拒绝安装"; }
  mkdir -p "$NODE_ROOT"
  tar -xJf "$tmp/$archive" -C "$NODE_ROOT"
  ln -sfn "$NODE_ROOT/node-v${NODE_VERSION}-linux-x64" "$NODE_ROOT/node-current"
  rm -rf "$tmp"
  "$NODE_BIN/node" -v
}

# ---------------------------------------------------------------- 构建产物布局

# nest build 的产物前缀取决于 TS 的 rootDir 推导：仓库 tsconfig.json 没有 include/rootDir，
#   * 源码树里有 test/ → 推导根 = 项目根 → 产物在 dist/src/**
#   * 只推了 src/       → 推导根 = src      → 产物在 dist/**
# 两种布局都支持（部署脚本不依赖 test/ 是否存在）。这是仓库的潜在脆弱点，
# 已在部署文档中登记：建议后续给 tsconfig 加 rootDir 并同步 CI 的产物路径。
dist_entry_prefix() {  # $1=dist 目录；输出 "src" 或 ""
  if [ -f "$1/src/main.js" ]; then printf 'src'; else printf ''; fi
}

# ---------------------------------------------------------------- 配置渲染

# 基于仓库的 config_server.yaml 派生部署配置：只改「部署期变量」，其余保持与仓库一致。
# 每处替换都断言命中恰好 1 次——仓库配置一旦改形，脚本立刻报错而不是静默错配。
render_config_yaml() {
  local src="$1" out="$2"
  [ -f "$src" ] || die "缺少配置模板：$src"
  local content
  content="$(cat "$src")"

  # subst <说明> <期望命中行数> <旧串> <新串>
  #   * 期望命中数写死：仓库配置一旦改形立刻报错，而不是静默错配；
  #   * 全部替换（同一值可能出现在多段，如 ClickHouse 的 write/readonly/tcp 三处 host）。
  subst() {
    local desc="$1" want="$2" old="$3" new="$4" n
    n="$(printf '%s' "$content" | grep -Fc -- "$old" || true)"
    [ "$n" = "$want" ] || die "配置渲染断言失败（${desc}）：期望命中 ${want} 行，实际 ${n} 行（模板已变更，请同步更新脚本）"
    content="$(printf '%s' "$content" | sed "s|$(printf '%s' "$old" | sed 's/[][\.*^$/&|]/\\&/g')|$(printf '%s' "$new" | sed 's/[&|\\]/\\&/g')|g")"
  }

  # 顺序有讲究：先换 ClickHouse 的三处 127.0.0.1，再换 MySQL/Redis——
  # 因为 native 模式下 MySQL/Redis 的新值也是 127.0.0.1，先换会把它们的行也算进来。
  subst "ClickHouse 主机"      3 "host: '127.0.0.1'"      "host: '${MG_CH_HOST}'"
  # 对拍报告落盘目录：仓库配置里写的是**生产**日志目录，本环境要落到自己的日志目录，
  # 否则报告写进不存在的路径（代码注释说明"写不进只记日志"，属静默失效）。
  subst "对拍报告目录"         1 "reportDir: /data/logs/production/clklog_manager/reconcile" \
                                 "reportDir: ${LOG_DIR}/reconcile"
  subst "MySQL 主机"           1 "host: 'mysql.internal'"      "host: '${MG_MYSQL_HOST}'"
  subst "MySQL 账号"           1 "username: 'root'"       "username: '${RUNTIME_DB_USER}'"
  subst "Redis 主机"           1 "host: 'redis.internal'"     "host: '${MG_REDIS_HOST}'"
  subst "Redis 口令"           1 "password: null"         "password: '${REDIS_PASSWORD}'"
  subst "Kafka 接入点"         1 "    - 'kafka.internal:9092'" "    - '${MG_KAFKA_BROKER}'"
  # AI Harness：默认关闭（测试环境不装运行时）。装了运行时（install-harness.sh 安装成功后
  # 写的 configs/harness.enabled 标记）或显式 HARNESS_ENABLED=1 时，保留仓库默认的
  # enabled: true。两种分支都走 subst（same-value 分支同样做命中数断言，保护模板不被改形）。
  if [ "${HARNESS_ENABLED:-0}" = "1" ] || [ -f "${BASE_DIR}/configs/harness.enabled" ]; then
    subst "AI Harness 开关"    1 "enabled: true"          "enabled: true"
  else
    subst "AI Harness 开关"    1 "enabled: true"          "enabled: false"
  fi
  printf '%s\n' "$content" > "$out"
  chmod 0644 "$out"
}

# ---------------------------------------------------------------- 数据库客户端

# MySQL：走宿主 127.0.0.1（native 与 docker 都先把端口映射到宿主，运维脚本不依赖容器网络）
# 宿主有 mysql 客户端就直接用；没有则走中间件容器内的客户端（本环境 MySQL 恒为容器，
# 刻意不额外安装宿主客户端，减少部署依赖面）。
mg_mysql_client() {
  if command -v mysql >/dev/null 2>&1; then
    MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --default-character-set=utf8mb4 \
      -h"${OPS_MYSQL_HOST}" -P"${OPS_MYSQL_PORT}" -uroot "$@"
  else
    docker exec -i -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" clklog-mysql \
      mysql --default-character-set=utf8mb4 -h127.0.0.1 -P3306 -uroot "$@"
  fi
}
mg_mysql() { mg_mysql_client "$@"; }
mg_mysql_db() { local db="$1"; shift; mg_mysql_client "$db" "$@"; }

# ClickHouse HTTP（写账号 default）。走宿主回环即可，不依赖容器名。
mg_ck() {
  curl -sS -m 60 --data-binary "$1" \
    "http://${OPS_CH_HOST}:${OPS_CH_PORT}/?user=default&password=$(printf '%s' "$CLICKHOUSE_PASSWORD" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read()))')"
}

# ---------------------------------------------------------------- 就绪等待

wait_http_code() {  # wait_http_code <url> <expected-regex> <timeout>
  local url="$1" want="$2" deadline=$(( $(date +%s) + ${3:-180} )) code
  while [ "$(date +%s)" -lt "$deadline" ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$url" 2>/dev/null || echo 000)"
    # 不能写成 `[[ ]] && return 0`：条件不成立时该语句返回非 0，set -e 会直接终止脚本
    if [[ "$code" =~ $want ]]; then return 0; fi
    sleep 3
  done
  return 1
}

# ---------------------------------------------------------------- nginx

# nginx 拓扑（重要）：
#   社区版 ClkLog 已占用 :80 的 default_server（/etc/nginx/conf.d/clklog-testenv.conf）。
#   /sa/ 必须与社区版路由落在**同一个 server 块**里才能按路径分流，所以 manager 不写自己的
#   server 块，而是写：
#     1) http 上下文的 map（WS/SSE 需要；map 不能放在 server 块内）
#     2) 一个 location 片段文件，放进被站点 server 块 include 的目录
#   站点 server 块里的 include 行由本脚本自动注入（幂等；注入前先备份）。
#   若宿主还没有任何 :80 站点（单独部署 manager），自动补一个最小站点块。
MGR_MAP_CONF="/etc/nginx/conf.d/candela-map.conf"
MGR_LOC_DIR="/etc/nginx/mgr-locations"
MGR_LOC_CONF="$MGR_LOC_DIR/sa.inc"   # 必须与 include 通配 *.inc 一致
MGR_SITE_CONF="/etc/nginx/conf.d/candela-site.conf"

_mgr_write_map_conf() {
  cat > "$MGR_MAP_CONF" <<'MAPCONF'
# 由 candela 部署脚本渲染：
# SSE(/plugins/events) 不能带 Connection: upgrade（HTTP/2 入口会被 RST），WS 才需要 upgrade。
map $http_upgrade $mg_harness_connection {
    default "";
    websocket upgrade;
}
MAPCONF
}

# 两种模式的静态资源语义不同，必须整份分开写：
#   native —— 宿主 nginx 直接读磁盘（root + try_files，缓存头在这里给）
#   docker —— 静态由 manager-web 容器提供（纯 proxy_pass；缓存头与 SPA 回退在容器里给）
# 混用（同一个 location 里既有 proxy_pass 又有 try_files）会按本地文件找而 404。
_mgr_write_locations_native() {
  local static_root="$1" api_upstream="$2"
  cat > "$MGR_LOC_CONF" <<NGINX
# 由 candela 部署脚本渲染（native 模式）。仅 location，由站点 server 块 include。
# 入口：http://<本机IP>/sa/
    # ---- 管理端 API ----
    location /sa/api/ {
        access_log /data/weblogs/candela.access.log main;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_pass http://${api_upstream};
    }

    # ---- Harness（本次未启用，配置预留）----
    location ~ ^/sa/harness/air_[A-Za-z0-9_-]+/[0-9]+\.[A-Za-z0-9_-]+/plugins/events {
        gzip off;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Connection "";
        proxy_set_header Upgrade "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        proxy_hide_header Content-Length;
        proxy_hide_header Content-Encoding;
        chunked_transfer_encoding on;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
        add_header X-Accel-Buffering no always;
        add_header Cache-Control "no-cache, no-store, no-transform" always;
        proxy_pass http://${api_upstream};
    }
    location /sa/harness/ {
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$mg_harness_connection;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
        proxy_pass http://${api_upstream};
    }

    # ---- 前端 SPA（构建 base=/sa/）----
    location /sa/assets/ {
        access_log /data/weblogs/candela.access.log main;
        root ${static_root};
        # gzip_static：产物里带 .gz 就直接发压缩版，不支持 gzip 的客户端自动回落原文件
        gzip_static on;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files \$uri =404;
    }
    location = /sa/index.html {
        root ${static_root};
        add_header Cache-Control "no-cache" always;
    }
    location = /login {
        return 302 /sa/login;
    }
    location /sa/ {
        access_log /data/weblogs/candela.access.log main;
        root ${static_root};
        gzip_static on;
        add_header Cache-Control "no-cache" always;
        try_files \$uri \$uri/ /sa/index.html;
    }
NGINX
}

_mgr_write_locations_docker() {
  local web_upstream="$1" api_upstream="$2"
  cat > "$MGR_LOC_CONF" <<NGINX
# 由 candela 部署脚本渲染（docker 模式）。静态资源由 manager-web 容器提供，
# 缓存头与 SPA 回退都在容器内完成，这里只做转发。
    # ---- 管理端 API ----
    location /sa/api/ {
        access_log /data/weblogs/candela.access.log main;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_pass http://${api_upstream};
    }

    # ---- Harness（未启用，配置预留）----
    location /sa/harness/ {
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$mg_harness_connection;
        proxy_buffering off;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
        proxy_pass http://${api_upstream};
    }

    # ---- 前端 SPA ----
    location /sa/ {
        access_log /data/weblogs/candela.access.log main;
        proxy_set_header Host \$host;
        proxy_pass http://${web_upstream};
    }
    location = /login {
        return 302 /sa/login;
    }
NGINX
}

# 确保站点 server 块 include 了 manager 的 location 目录
_mgr_ensure_site_include() {
  local site has=0
  for site in /etc/nginx/conf.d/*.conf; do
    [ "$site" = "$MGR_MAP_CONF" ] && continue
    [ "$site" = "$MGR_SITE_CONF" ] && continue
    grep -q "listen 80" "$site" 2>/dev/null || continue
    grep -qE "^\s*server\s*\{" "$site" 2>/dev/null || continue
    has=1
    if ! grep -q "mgr-locations" "$site"; then
      cp -n "$site" "$site.bak-$(date +%Y%m%d%H%M%S)"
      sed -i "0,/^\(\s*server[[:space:]]*{\)/s||\1\n    include ${MGR_LOC_DIR}/*.inc;|" "$site"
      log "已向现有站点注入 include：$site"
    fi
    break
  done
  if [ "$has" -eq 0 ]; then
    cat > "$MGR_SITE_CONF" <<SITECONF
# 无既有站点时由脚本创建的最小站点块（单独部署 manager 场景）
server {
    listen 80 default_server;
    server_name _;
    include ${MGR_LOC_DIR}/*.inc;
}
SITECONF
    log "未发现现有站点，已创建：$MGR_SITE_CONF"
  fi
}

render_nginx_and_reload() {
  local mode="$1" static_root="${2:-}" web_upstream="${3:-}" api_upstream="${4:-127.0.0.1:3100}"
  mkdir -p "$MGR_LOC_DIR" /data/weblogs
  _mgr_write_map_conf
  if [ "$mode" = "native" ]; then
    _mgr_write_locations_native "$static_root" "$api_upstream"
  else
    _mgr_write_locations_docker "$web_upstream" "$api_upstream"
  fi
  _mgr_ensure_site_include
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx 2>/dev/null || systemctl restart nginx
    log "nginx 已生效：$MGR_LOC_CONF（入口 http://<本机IP>/sa/）"
  else
    nginx -t || true
    die "nginx 配置校验失败，未 reload（已有服务未受影响）"
  fi
}
