#!/usr/bin/env bash
# teardown.sh — 清空本机上的 ClkLog 社区版与 Candela 部署（**破坏性**，默认 dry-run）
#
# 用途：把目标机恢复到「只剩基础设施、可以重新从零部署」的状态，用于反复验证部署脚本。
#
# 清除范围（只碰本项目已知的容器/镜像/网络/卷/目录/配置，不碰他人资产）：
#   容器：candela-*、clklog-*
#   镜像：registry.cn-shanghai.aliyuncs.com/clklog/*（社区版）、candela-*、clklog-manager-*（历史名）、
#         以及本环境拉取的官方基础镜像（ECR 的 mysql/redis/node/nginx、apache/kafka、hub.rat.dev/*）
#   网络：clklog-net      卷：两个 compose 项目与相关容器的匿名卷
#   目录：PLATFORM_DIR(/data/app/candela)、MW_BASE_DIR(/data/clklog-oss-test)、/data/app、
#         /data/logs/production/candela、/opt/clklog（Node 与 harness release）、/home/harness（若存在）
#   配置：/etc/nginx/conf.d 下本项目站点、/etc/nginx/mgr-locations、/etc/supervisord.d 下本项目程序、
#         /etc/sysctl.d/90-clklog-testenv.conf、/etc/clklog（若存在）
#
# **保留**（重新部署时会复用，不需要重装）：
#   Docker 引擎与 /etc/docker/daemon.json（含 data-root /data/docker 与镜像加速）、/data/docker
#   宿主 nginx 与 supervisord 软件包、EPEL 源、dnf 的阿里云镜像改动
#
# 用法：
#   bash teardown.sh              # 只打印将要删除的内容（dry-run）
#   bash teardown.sh --yes        # 真删
#
# 注意：密钥文件（*_BASE_DIR/config/*.env）在删除范围内 → 下次部署会**重新生成全部随机口令**
#       （平台 admin 口令随之改变），这是预期行为。

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

require_root
CONFIRM=0
[ "${1:-}" = "--yes" ] && CONFIRM=1

# 注意：外层 lib.sh 会把 BASE_DIR 设成「中间件根」(/data/clklog-oss-test)。
# 平台根必须用独立变量名，否则两者撞名 → 误把中间件目录当成平台目录（2026-10-10 dry-run 抓到）。
MW_BASE_DIR="${MW_BASE_DIR:-$BASE_DIR}"                 # 继承 lib.sh 解析出的中间件根
PLATFORM_DIR="${PLATFORM_DIR:-/data/app/candela}"       # Candela 平台部署根
LOG_DIR="${LOG_DIR:-/data/logs/production/candela}"
NODE_ROOT="${NODE_ROOT:-/opt/clklog}"

run() { if [ "$CONFIRM" -eq 1 ]; then "$@"; else echo "  [dry-run] $*"; fi }
say() { echo "[candela] $*"; }

# ---------------------------------------------------------------- 1) 容器
say "1) 容器（candela-*、clklog-*）"
mapfile -t CTNS < <(docker ps -a --format '{{.Names}}' | grep -E '^(candela|clklog)-' || true)
if [ "${#CTNS[@]}" -eq 0 ]; then say "   无"; else
  for c in "${CTNS[@]}"; do run docker rm -f "$c" >/dev/null; echo "   删除容器 $c"; done
fi

# ---------------------------------------------------------------- 2) 镜像
say "2) 镜像（本项目相关）"
img_pat='^(registry\.cn-shanghai\.aliyuncs\.com/clklog/|candela-|clklog-manager-|public\.ecr\.aws/docker/library/(mysql|redis|node|nginx)|hub\.rat\.dev/|apache/kafka)'
mapfile -t IMGS < <(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E "$img_pat" || true)
if [ "${#IMGS[@]}" -eq 0 ]; then say "   无"; else
  for i in "${IMGS[@]}"; do run docker rmi -f "$i" >/dev/null; echo "   删除镜像 $i"; done
fi

