#!/usr/bin/env bash
# install-harness.sh — 测试环境 AI Harness 运行时的安装/更新（幂等）
#
# phase: standalone-test-env-harness-v1
# 设计见 docs/architecture/standalone-test-env-harness-design.md
#
# 与生产 ops/install-harness-runtime.sh 同一套运行时契约（用户/目录/broker 配置/socket 路径
# /supervisor 单元名都一致），但适配 standalone 布局：
#   * 生产脚本依赖的 ops/install-harness-user.sh、install-node24.sh、
#     install-analytics-node24-supervisor.sh 三个文件未随仓库迁移，本脚本内联它们的职责；
#   * release 用内容哈希目录（生产用发版号），哈希未变即复用；
#   * broker 日志落 standalone 的日志目录；不触碰 candela_server/ingestor 单元。
#
# 做什么：
#   1. harness 系统用户 + /home/harness/clklog-ai 目录树（含 rootless podman 的 subuid/subgid/linger）
#   2. /opt/clklog/harness/releases/<内容哈希>/{host,broker} + current 软链（host 执行 npm ci）
#   3. /etc/clklog/harness-broker.json + supervisor 单元 clklog_harness_broker
#   4. rootless podman 的 registry 镜像源（podman 不读 docker 配置）与基础镜像拉取
#   5. ai_workspace 种子（复用 scripts/ai-workspace-sync.sh init，只补缺失）
#   6. 启动 broker 并探活 socket；成功后写 configs/harness.enabled 标记
#
# 用法（目标机上，root；前置：平台已部署、源码已 push）：
#   bash install-harness.sh            # 安装/更新并启动
#   bash install-harness.sh --status   # 只看现状（只读）
#
# 首次启用后还需重渲染配置让平台打开开关：
#   HARNESS_ENABLED=1 bash deploy-native.sh --skip-build

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

ACTION="install"
[ "${1:-}" = "--status" ] && ACTION="status"

CFG="$BASE_DIR/configs/config.yaml"
SRC_HOST="$SRC_DIR/apps/analytics-harness-host"
SRC_BROKER="$SRC_DIR/apps/analytics-harness-broker"
SYNC_SH="$SRC_DIR/scripts/ai-workspace-sync.sh"
BROKER_UNIT_SRC="$SRC_DIR/scripts/supervisord-harness-broker.conf"
INSTALL_ROOT="/opt/clklog/harness"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
HARNESS_MARKER="$BASE_DIR/configs/harness.enabled"

# 从 config.yaml 的 deepseek_harness 段取四级键（与生产 install-harness-runtime.sh 同一解析口径）。
# 剥引号用八进制 \047（' ）写法：gawk 对字符类里的 \" 会告警刷屏（2026-10-10 实测）。
yaml_value() {  # $1=section(runtime|workspace)  $2=key
  awk -v section="$1" -v key="$2" '
    /^  [a-z_]+:/ { current = $1; sub(":$", "", current) }
    current == section && $0 ~ "^    " key ":" {
      value = $0
      sub("^    " key ":[[:space:]]*", "", value)
      gsub(/^["\047]|["\047]$/, "", value)
      print value
      exit
    }
  ' "$CFG"
}

if [ "$ACTION" = "status" ]; then
  HARNESS_USER="$(yaml_value runtime linux_user)"
  echo "=== Harness 现状（只读）==="
  id "$HARNESS_USER" 2>/dev/null || echo "用户：不存在"
  RUNTIME_ROOT="$(getent passwd "$HARNESS_USER" | cut -d: -f6)/$(yaml_value runtime home_subdir)"
  ls -ld "$RUNTIME_ROOT" "$RUNTIME_ROOT/gateway/control" "$RUNTIME_ROOT/ai_workspace/default" 2>/dev/null || true
  ls -l /opt/clklog/harness/current 2>/dev/null || echo "release：未安装"
  supervisorctl status clklog_harness_broker 2>/dev/null || echo "broker 单元：不存在"
  [ -f "$HARNESS_MARKER" ] && echo "标记：$HARNESS_MARKER（$(cat "$HARNESS_MARKER" | tr '\n' ' ')）" || echo "标记：无（部署渲染时 enabled=false）"
  grep -n "enabled: " "$CFG" 2>/dev/null | head -2
  exit 0
