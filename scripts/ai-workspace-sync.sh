#!/usr/bin/env bash
# ai-workspace-sync.sh — AI 工作区内容（ai_workspace）双向同步
#
# phase: clklog-ai-workspace-sync-v1
# 设计见 docs/architecture/clklog-ai-workspace-sync-design-v1.md
#
# 仓库与运行时**同构**（相对路径一一对应），因此本脚本不做任何路径映射：
#   仓库   <repo>/ai_workspace/{default,app/<项目>}
#   运行时 <runtime root>/ai_workspace/{default,app/<项目>}
#
# 用法（本地开发，走隧道）：
#   bash scripts/ai-workspace-sync.sh diff                      # 双向差异（只读）
#   bash scripts/ai-workspace-sync.sh push default              # 仓库 → 运行时（默认不删）
#   bash scripts/ai-workspace-sync.sh pull app/clklogapp        # 运行时 → 仓库（先过密钥扫描）
#   bash scripts/ai-workspace-sync.sh status
#   bash scripts/ai-workspace-sync.sh --self-test               # 离线自检（不需要服务器）
#
# 用法（服务器上，发版时由 server-upgrade.sh 调用）：
#   ops/ai-workspace-sync.sh init --from-release /data/project/clklog_manager/production
#   ops/ai-workspace-sync.sh migrate --projects clklogapp,default

set -euo pipefail

# ============================== CONFIG ==============================
# 运行时侧（与后端 workspace-paths.service.ts 的常量必须一致；--self-test 会校验）
RUNTIME_ROOT="${RUNTIME_ROOT:-/home/harness/clklog-ai}"
AI_DIR_NAME="ai_workspace"
TEMPLATE_DIR_NAME="default"
APP_DIR_NAME="app"
HARNESS_USER="${HARNESS_USER:-harness}"
PROJECT_NAME_RE='^[a-z0-9][a-z0-9_-]{0,63}$'

# 传输（本地模式自动检测：RUNTIME_ROOT 存在即视为在服务器上）
SSH_TARGET="${SSH_TARGET:-root@localhost}"
SSH_PORT="${SSH_PORT:-2223}"

# 同步范围与排除（两个方向共用）
SYNC_DIRS=("$TEMPLATE_DIR_NAME" "$APP_DIR_NAME")
EXCLUDES=(
  '--exclude=.DS_Store' '--exclude=*.swp' '--exclude=*~'
  '--exclude=node_modules/' '--exclude=.cache/' '--exclude=.git/'
  '--exclude=*.log' '--exclude=*.sock' '--exclude=.sync-backup/'
  '--exclude=.pull-staging/'
  '--exclude=.sync-state.json' '--exclude=.sync-lock' '--exclude=.migrated/' '--exclude=.pull-staging/'
)
MAX_FILE_SIZE="${MAX_FILE_SIZE:-20M}"

# 密钥/隐私门禁（pull 写仓库前、push 发服务器前都要扫）
SECRET_NAME_RE='(^\.env|\.env$|\.pem$|\.key$|^credentials|^id_rsa|^id_ed25519)'
SECRET_CONTENT_RE='BEGIN (RSA|OPENSSH|EC|PGP|DSA) PRIVATE KEY'
SECRET_ASSIGN_RE='(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|client[_-]?secret)[[:space:]]*[:=][[:space:]]*[^[:space:]]{6,}'
SECRET_PII_RE='(\b1[3-9][0-9]{9}\b|\b[1-9][0-9]{5}(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx]\b)'
SECRET_ENTROPY_RE='[A-Za-z0-9_+/=-]{40,}'
# 高熵规则跳过这些后缀/目录（文档与平台工具里会有长串示例，不是凭据）
ENTROPY_SKIP_SUFFIX_RE='\.(md|mdx|json|txt|gitkeep|csv|sql)$'
ENTROPY_SKIP_PATH_RE='/tools/|/files/notes/'
# ====================================================================

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_AI="$REPO_ROOT/$AI_DIR_NAME"
RUNTIME_AI=""
LOCK_FILE=""
STATE_DIR=""
STATE_FILE=""
LOCK_HELD=0

