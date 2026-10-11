#!/usr/bin/env bash
# 本地残留开发进程自查/清理（phase: clklog-analytics-worker-singleton-v1）。
#
# 背景：本地开发经隧道直连生产库，一个忘了关的 `nest start --watch` 会连着生产跑。
# 2026-09-24 事故即由此而来——残留实例在生产库上跑了两天后台调度。
# 默认只列不杀；确认清单无误后再加 --kill。
#
# 用法：
#   scripts/dev-cleanup.sh            # 列出疑似残留的本地实例
#   scripts/dev-cleanup.sh --kill     # 终止它们（SIGTERM → 3s → SIGKILL）
set -euo pipefail

PATTERNS=(
  'nest start --watch'
  'node .*analytics-server/dist'
  'tsc .*--watch'
)

KILL=0
for arg in "$@"; do
  case "$arg" in
    --kill) KILL=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg（可用 --kill）" >&2; exit 2 ;;
  esac
done

collect() {
  for pattern in "${PATTERNS[@]}"; do
    pgrep -fl "$pattern" 2>/dev/null || true
  done | grep -v "dev-cleanup.sh" | awk '!seen[$1]++'
}

found=$(collect || true)
if [ -z "$found" ]; then
  echo "没有发现残留的本地实例。"
  exit 0
fi

echo "发现以下本地实例（$(echo "$found" | wc -l | tr -d ' ') 个）："
printf '%-8s %-24s %s\n' "PID" "启动时间" "命令"
while read -r pid rest; do
  [ -z "${pid:-}" ] && continue
  started=$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/  */ /g' || echo '-')
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  printf '%-8s %-24s %s\n' "$pid" "${started:-未取到}" "${rest:0:80}"
  [ -n "$cwd" ] && printf '%-8s %-24s cwd=%s\n' "" "" "$cwd"
done <<< "$found"

if [ "$KILL" -eq 0 ]; then
  echo
  echo "仅列出，未做任何改动。确认这批实例可以终止后重跑：scripts/dev-cleanup.sh --kill"
  exit 0
fi

echo
while read -r pid _rest; do
  [ -z "${pid:-}" ] && continue
  kill -TERM "$pid" 2>/dev/null && echo "SIGTERM → $pid" || true
done <<< "$found"

sleep 3
leftover=$(collect || true)
if [ -n "$leftover" ]; then
  while read -r pid _rest; do
    [ -z "${pid:-}" ] && continue
    kill -9 "$pid" 2>/dev/null && echo "SIGKILL → $pid" || true
  done <<< "$leftover"
  sleep 1
fi

remaining=$(collect || true)
if [ -z "$remaining" ]; then
  echo "清理完成：无残留。"
else
  echo "仍有进程存活，请人工确认：" >&2
  echo "$remaining" >&2
  exit 1
fi
