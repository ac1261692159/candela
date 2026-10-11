#!/usr/bin/env bash
# deploy-native.sh — candela「常规方案」部署（宿主 Node + supervisord，幂等）
#
# 形态（与生产 HANDOVER 描述同构，去掉 Puppet/CI 依赖）：
#   宿主 Node 24.20.0 → supervisord 拉起 candela_server / candela_ingestor
#   → 宿主 nginx 提供 /sa/ 静态与 /sa/api/ 反代 → 数据库初始化（MySQL + ClickHouse）
#
# 企业级要素：
#   * 版本化发布：releases/<时间戳>/ + current/previous 软链，切换与回滚原子
#   * 构建期生成 Prisma Client（不再在启动命令里 npx prisma generate —— 那会让启动依赖 npm 网络）
#   * 密钥只落 /data/app/candela/configs/.env（0600），supervisor ini 里不出现任何口令
#   * 就绪判定打到真实端口，不拿「进程在跑」当就绪
#   * 幂等：可反复执行；口令首次生成后不再变；库表 IF NOT EXISTS
#
# 用法：
#   bash deploy-native.sh              # 全流程（构建 + 初始化 + 启动 + nginx）
#   bash deploy-native.sh --skip-build # 跳过构建（复用上次构建产物，仅重发配置/重启）
#
# 前置：中间件层已就绪（scripts/standalone-test-env/deploy-middleware.sh）

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

SKIP_BUILD=0
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=1

require_root
init_env_file
load_manager_secrets
set_endpoints native   # 宿主进程直连 127.0.0.1

CFG_DIR="$BASE_DIR/configs"
SERVICE_ENV="$ENV_FILE"          # 密钥与服务 env 合并为一份（见 lib.sh）
STABLE_CONFIG="$CFG_DIR/config.yaml"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

log "=============================================================="
log " Candela 常规方案部署（native + supervisord）"
log " BASE_DIR=$BASE_DIR  RELEASES=$RELEASES_DIR"
log "=============================================================="

# ---------------------------------------------------------------- 0. 前置检查
command -v nginx >/dev/null 2>&1 || die "未安装 nginx（请先执行 scripts/standalone-test-env/deploy-clklog.sh 或 dnf install nginx）"
for c in clklog-mysql clklog-clickhouse clklog-redis clklog-kafka; do
  [ "$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" = "running" ] || die "中间件容器 $c 未运行，请先执行 scripts/standalone-test-env/deploy-middleware.sh"
done
for hp in "$MG_MYSQL_HOST:$MG_MYSQL_PORT" "$MG_CH_HOST:$MG_CH_PORT" "$MG_REDIS_HOST:$MG_REDIS_PORT"; do
  wait_tcp "${hp%%:*}" "${hp##*:}" 20 || die "依赖不可达：$hp"
done
log "前置检查通过：nginx / 中间件容器 / MySQL / ClickHouse / Redis 均可达"

# 互斥：docker 方案与常规方案都占用 :3100 与 /sa/ 路由，不能同时跑
if docker ps --format '{{.Names}}' | grep -q '^candela-server$'; then
  log "检测到 docker 方案容器仍在运行（同端口/同路由）→ 先停掉"
  docker compose -f "$BASE_DIR/docker/docker-compose.yml" stop manager-server manager-ingestor manager-web >/dev/null 2>&1 || \
    docker stop candela-server candela-ingestor candela-web >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------- 1. Node 24
# 安装实现已提到共享库 lib.sh（install-harness.sh 与 docker 形态同样需要宿主 Node）。
# 版本与 SHA256 与生产 puppet/clklog/files/install-node24.sh 一致，保证行为一致。
ensure_node24
export PATH="$NODE_BIN:$PATH"