# RUNTIME_ROOT 可被 --runtime-root 覆盖，因此派生路径在参数解析后统一重算
recompute_paths() {
  RUNTIME_AI="$RUNTIME_ROOT/$AI_DIR_NAME"
  LOCK_FILE="$RUNTIME_AI/.sync-lock"
  STATE_FILE="$RUNTIME_AI/.sync-state.json"
}

# 便携互斥（macOS 无 flock）：运行时根下原子 mkdir 作为锁
acquire_lock() {
  runs_on_host || return 0          # 远程模式由服务器端各自的调用序列化
  mkdir -p "$RUNTIME_AI" 2>/dev/null || true
  if mkdir "$LOCK_FILE" 2>/dev/null; then
    LOCK_HELD=1
    trap 'release_lock' EXIT INT TERM
  else
    local owner
    owner="$(cat "$LOCK_FILE/pid" 2>/dev/null || echo '?')"
    die "另一个同步正在进行（锁 ${LOCK_FILE}，pid=${owner}）；确认无人在跑后执行: rm -rf '$LOCK_FILE'"
  fi
  printf '%s' "$$" > "$LOCK_FILE/pid" 2>/dev/null || true
}

cleanup_staging() {
  [ -n "${REPO_AI:-}" ] && rm -rf "$REPO_AI/.pull-staging" 2>/dev/null || true
}

release_lock() {
  [ "$LOCK_HELD" = "1" ] && rm -rf "$LOCK_FILE" 2>/dev/null || true
  LOCK_HELD=0
}
recompute_paths

log()  { echo "[ai-workspace] $*"; }
warn() { echo "[ai-workspace] ⚠ $*" >&2; }
die()  { echo "[ai-workspace] ✗ $*" >&2; exit 1; }

runs_on_host() { [ -d "$RUNTIME_ROOT" ]; }

# 把运行时绝对路径翻译成 rsync 可用的源/目标（本地原样，远程加 host:）
rpath() {
  if runs_on_host; then printf '%s' "$1"; else printf '%s:%s' "$SSH_TARGET" "$1"; fi
}

# bash 3.2（macOS 自带）兼容：不用数组/mapfile，改用字符串 + RSYNC_RSH
build_rsync_args() {
  RSYNC_ARGS="-a --itemize-changes --human-readable --no-perms --no-owner --no-group --max-size=$MAX_FILE_SIZE"
  local ex
  for ex in "${EXCLUDES[@]}"; do RSYNC_ARGS="$RSYNC_ARGS $ex"; done
  if runs_on_host; then
    unset RSYNC_RSH 2>/dev/null || true
  else
    RSYNC_RSH="ssh -p $SSH_PORT -o LogLevel=QUIET"
    export RSYNC_RSH
  fi
}

# ---------------------------------------------------------------- 目标解析
# 项目空间候选：仓库与运行时两侧都列（并集），避免漏掉只在运行时存在的项目
list_projects() {
  {
    ls -1d "$REPO_AI/$APP_DIR_NAME"/*/ 2>/dev/null || true
    if runs_on_host; then
      ls -1d "$RUNTIME_AI/$APP_DIR_NAME"/*/ 2>/dev/null || true
    else
      ssh -p "$SSH_PORT" -o LogLevel=QUIET "$SSH_TARGET" "ls -1d '$RUNTIME_AI/$APP_DIR_NAME'/*/ 2>/dev/null" 2>/dev/null || true
    fi
  } | while IFS= read -r dir; do
      local name
      name="$(basename "${dir%/}")"
      case "$name" in ''|'*') continue ;; esac
      [[ "$name" =~ $PROJECT_NAME_RE ]] && printf '%s/%s\n' "$APP_DIR_NAME" "$name"
    done | sort -u
}