# ---------------------------------------------------------------- 3) 网络与卷
say "3) 网络与卷"
if docker network inspect clklog-net >/dev/null 2>&1; then
  run docker network rm clklog-net >/dev/null; echo "   删除网络 clklog-net"
fi
# 只删「本项目 compose 项目」与「已无容器引用的悬空卷」，不碰其他项目的卷
mapfile -t VOLS < <(docker volume ls -qf dangling=true || true)
for v in "${VOLS[@]}"; do run docker volume rm "$v" >/dev/null; echo "   删除悬空卷 ${v:0:12}…"; done

# ---------------------------------------------------------------- 4) 目录
say "4) 数据与部署目录"
for d in "$PLATFORM_DIR" "$MW_BASE_DIR" /data/app "$LOG_DIR" "$NODE_ROOT" /home/harness; do
  [ -e "$d" ] || continue
  echo "   $(du -sh "$d" 2>/dev/null | cut -f1)  $d"
  run rm -rf "$d"
done
# 清掉空的父目录（/data/logs/production、/data/logs 为空才删）
run rmdir -p --ignore-fail-on-non-empty /data/logs/production 2>/dev/null || true

# ---------------------------------------------------------------- 5) 配置
say "5) 宿主配置"
for f in /etc/nginx/conf.d/candela-map.conf /etc/nginx/conf.d/candela-site.conf \
         /etc/nginx/conf.d/clklog-testenv.conf /etc/nginx/conf.d/clklog-manager-map.conf \
         /etc/sysctl.d/90-clklog-testenv.conf; do
  [ -e "$f" ] && { run rm -f "$f"; echo "   删除 $f"; }
done
# 社区版部署产生的 conf 备份
for f in /etc/nginx/conf.d/clklog-testenv.conf.bak-*; do
  [ -e "$f" ] && { run rm -f "$f"; echo "   删除 $f"; }
done
[ -d /etc/nginx/mgr-locations ] && { run rm -rf /etc/nginx/mgr-locations; echo "   删除 /etc/nginx/mgr-locations"; }
[ -d /etc/clklog ] && { run rm -rf /etc/clklog; echo "   删除 /etc/clklog"; }
for f in /etc/supervisord.d/candela_server.ini /etc/supervisord.d/candela_ingestor.ini \
         /etc/supervisord.d/clklog_analytics_server.ini /etc/supervisord.d/clklog_analytics_ingestor.ini \
         /etc/supervisord.d/clklog-harness-broker.ini; do
  [ -e "$f" ] && { run rm -f "$f"; echo "   删除 $f"; }
done
# 项目日志文件（保留 /data/weblogs 目录本身，nginx 会重建文件）
if [ -d /data/weblogs ]; then
  for f in /data/weblogs/clklog-manager*.log /data/weblogs/clklog-testenv*.log; do
    [ -e "$f" ] && { run rm -f "$f"; echo "   删除日志 $f"; }
  done
fi

# 让 supervisor / nginx 感知配置变化
if [ "$CONFIRM" -eq 1 ]; then
  command -v supervisorctl >/dev/null 2>&1 && supervisorctl reread >/dev/null 2>&1 || true
  command -v nginx >/dev/null 2>&1 && nginx -t >/dev/null 2>&1 && systemctl reload nginx 2>/dev/null || true
fi

# ---------------------------------------------------------------- 6) 汇总
say "--------------------------------------------------------------"
if [ "$CONFIRM" -eq 0 ]; then
  say "以上为 dry-run。确认要清空请加 --yes：bash $0 --yes"
else
  say "已清空。保留（重新部署会复用）："
  say "  Docker 引擎与 /etc/docker/daemon.json（data-root=/data/docker）、/data/docker"
  say "  nginx / supervisord 软件包、EPEL 源、dnf 阿里云镜像改动"
  say "重新部署：见 README「部署」（三件套）"
  say "  bash scripts/standalone-test-env/deploy-remote.sh mw && ... clklog && ... candela/deploy-remote.sh docker"
fi
