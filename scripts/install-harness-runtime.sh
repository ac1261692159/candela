#!/usr/bin/env bash
# Install/update the isolated DeepSeek Harness Host and rootless Podman broker.

set -euo pipefail

CLKLOG_RELEASE_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
CLKLOG_SERVER_CONFIG="${CLKLOG_RELEASE_ROOT}/server/configs/config.yaml"
CLKLOG_NODE_ROOT="/opt/clklog/node-v24.20.0-linux-x64"
CLKLOG_NODE="${CLKLOG_NODE_ROOT}/bin/node"
CLKLOG_NPM="${CLKLOG_NODE_ROOT}/bin/npm"
CLKLOG_INSTALL_ROOT="/opt/clklog/harness"
CLKLOG_CONFIG_ROOT="/etc/clklog"

PATH="${CLKLOG_NODE_ROOT}/bin:/usr/local/sbin:/usr/sbin:/usr/local/bin:/usr/bin:/sbin:/bin"
export PATH

log() {
  echo "[harness-install] $1"
}

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2
  exit 1
fi
for required in \
  "$CLKLOG_RELEASE_ROOT/harness-host/package.json" \
  "$CLKLOG_RELEASE_ROOT/harness-broker/src/server.mjs" \
  "$CLKLOG_SERVER_CONFIG" \
  "$CLKLOG_RELEASE_ROOT/ops/install-node24.sh" \
  "$CLKLOG_RELEASE_ROOT/ops/install-harness-user.sh" \
  "$CLKLOG_RELEASE_ROOT/ops/install-analytics-node24-supervisor.sh" \
  "$CLKLOG_RELEASE_ROOT/ops/supervisord-harness-broker.conf"; do
  if [ ! -e "$required" ]; then
    echo "missing release artifact: $required" >&2
    exit 1
  fi
done

bash "$CLKLOG_RELEASE_ROOT/ops/install-node24.sh"