# ---------------------------------------------------------------- 2. supervisord
# AlmaLinux 9 主仓库没有 supervisor，来自 EPEL（用阿里云镜像，避免官方域名不可解析）
ensure_supervisor() {
  if command -v supervisord >/dev/null 2>&1; then
    systemctl is-active --quiet supervisord || systemctl enable --now supervisord
    log "supervisord 已就绪：$(supervisord -v 2>/dev/null || echo ok)"
    return 0
  fi
  if [ ! -f /etc/yum.repos.d/epel.repo ]; then
    log "安装 EPEL 源（supervisor 依赖）"
    if ! dnf -y install https://mirrors.aliyun.com/epel/epel-release-latest-9.noarch.rpm >/dev/null; then
      dnf -y install https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm >/dev/null \
        || die "EPEL 源安装失败"
    fi
    sed -i 's|^#\?baseurl=https://download.example/pub/epel|baseurl=https://mirrors.aliyun.com/epel|; s|^metalink=|#metalink=|' /etc/yum.repos.d/epel*.repo 2>/dev/null || true
  fi
  # dnf 的 makecache 定时任务会与本次安装争仓库锁，而 EPEL 元数据体积大、下载慢，
  # 观察到过「install 干等锁数分钟」。这里做有界等待：超时则临时停掉该定时任务再装。
  local waited=0
  while pgrep -f "dnf makecache" >/dev/null 2>&1; do
    if [ "$waited" -eq 0 ]; then log "  等待 dnf 元数据缓存任务结束（最多 300s）..."; fi
    [ "$waited" -ge 300 ] && { warn "缓存任务超时未结束，临时停止 dnf-makecache.timer"; systemctl stop dnf-makecache.timer >/dev/null 2>&1 || true; pkill -f "dnf makecache" >/dev/null 2>&1 || true; sleep 3; break; }
    sleep 10; waited=$((waited+10))
  done
  dnf -y install supervisor >/dev/null || die "supervisor 安装失败"
  systemctl enable --now supervisord
  log "supervisord 安装完成"
}
ensure_supervisor
mkdir -p "$SUPERVISOR_DIR"
if ! grep -qE "^\s*files\s*=.*${SUPERVISOR_DIR}" /etc/supervisord.conf 2>/dev/null; then
  grep -q "^\[include\]" /etc/supervisord.conf || printf '\n[include]\nfiles = %s/*.ini\n' "$SUPERVISOR_DIR" >> /etc/supervisord.conf
  sed -i "s|^files\s*=.*|files = ${SUPERVISOR_DIR}/*.ini|" /etc/supervisord.conf
  systemctl restart supervisord
  log "已在 supervisord.conf 注册 $SUPERVISOR_DIR"
fi

# ---------------------------------------------------------------- 3. 构建
if [ "$SKIP_BUILD" -eq 0 ]; then
  [ -d "$SRC_SERVER" ] || die "缺少源码：$SRC_SERVER（请先用 deploy-remote.sh 推送源码）"
  export npm_config_registry="$NPM_REGISTRY"
  export npm_config_cache="$BASE_DIR/.npm-cache"
  export npm_config_fund=false npm_config_audit=false
  # npm ci 只在 package-lock 变化时执行（重跑/改配置不该重装一遍依赖）
  npm_ci_if_needed() {
    local dir="$1" h
    h="$(sha256sum "$dir/package-lock.json" | cut -d' ' -f1)"
    if [ -d "$dir/node_modules" ] && [ "$(cat "$dir/node_modules/.clklog-lock-hash" 2>/dev/null)" = "$h" ]; then
      log "  依赖未变化，跳过 npm ci：$(basename "$dir")"
      return 0
    fi
    log "  安装依赖（npm ci）：$(basename "$dir")"
    ( cd "$dir" && npm ci --no-audit --no-fund >/dev/null ) || return 1
    printf '%s' "$h" > "$dir/node_modules/.clklog-lock-hash"
  }

  log "构建后端（registry=$NPM_REGISTRY）"
  npm_ci_if_needed "$SRC_SERVER" || die "后端依赖安装失败"
  ( cd "$SRC_SERVER" && npx prisma generate >/dev/null && npm run build >/dev/null )
  log "构建前端（base=/sa/）"
  npm_ci_if_needed "$SRC_WEB" || die "前端依赖安装失败"
  # 与 CI 一致：先把 examples/report-sdk 打包成 public/sdk-demos/*.zip，再由 vite 拷进产物
  # （缺这一步时 onboarding 页的示例下载按钮会因文件缺失自动隐藏，不报错但功能缺失）
  if [ -x "$SRC_DIR/scripts/build-sdk-demos.sh" ] && [ -d "$SRC_DIR/examples/report-sdk" ]; then
    bash "$SRC_DIR/scripts/build-sdk-demos.sh" >/dev/null || warn "sdk-demos 生成失败（不影响主流程）"
  fi
  ( cd "$SRC_WEB" && npm run build >/dev/null )
  [ -f "$SRC_SERVER/dist/main.js" ] || [ -f "$SRC_SERVER/dist/src/main.js" ] \
    || die "后端构建产物缺失（dist/main.js 与 dist/src/main.js 都不存在）"
  # vite 产出 dist/{index.html,assets,...}；/sa/ 层级由下面的组装步骤创建（同 CI build.sh）
  [ -f "$SRC_WEB/dist/index.html" ] || die "前端构建产物缺失：dist/index.html"
  log "构建完成"