target_dirs() { # $* = default | app/<项目> | --all
  local specs=("$@")
  [ ${#specs[@]} -eq 0 ] && specs=(--all)
  for spec in ${specs[@]+"${specs[@]}"}; do
    case "$spec" in
      --all) printf '%s\n' "$TEMPLATE_DIR_NAME"; list_projects ;;
      default) printf '%s\n' "$TEMPLATE_DIR_NAME" ;;
      app/*)
        local project="${spec#app/}"
        [[ "$project" =~ $PROJECT_NAME_RE ]] || die "项目名不合法: $project"
        printf '%s\n' "$spec" ;;
      *) die "未知目标: ${spec}（可用: default | app/<项目> | --all）" ;;
    esac
  done
}

# ---------------------------------------------------------------- 密钥门禁
scan_secrets() { # $1 = 目录；命中返回 0 并打印命中项，未命中返回 1
  local dir="$1" hits=0 file rel
  while IFS= read -r -d '' file; do
    rel="${file#"$dir"/}"
    if [[ "$(basename "$file")" =~ $SECRET_NAME_RE ]]; then
      echo "    [文件名] $rel"; hits=$((hits + 1)); continue
    fi
    grep -Eq "$SECRET_CONTENT_RE" "$file" 2>/dev/null && { echo "    [私钥块] $rel"; hits=$((hits + 1)); continue; }
    grep -Eq "$SECRET_ASSIGN_RE" "$file" 2>/dev/null && { echo "    [凭据赋值] $rel"; hits=$((hits + 1)); continue; }
    grep -Eq "$SECRET_PII_RE" "$file" 2>/dev/null && { echo "    [个人信息] $rel"; hits=$((hits + 1)); continue; }
    if ! [[ "$file" =~ $ENTROPY_SKIP_SUFFIX_RE ]] && ! [[ "$file" =~ $ENTROPY_SKIP_PATH_RE ]]; then
      grep -Eq "$SECRET_ENTROPY_RE" "$file" 2>/dev/null && { echo "    [高熵长串] $rel"; hits=$((hits + 1)); }
    fi
  done < <(find "$dir" -type f -size -2M -print0 2>/dev/null)
  [ "$hits" -gt 0 ]
}

gate_secrets() { # $1 = 目录 $2 = 方向说明 $3 = allow(1/0)
  local dir="$1" label="$2" allow="$3"
  [ -d "$dir" ] || return 0
  local out
  out="$(scan_secrets "$dir" || true)"
  [ -z "$out" ] && return 0
  warn "$label 命中密钥/隐私规则："
  printf '%s\n' "$out"
  if [ "$allow" = "1" ]; then
    warn "已按 --allow-secrets 放行（请确认这些内容确实可以入库/上传）"
    record_state "$label" "allow-secrets"
    return 0
  fi
  return 1
}

record_state() { # $1 = 动作描述 $2 = 标记
  local json
  json="$(printf '{\n  "last_action": "%s",\n  "marker": "%s",\n  "at": "%s",\n  "repo": "%s",\n  "runtime": "%s",\n  "mode": "%s"\n}' \
    "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REPO_AI" "$RUNTIME_AI" "$(runs_on_host && echo local || echo ssh)")"
  if runs_on_host; then
    printf '%s\n' "$json" > "$STATE_FILE.tmp" 2>/dev/null && mv "$STATE_FILE.tmp" "$STATE_FILE" 2>/dev/null && chmod 600 "$STATE_FILE" 2>/dev/null
  else
    # ssh 模式：状态文件在远端，写不进去只提示，不影响同步结果
    printf '%s\n' "$json" | ssh -p "$SSH_PORT" -o LogLevel=QUIET "$SSH_TARGET" "cat > '$STATE_FILE' && chmod 600 '$STATE_FILE'" 2>/dev/null \
      || warn "状态文件写入失败（远端 ${STATE_FILE}），同步结果不受影响"
  fi
  return 0
}

backup_runtime() { # $1 = 运行时目标目录（相对）
  local rel="$1" src="$RUNTIME_AI/$rel"
  [ -d "$src" ] || return 0
  local stamp dest
  stamp="$(date +%Y%m%d-%H%M%S)"
  dest="$RUNTIME_AI/.sync-backup/$stamp/$rel"
  if runs_on_host; then
    mkdir -p "$(dirname "$dest")"
    cp -a "$src" "$dest" 2>/dev/null || true
  else
    rsync -a -e "ssh -p $SSH_PORT -o LogLevel=QUIET" "$SSH_TARGET:$src/" "$SSH_TARGET:$dest/" >/dev/null 2>&1 || true
  fi
  log "已备份运行时内容 → $dest"
  # 只保留最近 10 份
  if runs_on_host; then
    local old
    ls -1dt "$RUNTIME_AI/.sync-backup"/*/ 2>/dev/null | tail -n +11 | while IFS= read -r old; do [ -n "$old" ] && rm -rf "$old"; done
  fi
}