yaml_value() {
  local section="$1"
  local key="$2"
  awk -v section="$section" -v key="$key" '
    /^  [a-z_]+:/ { current = $1; sub(":$", "", current) }
    current == section && $0 ~ "^    " key ":" {
      value = $0
      sub("^    " key ":[[:space:]]*", "", value)
      gsub(/^['\''\"]|['\''\"]$/, "", value)
      print value
      exit
    }
  ' "$CLKLOG_SERVER_CONFIG"
}

CLKLOG_HARNESS_USER="$(yaml_value runtime linux_user)"
CLKLOG_HOME_SUBDIR="$(yaml_value runtime home_subdir)"
CLKLOG_CONTAINER_IMAGE="$(yaml_value runtime container_image)"
CLKLOG_MAX_RUNTIMES="$(yaml_value runtime max_runtimes)"
CLKLOG_MAX_WORKSPACE_BYTES="$(yaml_value workspace max_bytes)"

if ! [[ "$CLKLOG_HARNESS_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || [ "$CLKLOG_HARNESS_USER" = root ]; then
  echo "invalid runtime.linux_user" >&2
  exit 2
fi
if ! [[ "$CLKLOG_HOME_SUBDIR" =~ ^[a-zA-Z0-9._-]+$ ]] || [ "$CLKLOG_HOME_SUBDIR" = . ] || [ "$CLKLOG_HOME_SUBDIR" = .. ]; then
  echo "invalid runtime.home_subdir" >&2
  exit 2
fi
if ! [[ "$CLKLOG_MAX_RUNTIMES" =~ ^[0-9]+$ ]] || ! [[ "$CLKLOG_MAX_WORKSPACE_BYTES" =~ ^[0-9]+$ ]]; then
  echo "invalid runtime limits" >&2
  exit 2
fi
if [[ "$CLKLOG_CONTAINER_IMAGE" =~ [[:space:]] ]] || [ -z "$CLKLOG_CONTAINER_IMAGE" ]; then
  echo "invalid runtime.container_image" >&2
  exit 2
fi

CLKLOG_HARNESS_HOME="/home/${CLKLOG_HARNESS_USER}"
bash "$CLKLOG_RELEASE_ROOT/ops/install-harness-user.sh" "$CLKLOG_HARNESS_USER" "$CLKLOG_HARNESS_HOME"
CLKLOG_HARNESS_HOME="$(getent passwd "$CLKLOG_HARNESS_USER" | cut -d: -f6)"
CLKLOG_HARNESS_UID="$(id -u "$CLKLOG_HARNESS_USER")"
CLKLOG_HARNESS_GID="$(id -g "$CLKLOG_HARNESS_USER")"
CLKLOG_RUNTIME_ROOT="${CLKLOG_HARNESS_HOME}/${CLKLOG_HOME_SUBDIR}"

install -d -o "$CLKLOG_HARNESS_USER" -g "$CLKLOG_HARNESS_USER" -m 0700 \
  "$CLKLOG_RUNTIME_ROOT" \
  "$CLKLOG_RUNTIME_ROOT/initialization" \
  "$CLKLOG_RUNTIME_ROOT/ai_workspace" \
  "$CLKLOG_RUNTIME_ROOT/ai_workspace/app" \
  "$CLKLOG_RUNTIME_ROOT/runtimes" \
  "$CLKLOG_RUNTIME_ROOT/workspaces" \
  "$CLKLOG_RUNTIME_ROOT/gateway" \
  "$CLKLOG_RUNTIME_ROOT/gateway/control" \
  "$CLKLOG_RUNTIME_ROOT/gateway/runtime" \
  "/run/user/${CLKLOG_HARNESS_UID}"
install -d -o root -g root -m 0755 /data/logs/production/clklog_manager

CLKLOG_RELEASE_ID="$(tr -cd 'A-Za-z0-9._-' < "$CLKLOG_RELEASE_ROOT/.version" 2>/dev/null || true)"
if [ -z "$CLKLOG_RELEASE_ID" ]; then
  CLKLOG_RELEASE_ID="manual-$(date +%Y%m%d%H%M%S)"
fi
CLKLOG_RUNTIME_RELEASE="${CLKLOG_INSTALL_ROOT}/releases/${CLKLOG_RELEASE_ID}"
install -d -o root -g root -m 0755 "$CLKLOG_RUNTIME_RELEASE/host" "$CLKLOG_RUNTIME_RELEASE/broker"
cp -a "$CLKLOG_RELEASE_ROOT/harness-host/." "$CLKLOG_RUNTIME_RELEASE/host/"
cp -a "$CLKLOG_RELEASE_ROOT/harness-broker/." "$CLKLOG_RUNTIME_RELEASE/broker/"

log "安装固定版本 Harness Host 依赖"
(cd "$CLKLOG_RUNTIME_RELEASE/host" && "$CLKLOG_NPM" ci --omit=dev --ignore-scripts)
chown -R root:root "$CLKLOG_RUNTIME_RELEASE"
find "$CLKLOG_RUNTIME_RELEASE" -type d -exec chmod 0755 {} +
ln -sfn "$CLKLOG_RUNTIME_RELEASE" "$CLKLOG_INSTALL_ROOT/current"

install -d -o root -g "$CLKLOG_HARNESS_USER" -m 0750 "$CLKLOG_CONFIG_ROOT"
CLKLOG_BROKER_CONFIG="${CLKLOG_CONFIG_ROOT}/harness-broker.json"
CLKLOG_BROKER_CONFIG_NEXT="${CLKLOG_BROKER_CONFIG}.next"
"$CLKLOG_NODE" - \
  "$CLKLOG_RUNTIME_ROOT" \
  "$CLKLOG_INSTALL_ROOT/current/host" \
  "$CLKLOG_CONTAINER_IMAGE" \
  "$CLKLOG_MAX_RUNTIMES" \
  "$CLKLOG_MAX_WORKSPACE_BYTES" > "$CLKLOG_BROKER_CONFIG_NEXT" <<'NODE'
const [root, harnessHost, image, maxRuntimes, maxWorkspaceBytes] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  root,
  harness_host: harnessHost,
  podman_path: '/usr/bin/podman',
  container_image: image,
  max_runtimes: Number(maxRuntimes),
  max_workspace_bytes: Number(maxWorkspaceBytes),
}, null, 2)}\n`);
NODE
chown root:"$CLKLOG_HARNESS_USER" "$CLKLOG_BROKER_CONFIG_NEXT"
chmod 0640 "$CLKLOG_BROKER_CONFIG_NEXT"
mv -f "$CLKLOG_BROKER_CONFIG_NEXT" "$CLKLOG_BROKER_CONFIG"

cat > /etc/tmpfiles.d/clklog-harness.conf <<EOF
d /run/user/${CLKLOG_HARNESS_UID} 0700 ${CLKLOG_HARNESS_USER} ${CLKLOG_HARNESS_USER} -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/clklog-harness.conf 2>/dev/null || true
loginctl enable-linger "$CLKLOG_HARNESS_USER" 2>/dev/null || true

# AI 工作区内容：把发布产物里的 ai_workspace（模板 default + 项目空间 app）补到运行时
# 只补缺失、不改运行时已有内容；旧布局（initialization/draft 或 workspaces/<hash>/app）另行 migrate
if [ -x "$CLKLOG_RELEASE_ROOT/ops/ai-workspace-sync.sh" ]; then
  log "初始化 AI 工作区内容（ai_workspace）"
  CLKLOG_HARNESS_USER="$CLKLOG_HARNESS_USER" \
    bash "$CLKLOG_RELEASE_ROOT/ops/ai-workspace-sync.sh" init --from-release "$CLKLOG_RELEASE_ROOT" \
    || echo "[harness-install] ⚠ ai_workspace init 失败（不阻断安装），请手动检查"
else
  echo "[harness-install] ⚠ 发布产物缺少 ops/ai-workspace-sync.sh，跳过 ai_workspace 初始化"
fi

log "拉取固定 Runtime 镜像"
# runuser 继承 cwd；不能停在 /root，harness 用户无法进入。
cd "$CLKLOG_HARNESS_HOME"
/usr/sbin/runuser -u "$CLKLOG_HARNESS_USER" -- env \
  HOME="$CLKLOG_HARNESS_HOME" \
  XDG_RUNTIME_DIR="/run/user/${CLKLOG_HARNESS_UID}" \
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  /usr/bin/podman pull "$CLKLOG_CONTAINER_IMAGE"

CLKLOG_SUPERVISOR_DIR="/etc/supervisord.d"
if [ ! -d "$CLKLOG_SUPERVISOR_DIR" ] && [ -d /etc/supervisor/conf.d ]; then
  CLKLOG_SUPERVISOR_DIR="/etc/supervisor/conf.d"
fi
install -d -o root -g root -m 0755 "$CLKLOG_SUPERVISOR_DIR"
sed \
  -e "s|@@HARNESS_USER@@|${CLKLOG_HARNESS_USER}|g" \
  -e "s|@@HARNESS_HOME@@|${CLKLOG_HARNESS_HOME}|g" \
  -e "s|@@HARNESS_UID@@|${CLKLOG_HARNESS_UID}|g" \
  "$CLKLOG_RELEASE_ROOT/ops/supervisord-harness-broker.conf" \
  > "$CLKLOG_SUPERVISOR_DIR/clklog-harness-broker.ini"
chmod 0644 "$CLKLOG_SUPERVISOR_DIR/clklog-harness-broker.ini"

# Preserve the deployed environment lines (which contain server-owned secrets)
# and replace only the commands that select the project-pinned Node runtime.
bash "$CLKLOG_RELEASE_ROOT/ops/install-analytics-node24-supervisor.sh" \
  "$CLKLOG_NODE_ROOT" \
  "$CLKLOG_SUPERVISOR_DIR"

supervisorctl reread
supervisorctl update
supervisorctl restart clklog_harness_broker
supervisorctl restart clklog_analytics_server
supervisorctl restart clklog_analytics_ingestor

if [ -f "$CLKLOG_RELEASE_ROOT/ops/nginx-clklog-manager.conf" ]; then
  install -o root -g root -m 0644 \
    "$CLKLOG_RELEASE_ROOT/ops/nginx-clklog-manager.conf" \
    /etc/nginx/conf.d/candela.conf
  nginx -t
  systemctl reload nginx
fi

log "Harness Runtime 安装完成 (user=${CLKLOG_HARNESS_USER}, release=${CLKLOG_RELEASE_ID})"