fi

require_root
[ -f "$CFG" ] || die "缺少 $CFG（请先完成平台部署：bash $SELF_DIR/deploy-native.sh）"
command -v podman >/dev/null 2>&1 || die "未安装 podman（dnf -y install podman 后重试）"
[ -d "$SRC_HOST" ] || die "缺少 harness-host 源码：$SRC_HOST（请先 push 源码）"
[ -d "$SRC_BROKER" ] || die "缺少 harness-broker 源码：$SRC_BROKER"
[ -f "$BROKER_UNIT_SRC" ] || die "缺少 supervisor 单元模板：$BROKER_UNIT_SRC（请先 push）"
# docker 形态不装宿主 Node，但 broker 由宿主 supervisor 拉起、workspace 用宿主 npm → 这里自备
ensure_node24 >/dev/null

HARNESS_USER="$(yaml_value runtime linux_user)"
HOME_SUBDIR="$(yaml_value runtime home_subdir)"
CONTAINER_IMAGE="$(yaml_value runtime container_image)"
MAX_RUNTIMES="$(yaml_value runtime max_runtimes)"
MAX_WS_BYTES="$(yaml_value workspace max_bytes)"
[ -n "$HARNESS_USER" ] && [ -n "$HOME_SUBDIR" ] && [ -n "$CONTAINER_IMAGE" ] \
  || die "config.yaml 的 deepseek_harness 段不完整（先检查 $CFG）"
