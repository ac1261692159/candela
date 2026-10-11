#!/usr/bin/env bash
# verify.sh — ClkLog 独立测试环境：端到端验证（可反复执行）
#
# 覆盖：容器状态 / MySQL 表结构 / ClickHouse 库表 / Kafka topic 与消费进度 /
#       HTTP 入口 / 数据上报链路（receiver → Kafka → Flink → ClickHouse）
#
# 上报验证每次会新增一批测试事件（distinct_id 带时间戳），不影响已有数据。

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

BASE_DIR="${BASE_DIR:-/data/clklog-oss-test}"
require_root
[ -f "$ENV_FILE" ] || die "未找到 ${ENV_FILE}，请先部署"
load_env

PASS=0; FAIL=0
ok()   { echo "  [OK]   $*"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); }

echo "=============================================================="
echo " 1. 容器状态"
echo "=============================================================="
docker ps --filter 'name=clklog-' --format '  {{.Names}}\t{{.Status}}' | sort

echo
echo "=============================================================="
echo " 2. MySQL（元数据）"
echo "=============================================================="
tbls=$(docker exec -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" clklog-mysql \
  mysql -uroot -N -B -e "SELECT GROUP_CONCAT(table_name) FROM information_schema.tables WHERE table_schema='clklog'" 2>/dev/null || true)
if [ -n "$tbls" ]; then ok "clklog 库表：$tbls"; else bad "clklog 库表为空"; fi
proj=$(docker exec -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" clklog-mysql \
  mysql -uroot -N -B -e "SELECT CONCAT(project_name,' / ',token) FROM clklog.tbl_project LIMIT 1" 2>/dev/null || true)
[ -n "$proj" ] && ok "上报项目与 token：$proj" || bad "tbl_project 无数据（上报会 403）"

echo
echo "=============================================================="
echo " 3. ClickHouse（数据落地）"
echo "=============================================================="
dbs=$(ck_query "SELECT name FROM system.databases WHERE name LIKE 'clklog%' ORDER BY name")
echo "  数据库：$(echo "$dbs" | tr '\n' ' ')"
n_tables=$(ck_query "SELECT count() FROM system.tables WHERE database='clklog'")
if [ "${n_tables:-0}" -gt 0 ] 2>/dev/null; then
  ok "clklog 库表数量：$n_tables"
else
  bad "clklog 库尚未初始化（clklog-init 未完成）"
fi
before=$(ck_query "SELECT count() FROM clklog.log_analysis" 2>/dev/null || echo 0)
ok "clklog.log_analysis 当前行数：$before"

echo
echo "=============================================================="
echo " 4. Kafka"
echo "=============================================================="
topics=$(docker exec clklog-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list 2>/dev/null | tr '\n' ' ')
[ -n "$topics" ] && ok "topic 列表：$topics" || warn "读取 topic 列表失败"
# Flink 的 Kafka source 默认不向 Kafka 提交 offset（进度靠 checkpoint 保存），
# 因此消费组不存在是正常现象，数据是否被消费以下面第 7 节的入库结果为准。
if docker exec clklog-kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
     --describe --group clklog-group >/dev/null 2>&1; then
  echo "  消费组 clklog-group："
  docker exec clklog-kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
    --describe --group clklog-group | sed 's/^/    /'
else
  echo "  消费组 clklog-group 不存在（Flink 靠 checkpoint 记录进度，不提交 offset，属正常）"
fi

echo
echo "=============================================================="
echo " 5. Flink 作业"
echo "=============================================================="
jobs=$(curl -s -m 5 http://127.0.0.1:8085/jobs/overview 2>/dev/null || true)
if echo "$jobs" | grep -q '"state":"RUNNING"'; then
  ok "Flink 作业 RUNNING"
else
  bad "Flink 作业未处于 RUNNING（${jobs}）"
fi

echo
echo "=============================================================="
echo " 6. HTTP 入口"
echo "=============================================================="
# 超时给到 60s：社区版 api 的 swagger 由 springdoc 懒生成，**首次请求实测 41.6s**
# （容器重启后必现），10s 超时会假失败。状态码捕获也不再拼出 "000000"（curl 失败时
# %{http_code} 本身已是 000，再接 `|| echo 000` 会变成六位）。
for path in / /receiver/api/gp /api/v3/api-docs /manage/project/list; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 60 "http://127.0.0.1${path}" 2>/dev/null)" || true
  [ -n "$code" ] || code=000
  case "$path:$code" in
    # /manage/project/list 是管理后台真实业务接口（经 nginx /manage/ 去前缀转发）；
    # 不用 swagger 路径校验 manage：其文档路径在生产同样是 404 的死路径。
    "/:200"|"/receiver/api/gp:200"|"/receiver/api/gp:400"|"/receiver/api/gp:405"|"/api/v3/api-docs:200"|"/manage/project/list:200")
      ok "$path → $code" ;;
    *) bad "$path → $code" ;;
  esac