else
  log "跳过构建（--skip-build）"
fi

# ---------------------------------------------------------------- 4. 配置与密钥
mkdir -p "$CFG_DIR" "$LOG_DIR" "$RELEASES_DIR" "$LOG_DIR/reconcile"
render_config_yaml "$SRC_SERVER/config_server.yaml" "$STABLE_CONFIG"
write_service_env
log "配置已渲染：$STABLE_CONFIG（差异项已断言命中）+ 密钥：$SERVICE_ENV（0600）"

# ---------------------------------------------------------------- 5. 发布目录
# 内容哈希判定：源码/产物与配置都没变时，复用当前发布，不产生新版本、不重启服务。
# （企业级重跑应当是"零动作"，而不是每次都造一个内容相同的版本目录。）
hash_tree() {
  # 先校验入参存在：find 对不存在的路径会非 0 退出，若把 stderr 吞掉 + set -o pipefail，
  # 表现是"脚本静默退出、没有任何报错"（2026-10-10 实测踩到，靠 bash -x 才定位到）。
  local p
  for p in "$@"; do [ -e "$p" ] || die "内容哈希入参不存在：$p（源码布局与脚本预期不一致）"; done
  find "$@" -type f ! -name '*.gz' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
}
CODE_HASH="$(hash_tree "$SRC_SERVER/dist" "$SRC_SERVER/prisma/schema.prisma" "$SRC_WEB/dist")"
CONFIG_HASH="$(sha256sum "$STABLE_CONFIG" "$SERVICE_ENV" | sha256sum | cut -d' ' -f1)"
RELEASE_HASH="$CODE_HASH"
CUR_CODE_HASH=""; CUR_CONFIG_HASH=""
if [ -f "$CURRENT_LINK/.release-meta" ]; then
  CUR_CODE_HASH="$(sed -n 's/^code=//p' "$CURRENT_LINK/.release-meta")"
  CUR_CONFIG_HASH="$(sed -n 's/^config=//p' "$CURRENT_LINK/.release-meta")"
fi

if [ "$CODE_HASH" = "$CUR_CODE_HASH" ] && [ "$CONFIG_HASH" = "$CUR_CONFIG_HASH" ]; then
  log "代码与配置均未变化（code=${CODE_HASH:0:12}）→ 复用当前发布，跳过发布与重启"
  REL="$(readlink -f "$CURRENT_LINK")"
  REUSE_RELEASE=1
else
  REUSE_RELEASE=0
  TS="$(date +%Y%m%d%H%M%S)"
  REL="$RELEASES_DIR/$TS"
  log "创建发布目录 $REL（code=${CODE_HASH:0:12} config=${CONFIG_HASH:0:12}）"
fi