[[ "$HARNESS_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] && [ "$HARNESS_USER" != root ] || die "非法 runtime.linux_user：$HARNESS_USER"

export PATH="$NODE_BIN:$PATH"

log "=============================================================="
log " AI Harness 运行时安装（user=$HARNESS_USER, image=$CONTAINER_IMAGE）"
log "=============================================================="

# ---------------------------------------------------------------- 1. 用户与目录
HARNESS_HOME="/home/$HARNESS_USER"
if id "$HARNESS_USER" >/dev/null 2>&1; then
  HARNESS_HOME="$(getent passwd "$HARNESS_USER" | cut -d: -f6)"
  log "用户已存在：$HARNESS_USER（home=$HARNESS_HOME）"
else
  log "创建系统用户 $HARNESS_USER"
  useradd -m -d "$HARNESS_HOME" -s /sbin/nologin "$HARNESS_USER"
fi
HARNESS_UID="$(id -u "$HARNESS_USER")"
HARNESS_GID="$(id -g "$HARNESS_USER")"

# home 自身必须存在且归 harness：teardown 删的是 /home/harness 目录而保留用户，
# 重建时它会被 install -d 当作"中间父目录"建成 root:root → rootless podman 以 harness
# 身份运行时连 ~/.config 都建不了（2026-10-10 实测：podman 报 stat ~/.config 失败）。
install -d -o "$HARNESS_USER" -g "$HARNESS_USER" -m 0700 "$HARNESS_HOME"

# rootless podman 必需：subuid/subgid 映射与 linger（无 linger 时用户会话结束容器被杀）
if ! grep -q "^${HARNESS_USER}:" /etc/subuid 2>/dev/null; then
  usermod --add-subuids 100000-165535 "$HARNESS_USER"
  log "  已分配 subuid 100000-165535"
fi
if ! grep -q "^${HARNESS_USER}:" /etc/subgid 2>/dev/null; then
  usermod --add-subgids 100000-165535 "$HARNESS_USER"
  log "  已分配 subgid 100000-165535"
fi
loginctl enable-linger "$HARNESS_USER" >/dev/null 2>&1 \
  && log "  已启用 linger" || warn "enable-linger 失败（rootless podman 可能不稳）"

cat > /etc/tmpfiles.d/clklog-harness.conf <<EOF
d /run/user/${HARNESS_UID} 0700 ${HARNESS_USER} ${HARNESS_USER} -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/clklog-harness.conf 2>/dev/null || true

RUNTIME_ROOT="$HARNESS_HOME/$HOME_SUBDIR"
install -d -o "$HARNESS_USER" -g "$HARNESS_USER" -m 0700 \
  "$RUNTIME_ROOT" \
  "$RUNTIME_ROOT/initialization" \
  "$RUNTIME_ROOT/ai_workspace" \
  "$RUNTIME_ROOT/ai_workspace/app" \
  "$RUNTIME_ROOT/runtimes" \
  "$RUNTIME_ROOT/workspaces" \
  "$RUNTIME_ROOT/rt" \
  "$RUNTIME_ROOT/gateway" \
  "$RUNTIME_ROOT/gateway/control" \
  "$RUNTIME_ROOT/gateway/runtime"
install -d -o root -g root -m 0755 "$LOG_DIR"
log "目录树就绪：$RUNTIME_ROOT"

# ---------------------------------------------------------------- 2. 运行时 release（内容哈希，幂等）
hash_tree() {
  ( cd "$1" && find . -type f ! -path './node_modules/*' ! -name '.DS_Store' -print0 \
      | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1 )
}
REL_HASH="$( { hash_tree "$SRC_HOST"; hash_tree "$SRC_BROKER"; } | sha256sum | cut -d' ' -f1 | cut -c1-12 )"
REL_DIR="$INSTALL_ROOT/releases/$REL_HASH"
if [ -f "$REL_DIR/.ready" ]; then
  log "release 已存在且内容未变（$REL_HASH），复用"
else
  log "组装 release $REL_HASH → $REL_DIR（host 执行 npm ci，registry=$NPM_REGISTRY）"
  rm -rf "$REL_DIR"
  mkdir -p "$REL_DIR/host" "$REL_DIR/broker"
  rsync -a --exclude node_modules --exclude '.git' --exclude '.DS_Store' "$SRC_HOST/" "$REL_DIR/host/"
  rsync -a --exclude node_modules --exclude '.git' --exclude '.DS_Store' "$SRC_BROKER/" "$REL_DIR/broker/"
  ( cd "$REL_DIR/host" \
      && npm_config_registry="$NPM_REGISTRY" npm_config_fund=false npm_config_audit=false \
         npm ci --omit=dev --ignore-scripts >/dev/null )
  chown -R root:root "$REL_DIR"
  find "$REL_DIR" -type d -exec chmod 0755 {} +
  find "$REL_DIR" -type f -exec chmod 0644 {} +
  touch "$REL_DIR/.ready"
fi
install -d -m 0755 "$INSTALL_ROOT"
ln -sfn "$REL_DIR" "$INSTALL_ROOT/current"
log "  已切换 current → $REL_DIR"

# ---------------------------------------------------------------- 3. broker 配置与 supervisor 单元
install -d -o root -g "$HARNESS_USER" -m 0750 /etc/clklog
BROKER_JSON="/etc/clklog/harness-broker.json"
cat > "${BROKER_JSON}.next" <<JSON
{
  "schema_version": 1,
  "root": "$RUNTIME_ROOT",
  "harness_host": "$INSTALL_ROOT/current/host",
  "podman_path": "/usr/bin/podman",
  "container_image": "$CONTAINER_IMAGE",
  "max_runtimes": $MAX_RUNTIMES,
  "max_workspace_bytes": $MAX_WS_BYTES
}
JSON
chown root:"$HARNESS_USER" "${BROKER_JSON}.next"
chmod 0640 "${BROKER_JSON}.next"
mv -f "${BROKER_JSON}.next" "$BROKER_JSON"
log "broker 配置就绪：$BROKER_JSON"

# 渲染单元：@@HARNESS_*@@ 占位符 + 日志路径改 standalone（模板里是生产的 clklog_manager 目录）
sed \
  -e "s|@@HARNESS_USER@@|${HARNESS_USER}|g" \
  -e "s|@@HARNESS_HOME@@|${HARNESS_HOME}|g" \
  -e "s|@@HARNESS_UID@@|${HARNESS_UID}|g" \
  -e "s|/data/logs/production/clklog_manager|${LOG_DIR}|g" \
  "$BROKER_UNIT_SRC" > "$SUPERVISOR_DIR/clklog-harness-broker.ini"
chmod 0644 "$SUPERVISOR_DIR/clklog-harness-broker.ini"
log "supervisor 单元就绪：$SUPERVISOR_DIR/clklog-harness-broker.ini"

# ---------------------------------------------------------------- 4. 镜像源与基础镜像
# podman 不读 docker 的 registry-mirrors：给等价镜像源，否则 docker.io 直连必失败
install -d -m 0755 /etc/containers/registries.conf.d
cat > /etc/containers/registries.conf.d/999-candela-harness.conf <<'REG'
# 由 install-harness.sh 渲染：podman 的镜像源（与 docker daemon 的 registry-mirrors 等价）
unqualified-search-registries = ["docker.io"]

[[registry]]
location = "docker.io"

[[registry.mirror]]
location = "hub.rat.dev"

[[registry.mirror]]
location = "docker.m.daocloud.io"
REG

podman_as_harness() {
  # cwd 必须在 harness 可进入的目录（runuser 继承 cwd；停在 /root 会失败）
  ( cd "$HARNESS_HOME" && /usr/sbin/runuser -u "$HARNESS_USER" -- env \
      HOME="$HARNESS_HOME" \
      XDG_RUNTIME_DIR="/run/user/${HARNESS_UID}" \
      PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
      /usr/bin/podman "$@" )
}
if podman_as_harness image exists "$CONTAINER_IMAGE" >/dev/null 2>&1; then
  log "runtime 镜像已存在（$CONTAINER_IMAGE），跳过拉取"
else
  log "拉取 runtime 镜像（rootless，$CONTAINER_IMAGE）"
  podman_as_harness pull "$CONTAINER_IMAGE" >/dev/null || die "镜像拉取失败：$CONTAINER_IMAGE（检查 /etc/containers/registries.conf.d/999-candela-harness.conf）"
fi

# ---------------------------------------------------------------- 5. AI 工作区种子
if [ -x "$SYNC_SH" ]; then
  HARNESS_USER="$HARNESS_USER" RUNTIME_ROOT="$RUNTIME_ROOT" \
    bash "$SYNC_SH" init --from-release "$SRC_DIR" || warn "ai_workspace init 失败（不阻断安装，可手工重跑）"
else
  warn "缺少 $SYNC_SH，跳过 ai_workspace 初始化"
fi

# ---------------------------------------------------------------- 6. 启动与探活
supervisorctl reread >/dev/null
supervisorctl update >/dev/null
supervisorctl restart clklog_harness_broker >/dev/null 2>&1 || supervisorctl start clklog_harness_broker >/dev/null

SOCKET="$RUNTIME_ROOT/gateway/control/broker.sock"
ready=0
for _ in $(seq 1 30); do
  if [ -S "$SOCKET" ] && curl -s -m 3 --unix-socket "$SOCKET" http://localhost/v1/health 2>/dev/null | grep -q '"ok":true'; then
    ready=1; break
  fi
  sleep 1
done
if [ "$ready" = "1" ]; then
  log "broker 探活通过：$SOCKET"
else
  die "broker 未在 30s 内就绪：看 supervisorctl status clklog_harness_broker 与 $LOG_DIR/harness-broker.log"
fi

# 标记：部署脚本渲染 config.yaml 时据此保留 enabled: true（见 lib.sh render_config_yaml）
printf 'release=%s\ninstalled_at=%s\n' "$REL_HASH" "$(date -Is)" > "$HARNESS_MARKER"
chmod 0644 "$HARNESS_MARKER"

log "--------------------------------------------------------------"
log "Harness 运行时安装完成（release=$REL_HASH）"
log "  下一步（首次启用；已启用过的机器无需重复）：重跑一次部署让开关收敛为 enabled: true ——"
log "    常规方案：HARNESS_ENABLED=1 bash $SELF_DIR/deploy-native.sh --skip-build"
log "    容器方案：HARNESS_ENABLED=1 bash $SELF_DIR/deploy-docker.sh --skip-build"
log "  （随后在平台「设置 → AI Workspace 管理 → 模型供应商」配置密钥）"
log "--------------------------------------------------------------"