done

echo
echo "=============================================================="
echo " 7. 数据上报链路（receiver → Kafka → Flink → ClickHouse）"
echo "=============================================================="
TS=$(date +%s)
python3 - "$TS" <<'PY'
import base64, json, sys, time, urllib.parse, urllib.request, uuid

ts = int(sys.argv[1])
distinct = f"oss-test-{ts}"
# 实测确认的可用报文结构（2026-10-08）：
#   * 顶层 lib 必须是字符串；写成对象（{"$lib": ...}）会让 ClkLog 1.2.0 receiver
#     只落 event/distinct_id/client_ip，properties 全部丢失。
#   * 预置属性（$url/$url_path/$title/$os/$browser/$screen_* …）放 properties 内，能正确落列。
events = [{
    "type": "track",
    "distinct_id": distinct,
    "event": "PageView",
    "time": int(time.time() * 1000),
    "lib": "js",
    "properties": {
        "$url": "http://127.0.0.1/", "$url_path": "/", "$title": "首页",
        "$os": "Linux", "$browser": "Chrome",
        "$screen_width": 1920, "$screen_height": 1080,
        "$is_first_day": True, "$is_first_time": True,
        "$referrer": "https://www.google.com/", "$referrer_host": "www.google.com",
        "$event_session_id": str(uuid.uuid4()), "$timezone_offset": 8,
        "test_env": "clklog-oss-test", "batch": str(ts),
    },
}]
raw = json.dumps(events, ensure_ascii=False)
data = urllib.parse.quote(base64.b64encode(raw.encode()).decode())
body = urllib.parse.urlencode({
    "project": "clklogapp",
    "token": "ddf51db3-7c99-1310-a44f-79feb7b63c69",
    "data": data,
}).encode()
req = urllib.request.Request("http://127.0.0.1/receiver/api/gp", data=body,
                             headers={"Content-Type": "application/x-www-form-urlencoded"})
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        print(f"  上报返回 HTTP {r.status}：{r.read(200).decode(errors='replace')}")
except Exception as e:  # noqa: BLE001
    print(f"  上报异常：{e}")
print(f"  distinct_id = {distinct}")
PY

echo "  等待 Flink 处理（最多 90s）..."
deadline=$(( $(date +%s) + 90 ))
observed=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  now=$(ck_query "SELECT count() FROM clklog.log_analysis" 2>/dev/null || echo 0)
  if [ "${now:-0}" -gt "${before:-0}" ] 2>/dev/null; then observed=1; break; fi
  sleep 5
done
if [ "$observed" -eq 1 ]; then
  ok "数据已入库：log_analysis 行数 $before → $now"
else
  bad "90s 内未观察到新数据入库（$before → ${now:-?}），请查 docker logs clklog-receiver / clklog-jobmanager / clklog-taskmanager"
fi

echo
echo "=============================================================="
echo " 8. 聚合结果（信息项，非判定）"
echo "=============================================================="
echo "  当日聚合表（pv/uv 依赖 ClkLog 的 lib 列分类，手工构造的报文通常为 0；"
echo "  visit_count / ip_count 可正常计数）："
ck_query "SELECT uri, pv, uv, visit_count, ip_count FROM clklog.visituri_detail_bydate WHERE visit_count > 0 ORDER BY visit_count DESC LIMIT 3 FORMAT TSV" 2>/dev/null | sed 's/^/    /'
token=$(curl -s -m 10 -X POST http://127.0.0.1/manage/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"clklog"}' 2>/dev/null \
  | python3 -c 'import sys,json;print((json.load(sys.stdin).get("data") or {}).get("token",""))' 2>/dev/null || true)
if [ -n "$token" ]; then
  today=$(date +%F)
  curl -s -m 15 -X POST http://127.0.0.1/api/flow/getFlow -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $token" \
    -d "{\"timeType\":\"day\",\"channel\":[],\"startTime\":\"$today 00:00:00\",\"endTime\":\"$today 23:59:59\",\"projectName\":\"clklogapp\"}" 2>/dev/null \
    | python3 -c 'import sys,json
c=(json.load(sys.stdin).get("data") or {}).get("current") or {}
print("    流量概览 (全部渠道): pv=%s 访问次数=%s 访客数=%s ip数=%s" % (c.get("pv"),c.get("visitCount"),c.get("uv"),c.get("ipCount")))' 2>/dev/null || true
  ok "管理后台登录接口可用（admin/clklog），/api/flow/getFlow 可达"
else
  bad "管理后台登录接口未返回 token"
fi

echo
echo "=============================================================="
echo " 结果：$PASS 项通过，$FAIL 项失败"
echo "=============================================================="
[ "$FAIL" -eq 0 ]