if [ "$REUSE_RELEASE" -eq 0 ]; then
mkdir -p "$REL/server" "$REL/ingestor" "$REL/web"
# 后端：server 与 ingestor 共用同一份 dist（生产同构：同一 AppModule，两个入口）
ENTRY_PREFIX="$(dist_entry_prefix "$SRC_SERVER/dist")"
log "  产物布局：dist/${ENTRY_PREFIX:+$ENTRY_PREFIX/}main.js"
cp -r "$SRC_SERVER/dist" "$REL/server/dist"
cp -r "$SRC_SERVER/prisma" "$REL/server/prisma"
cp "$SRC_SERVER/package.json" "$SRC_SERVER/package-lock.json" "$REL/server/"
mkdir -p "$REL/server/configs"
# node_modules 用软链共享构建工作区（单应用部署，依赖与 schema 同版本；回滚只需切软链）
ln -sfn "$SRC_SERVER/node_modules" "$REL/server/node_modules"
ln -sfn "$STABLE_CONFIG" "$REL/server/configs/config.yaml"
ln -sfn "$SERVICE_ENV" "$REL/server/.env"
# ingestor 目录：同一份产物，单独目录便于独立重启（与生产的两单元隔离一致）
ln -sfn "$REL/server/dist" "$REL/ingestor/dist"
ln -sfn "$SRC_SERVER/node_modules" "$REL/ingestor/node_modules"
ln -sfn "$REL/server/prisma" "$REL/ingestor/prisma"
cp "$SRC_SERVER/package.json" "$REL/ingestor/"
mkdir -p "$REL/ingestor/configs"
ln -sfn "$STABLE_CONFIG" "$REL/ingestor/configs/config.yaml"
ln -sfn "$SERVICE_ENV" "$REL/ingestor/.env"
# 前端静态：与 CI scripts/build.sh 同构
#   web/sa/        ← vite dist（base=/sa/，产物自带 /sa/ 层级，nginx root 指 web 即可命中）
#   web/index.html ← dist/index.html 的副本，供 SPA 回退
#   *.gz           预压缩（宿主 nginx 开 gzip_static on：2026-09-19 线上事故后生产的做法，
#                  入口分片 1.13MB → 357KB，客户端不支持 gzip 时自动回落原文件）
mkdir -p "$REL/web/sa"
cp -r "$SRC_WEB/dist/." "$REL/web/sa/"
cp "$SRC_WEB/dist/index.html" "$REL/web/index.html"
if command -v gzip >/dev/null 2>&1; then
  find "$REL/web" -type f \( -name '*.js' -o -name '*.css' -o -name '*.svg' -o -name '*.json' -o -name '*.html' \) \
    -size +1k ! -name '*.gz' -exec gzip -kf -9 {} \;
  log "  已预压缩静态资源（$(find "$REL/web" -name '*.gz' | wc -l) 个 .gz）"
fi

# current/previous 原子切换
# 静态资源要由 nginx(nginx 用户) 读取：显式放开读+目录执行位，不依赖 umask
chmod -R a+rX "$REL/web" "$REL/server/dist" 2>/dev/null || true
if [ -L "$CURRENT_LINK" ]; then
  ln -sfn "$(readlink "$CURRENT_LINK")" "$PREVIOUS_LINK"
fi
ln -sfn "$REL" "$CURRENT_LINK"
log "已切换到 current → $REL（previous → $(readlink "$PREVIOUS_LINK" 2>/dev/null || echo 无)）"

printf 'code=%s\nconfig=%s\n' "$CODE_HASH" "$CONFIG_HASH" > "$REL/.release-meta"

# 只保留最近 3 个发布
ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | tail -n +4 | while read -r old; do
  rm -rf "$old"; log "  清理旧发布：$old"
done
fi   # end REUSE_RELEASE=0

# ---------------------------------------------------------------- 6. 数据库初始化
log "初始化数据库（MySQL + ClickHouse）"
bash "$SELF_DIR/init-db-mysql.sh" --runner host
bash "$SELF_DIR/init-db-clickhouse.sh" --runner host

# ---------------------------------------------------------------- 7. supervisord 程序
# 口令不进 supervisor 配置：命令里 source 固定的 .env（比生产用 %(ENV_)s 更不容易漏配）
write_program() {
  local name="$1" workdir="$2" entry="$3" logfile="$4"
  cat > "$SUPERVISOR_DIR/${name}.ini" <<INI
; 由 deploy-native.sh 渲染（candela 常规方案）
; 密钥来源：$SERVICE_ENV（0600），命令内 source，不写在下方 environment 里
[program:${name}]
autorestart=True
autostart=True
redirect_stderr=True
; 优雅关闭宽限：SSE 长连接会把关闭拖过默认 10s（2026-09-18 事故）
stopwaitsecs=25
command=/bin/bash -c 'set -a; . ${SERVICE_ENV}; set +a; export APP_CONFIG_PATH=${STABLE_CONFIG} NODE_ENV=production TZ=UTC; cd ${workdir} && exec ${NODE_BIN}/node ${entry}'
user=root
directory=${workdir}
stdout_logfile=${LOG_DIR}/${logfile}
stdout_logfile_maxbytes=20MB
stdout_logfile_backups=20
INI
}
SUPERVISOR_RESTART=1
if [ "$REUSE_RELEASE" -eq 1 ]; then
  # 代码与配置都没变：不重写 ini、不重启，只做 DB 幂等检查与就绪复核。
  # 例外：程序不在 RUNNING（被手工停止，或崩溃后停在 FATAL）时必须显式拉起——
  # reread/update 不会启动「配置无变化」的停止程序（2026-10-10 实测踩到）。
  if grep -q "$CURRENT_LINK/server" "$SUPERVISOR_DIR/candela_server.ini" 2>/dev/null; then
    log "supervisor 程序未变化，跳过重写与重启"
    SUPERVISOR_RESTART=0
    for p in candela_server candela_ingestor; do
      state="$(supervisorctl status "$p" 2>/dev/null | awk '{print $2}' || true)"
      if [ "$state" != "RUNNING" ]; then
        log "  检测到 $p 状态为 ${state:-未注册} → 拉起"
        supervisorctl start "$p" >/dev/null 2>&1 || true
      fi
    done
  fi