backup_repo() { # $1 = 仓库侧相对目录
  local rel="$1" src="$REPO_AI/$rel"
  [ -d "$src" ] || return 0
  local stamp dest
  stamp="$(date +%Y%m%d-%H%M%S)"
  dest="$REPO_AI/.sync-backup/$stamp/$rel"
  mkdir -p "$(dirname "$dest")"
  cp -a "$src" "$dest" 2>/dev/null || true
  log "已备份仓库内容 → $dest"
}

ensure_dir() { # $1 = 绝对路径 $2 = mode
  local path="$1" mode="$2"
  if runs_on_host; then
    mkdir -p "$path"; chmod "$mode" "$path"
    if [ "$(id -u)" = "0" ] && id "$HARNESS_USER" >/dev/null 2>&1; then
      chown "$HARNESS_USER:$HARNESS_USER" "$path"
    fi
  else
    ssh -p "$SSH_PORT" -o LogLevel=QUIET "$SSH_TARGET" "mkdir -p '$path' && chmod $mode '$path'" >/dev/null
  fi
}

# ---------------------------------------------------------------- 命令：init
cmd_init() {
  runs_on_host || die "init 需要在本机（服务器）执行：bash -s -- init --from-release <release>"
  local release="${FROM_RELEASE:-}"
  local src
  if [ -n "$release" ]; then src="$release/$AI_DIR_NAME"; else src="$REPO_AI"; fi
  [ -d "$src" ] || die "找不到内容源目录: $src"

  log "初始化运行时布局（源=${src}，运行时=${RUNTIME_AI}）"
  ensure_dir "$RUNTIME_AI" 0700
  ensure_dir "$RUNTIME_AI/$APP_DIR_NAME" 0700
  ensure_dir "$RUNTIME_AI/$TEMPLATE_DIR_NAME" 0755

  # 顺序安全：若存在旧草稿 initialization/draft 且新位置还是空的，先把**活草稿**搬过来，
  # 再由下面的 ignore-existing 补齐——绝不能用 git 里的种子覆盖平台里正在使用的草稿
  if [ -d "$RUNTIME_ROOT/initialization/draft" ] && [ -z "$(ls -A "$RUNTIME_AI/$TEMPLATE_DIR_NAME" 2>/dev/null)" ]; then
    log "检测到旧模板草稿，先并入其内容（活内容优先）"
    adopt_legacy_draft
  fi

  local rel out
  build_rsync_args
  while IFS= read -r rel; do
    [ -d "$src/$rel" ] || continue
    ensure_dir "$RUNTIME_AI/$rel" 0750
    out="$(rsync $RSYNC_ARGS --ignore-existing "$src/$rel/" "$RUNTIME_AI/$rel/" 2>&1 || true)"
    echo "$out" | grep -v '^$' | sed 's/^/    /' || true
  done < <(target_dirs --all)
  log "init 完成（只补缺失，已存在内容未被改写）"

  # 首次部署：检测旧布局并提示迁移
  if [ -d "$RUNTIME_ROOT/initialization/draft" ] && [ ! -e "$RUNTIME_AI/$TEMPLATE_DIR_NAME/AGENTS.md" ]; then
    warn "检测到旧模板草稿 initialization/draft，请执行: $0 migrate"
  fi
  if ls -d "$RUNTIME_ROOT"/workspaces/*/"$APP_DIR_NAME" >/dev/null 2>&1; then
    warn "检测到旧项目空间 workspaces/<hash>/app，请执行: $0 migrate --projects <项目名列表>"
  fi
  record_state "init" "ok"
}

# ---------------------------------------------------------------- 命令：push / pull / diff
sync_paths() { # $1=源(带尾斜杠) $2=目标(带尾斜杠) $3=delete(1/0) $4=dry(1/0)
  local src="$1" dst="$2" del="$3" dry="$4"
  build_rsync_args
  local extra=""
  [ "$del" = "1" ] && extra="$extra --delete"
  [ "$dry" = "1" ] && extra="$extra --dry-run"
  rsync $RSYNC_ARGS $extra "$src" "$dst"
}

runtime_has() { # 运行时是否存在该目标目录
  if runs_on_host; then [ -d "$RUNTIME_AI/$1" ]; else ssh -p "$SSH_PORT" -o LogLevel=QUIET "$SSH_TARGET" "test -d '$RUNTIME_AI/$1'" 2>/dev/null; fi
}

cmd_push() {
  local del="$DELETE" dry="$DRY_RUN"
  for rel in $(target_dirs ${TARGETS[@]+"${TARGETS[@]}"}); do
    [ -d "$REPO_AI/$rel" ] || { warn "跳过（仓库无此目录）: $rel"; continue; }
    if ! gate_secrets "$REPO_AI/$rel" "push ${rel}（仓库 → 运行时）" "$ALLOW_SECRETS"; then
      die "push 已中止：仓库内容命中密钥/隐私规则。确需上传请加 --allow-secrets"
    fi
    if [ "$del" = "1" ] && [ "$dry" = "0" ]; then
      [ "$YES" = "1" ] || die "--delete 需要同时给 --yes（防止误删运行时内容）"
      backup_runtime "$rel"
    fi
    log "push $rel"
    sync_paths "$REPO_AI/$rel/" "$(rpath "$RUNTIME_AI/$rel")/" "$del" "$dry"
  done
  [ "$dry" = "1" ] || record_state "push" "ok"
}

cmd_pull() {
  local del="$DELETE" dry="$DRY_RUN"
  local stage_root="$REPO_AI/.pull-staging"
  for rel in $(target_dirs ${TARGETS[@]+"${TARGETS[@]}"}); do
    runtime_has "$rel" || { warn "跳过（运行时无此目录）: $rel"; continue; }
    local stage="$stage_root/$rel"
    rm -rf "$stage"; mkdir -p "$stage"
    # ① 运行时 → 本地暂存区（此时还没碰仓库）
    sync_paths "$(rpath "$RUNTIME_AI/$rel")/" "$stage/" 0 "$dry"
    if [ "$dry" = "1" ]; then
      log "pull ${rel}（dry-run，仅列出将要拉取的内容）"; rm -rf "$stage"; continue
    fi
    # ② 扫描暂存区：命中即整批丢弃，仓库一个文件都不落
    if ! gate_secrets "$stage" "pull ${rel}（运行时 → 仓库）" "$ALLOW_SECRETS"; then
      rm -rf "$stage"
      die "pull 已中止：内容命中密钥/隐私规则，未写入仓库。确需入库请加 --allow-secrets"
    fi
    # ③ 备份仓库侧后并入
    if [ "$del" = "1" ]; then
      [ "$YES" = "1" ] || { rm -rf "$stage"; die "--delete 需要同时给 --yes（防止误删仓库内容）"; }
      backup_repo "$rel"
    fi
    log "pull $rel"
    sync_paths "$stage/" "$REPO_AI/$rel/" "$del" "0"
    rm -rf "$stage"
  done
  rmdir "$stage_root" 2>/dev/null || true
  [ "$dry" = "1" ] || record_state "pull" "ok"
}

cmd_diff() {
  local rel any=0
  for rel in $(target_dirs ${TARGETS[@]+"${TARGETS[@]}"}); do
    echo "== $rel =="
    if ! runs_on_host && ! ssh -p "$SSH_PORT" -o LogLevel=QUIET "$SSH_TARGET" "test -d '$RUNTIME_AI/$rel'"; then
      echo "  运行时不存在（未初始化？）"; any=1; continue
    fi
    [ -d "$REPO_AI/$rel" ] || { echo "  仓库不存在"; any=1; continue; }
    local out
    build_rsync_args
    if runs_on_host; then
      out="$(rsync $RSYNC_ARGS --dry-run --delete "$REPO_AI/$rel/" "$RUNTIME_AI/$rel/" 2>&1 | grep -v '^$' || true)"
      [ -n "$out" ] && { echo "$out" | sed 's/^/  repo→rt: /'; any=1; }
      out="$(rsync $RSYNC_ARGS --dry-run --delete "$RUNTIME_AI/$rel/" "$REPO_AI/$rel/" 2>&1 | grep -v '^$' || true)"
      [ -n "$out" ] && { echo "$out" | sed 's/^/  rt→repo: /'; any=1; }
    else
      out="$(rsync $RSYNC_ARGS --dry-run --delete "$REPO_AI/$rel/" "$(rpath "$RUNTIME_AI/$rel/")" 2>&1 | grep -v '^$' || true)"
      [ -n "$out" ] && { echo "$out" | sed 's/^/  repo→rt: /'; any=1; }
      out="$(rsync $RSYNC_ARGS --dry-run --delete "$(rpath "$RUNTIME_AI/$rel/")" "$REPO_AI/$rel/" 2>&1 | grep -v '^$' || true)"
      [ -n "$out" ] && { echo "$out" | sed 's/^/  rt→repo: /'; any=1; }
    fi
    [ -z "${out:-}" ] && echo "  （一致）"
  done
  [ "$any" = "1" ] && exit 1 || exit 0
}

# ---------------------------------------------------------------- 命令：status
cmd_status() {
  echo "仓库根:   $REPO_AI"
  echo "运行时根: $RUNTIME_AI   ($(runs_on_host && echo 本机 || echo "ssh $SSH_TARGET -p $SSH_PORT"))"
  local rel
  for rel in $(target_dirs --all); do
    local repo_n rt_n
    repo_n=$(find "$REPO_AI/$rel" -type f 2>/dev/null | wc -l | tr -d ' ')
    if runs_on_host; then rt_n=$(find "$RUNTIME_AI/$rel" -type f 2>/dev/null | wc -l | tr -d ' ')
    else rt_n=$(ssh -p "$SSH_PORT" -o LogLevel=QUIET "$SSH_TARGET" "find '$RUNTIME_AI/$rel' -type f 2>/dev/null | wc -l" 2>/dev/null || echo '?'); fi
    printf '  %-22s 仓库 %4s 文件 | 运行时 %4s 文件\n' "$rel" "$repo_n" "$rt_n"
  done
  if runs_on_host; then
    local current
    current="$(readlink -f "$RUNTIME_ROOT/initialization/current" 2>/dev/null || true)"
    if [ -n "$current" ] && [ -d "$current" ]; then
      local diff_n
      diff_n=$(diff -rq "$current" "$RUNTIME_AI/$TEMPLATE_DIR_NAME" 2>/dev/null | wc -l | tr -d ' ')
      echo "  模板：草稿 vs 已发布 current 相差 $diff_n 项（发布是平台动作，推送草稿不自动生效）"
    fi
  fi
  [ -f "$STATE_FILE" ] && { echo "最近同步:"; sed 's/^/  /' "$STATE_FILE"; } || echo "最近同步: （无记录）"
}

# ---------------------------------------------------------------- 命令：migrate
old_hash() { # 与后端 hashPathKey('project', name) 一致
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | { printf 'project\0'; cat; } | sha256sum | cut -c1-32
  else
    printf '%s' "$1" | { printf 'project\0'; cat; } | shasum -a 256 | cut -c1-32
  fi
}

# 旧模板草稿 → ai_workspace/default（活内容优先，不覆盖已存在的同名文件）
adopt_legacy_draft() {
  local legacy="$RUNTIME_ROOT/initialization/draft"
  [ -d "$legacy" ] || return 0
  build_rsync_args
  rsync $RSYNC_ARGS --ignore-existing "$legacy/" "$RUNTIME_AI/$TEMPLATE_DIR_NAME/"
  if [ "$(id -u)" = "0" ] && id "$HARNESS_USER" >/dev/null 2>&1; then
    chown -R "$HARNESS_USER:$HARNESS_USER" "$RUNTIME_AI/$TEMPLATE_DIR_NAME" 2>/dev/null || true
  fi
  local a b
  a=$(find "$legacy" -type f | wc -l | tr -d ' ')
  b=$(find "$RUNTIME_AI/$TEMPLATE_DIR_NAME" -type f | wc -l | tr -d ' ')
  log "旧草稿已并入（旧 $a 个文件 → 新 $b 个文件；旧目录保留）"
}

cmd_migrate() {
  runs_on_host || die "migrate 必须在服务器上以 root 执行"
  [ "$(id -u)" = "0" ] || die "migrate 需要 root"
  local projects_csv="${PROJECTS:-clklogapp,default}"
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  local archive="$RUNTIME_AI/.migrated/$stamp"
  mkdir -p "$archive"

  echo "== 1/2 模板草稿：initialization/draft → ai_workspace/default =="
  if [ -d "$RUNTIME_ROOT/initialization/draft" ]; then
    ensure_dir "$RUNTIME_AI/$TEMPLATE_DIR_NAME" 0755
    adopt_legacy_draft
    echo "  迁移完成（活草稿优先；同名文件未被覆盖）"
  else
    echo "  跳过（无旧草稿）"
  fi

  echo "== 2/2 项目空间：workspaces/<hash>/app → ai_workspace/app/<项目名> =="
  # 注意：不要在这里改全局 IFS —— 带逗号的 IFS 会让 rsync 参数不再按空格拆词（2026-09-16 踩过）
  # 末尾必须有换行，否则 while read 会跳过最后一行（2026-09-16 踩过：default 从未被处理）
  printf '%s\n' "$projects_csv" | tr ',' '\n' | while IFS= read -r project || [ -n "$project" ]; do
    [ -n "$project" ] || continue
    [[ "$project" =~ $PROJECT_NAME_RE ]] || die "项目名不合法: $project"
    local hash src dst
    hash="$(old_hash "$project")"
    src="$RUNTIME_ROOT/workspaces/$hash/$APP_DIR_NAME"
    dst="$RUNTIME_AI/$APP_DIR_NAME/$project"
    if [ -d "$src" ]; then
      ensure_dir "$RUNTIME_AI/$APP_DIR_NAME" 0700
      ensure_dir "$dst" 0750
      build_rsync_args
      # 活内容优先：只在目标缺该文件时补（旧目录是 AI/人写出来的，价值高于发布基线）
      rsync $RSYNC_ARGS --ignore-existing "$src/" "$dst/"
      chown -R "$HARNESS_USER:$HARNESS_USER" "$dst" 2>/dev/null || true
      mkdir -p "$archive/$APP_DIR_NAME"
      mv "$src" "$archive/$APP_DIR_NAME/$project"
      echo "  $project: 已迁移（活内容优先；旧目录归档到 $archive/$APP_DIR_NAME/${project}）"
    else
      echo "  $project: 跳过（无旧目录）"
    fi
  done
  record_state "migrate" "ok"
}

# ---------------------------------------------------------------- 自检
cmd_self_test() {
  local tmp fail=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  echo "== 自检：CONFIG 与后端常量一致性 =="
  [ "$AI_DIR_NAME" = "ai_workspace" ] || { echo "  ✗ AI_DIR_NAME=$AI_DIR_NAME"; fail=1; }
  [ "$TEMPLATE_DIR_NAME" = "default" ] || { echo "  ✗ TEMPLATE_DIR_NAME"; fail=1; }
  [ "$APP_DIR_NAME" = "app" ] || { echo "  ✗ APP_DIR_NAME"; fail=1; }
  [ "$RUNTIME_ROOT" = "/home/harness/clklog-ai" ] || echo "  ⚠ RUNTIME_ROOT 被覆盖为 ${RUNTIME_ROOT}（非默认）"
  local backend="apps/analytics-server/src/modules/ai-assistant/workspace/workspace-paths.service.ts"
  if [ -f "$REPO_ROOT/$backend" ]; then
    grep -q "AI_WORKSPACE_DIR = '$AI_DIR_NAME'" "$REPO_ROOT/$backend" || { echo "  ✗ 后端 AI_WORKSPACE_DIR 与脚本不一致"; fail=1; }
    grep -q "projectAppSegments" "$REPO_ROOT/$backend" || { echo "  ✗ 后端缺少 projectAppSegments"; fail=1; }
  else
    echo "  ⚠ 找不到后端文件，跳过一致性校验"
  fi
  [ "$PROJECT_NAME_RE" = '^[a-z0-9][a-z0-9_-]{0,63}$' ] || { echo "  ✗ 项目名正则与 broker/后端不一致"; fail=1; }

  echo "== 自检：项目名规则 =="
  for ok in clklogapp default proj-2_x a1; do
    [[ "$ok" =~ $PROJECT_NAME_RE ]] || { echo "  ✗ 应通过: $ok"; fail=1; }
  done
  for bad in '..' 'a/b' 'A B' 'UPPER' '.hidden' ''; do
    [[ ! "$bad" =~ $PROJECT_NAME_RE ]] || { echo "  ✗ 应拒绝: [$bad]"; fail=1; }
  done

  echo "== 自检：密钥规则 =="
  mkdir -p "$tmp/t/sub"
  printf 'hello\n' > "$tmp/t/ok.md"
  printf 'password = hunter2hunter2\n' > "$tmp/t/cred.txt"
  printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\nxxx\n' > "$tmp/t/id_rsa"
  printf '13812345678\n' > "$tmp/t/pii.txt"
  printf 'short\n' > "$tmp/t/.env.production"
  printf 'x\n' > "$tmp/t/sub/ok2.txt"
  local out
  out="$(scan_secrets "$tmp/t" || true)"
  for expect in 'cred.txt' 'id_rsa' 'pii.txt'; do
    grep -q "$expect" <<<"$out" || { echo "  ✗ 未命中: $expect"; fail=1; }
  done
  grep -q 'ok.md' <<<"$out" && { echo "  ✗ 误报: ok.md"; fail=1; }
  grep -q 'ok2.txt' <<<"$out" && { echo "  ✗ 误报: ok2.txt"; fail=1; }
  # 文档里的长串（.md）不应因高熵规则误报
  mkdir -p "$tmp/docs/tools"
  printf 'base64: %s\n' "$(head -c 60 /dev/zero | tr '\0' 'A')" > "$tmp/docs/tools/readme.md"
  scan_secrets "$tmp/docs" && { echo "  ✗ 文档长串被误报（tools/.md 应跳过）"; fail=1; }

  [ "$fail" = "0" ] && echo "✅ 自检通过" || { echo "❌ 自检失败"; exit 1; }
}

# ---------------------------------------------------------------- 主入口
TARGETS=(); DELETE=0; DRY_RUN=0; YES=0; ALLOW_SECRETS=0; FROM_RELEASE=""; PROJECTS=""
COMMAND=""
while [ $# -gt 0 ]; do
  case "$1" in
    init|push|pull|diff|status|migrate) COMMAND="$1" ;;
    --all) TARGETS+=(--all) ;;
    --delete) DELETE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --yes) YES=1 ;;
    --allow-secrets) ALLOW_SECRETS=1 ;;
    --from-release) shift; FROM_RELEASE="${1:-}" ;;
    --projects) shift; PROJECTS="${1:-}" ;;
    --runtime-root) shift; RUNTIME_ROOT="${1:-}" ;;
    --self-test) cmd_self_test; exit 0 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) TARGETS+=("$1") ;;
  esac
  shift
done

recompute_paths
[ -n "$COMMAND" ] || die "缺少命令（init|push|pull|diff|status|migrate），用 --help 看用法"

case "$COMMAND" in
  init) cmd_init ;;
  push) acquire_lock; trap 'cleanup_staging; release_lock' EXIT INT TERM; cmd_push ;;
  pull) acquire_lock; trap 'cleanup_staging; release_lock' EXIT INT TERM; cmd_pull ;;
  diff) cmd_diff ;;
  status) cmd_status ;;
  migrate) cmd_migrate ;;
esac