fi

write_program candela_server   "$CURRENT_LINK/server"   "dist/${ENTRY_PREFIX:+$ENTRY_PREFIX/}main.js"                "analytics-server.log"
write_program candela_ingestor "$CURRENT_LINK/ingestor" "dist/${ENTRY_PREFIX:+$ENTRY_PREFIX/}scripts/run-ingestor.js" "analytics-ingestor.log"
# 注意：supervisor 在解析 ini 时会展开软链，current 切换后需要 reread+update 才生效
log "supervisor 程序已写入 $SUPERVISOR_DIR"

# ---------------------------------------------------------------- 8. nginx
render_nginx_and_reload native "$CURRENT_LINK/web" "" "127.0.0.1:3100"

# ---------------------------------------------------------------- 9. 启动与就绪
if [ "${SUPERVISOR_RESTART:-1}" -eq 1 ]; then
  supervisorctl reread >/dev/null
  supervisorctl update >/dev/null
  # 必须显式 restart，不能只靠 reread/update：ini 里的工作目录恒为 current 软链（内容恒定），
  # supervisor 因此认为「配置无变化」不做动作——新 release / 新渲染的 config.yaml 都不会生效
  # （2026-10-10 实测：config.yaml 已改 enabled=true，但进程 uptime 未变、平台仍是旧配置）。
  # restart 对 STOPPED 的程序等价 start，故同时修复了「程序被停止后重跑部署不拉起来」。
  supervisorctl restart candela_server candela_ingestor >/dev/null 2>&1 \
    || supervisorctl start candela_server candela_ingestor >/dev/null
  log "已重启 candela_server / candela_ingestor，等待就绪"
else
  log "跳过 supervisor 重启（进程保持运行）"
fi
# /sa/api/health 受 AuthGuard 保护：未带 token 返回 401，能返回 401 就说明服务已监听
if wait_http_code "http://127.0.0.1:3100/sa/api/health" '^(200|401|403)$' 240; then
  log "  服务已就绪：GET /sa/api/health → $({ curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3100/sa/api/health; })"
else
  warn "  服务未在超时内监听端口，请查 $LOG_DIR/analytics-server.log"
fi
if wait_http_code "http://127.0.0.1/sa/" '^200$' 60; then
  log "  经 nginx 可达：http://<本机IP>/sa/ → 200"
else
  warn "  经 nginx 访问异常，请查 /data/weblogs/candela.access.err.log"
fi

# ---------------------------------------------------------------- 10. 汇总
IP="$(hostname -I | awk '{print $1}')"
log "--------------------------------------------------------------"
log "常规方案部署完成"
log "  入口       http://${IP}/sa/          （分析平台，登录 admin / 见 $ENV_FILE 的 ADMIN_INIT_PASSWORD）"
log "  社区版入口 http://${IP}/             （ClkLog 社区版，admin / clklog）"
log "  进程       supervisorctl status candela_server candela_ingestor"
log "  日志       $LOG_DIR/"
log "  回滚       切 previous 软链后 supervisorctl restart："
log "             ln -sfn \$(readlink $PREVIOUS_LINK) $CURRENT_LINK && supervisorctl restart candela_server candela_ingestor"
log "  下一步      bash $SELF_DIR/verify.sh"
log "--------------------------------------------------------------"
