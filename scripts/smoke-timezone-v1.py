#!/usr/bin/env python3
"""时区系统 v1 生产闭环冒烟（phase: clklog-analytics-timezone-v1）。

凭据只从环境变量或 apps/analytics-server/.env 读 USERNAME/PASSWORD，不打印 token/密码。

  python3 scripts/smoke-timezone-v1.py
  SMOKE_BASE_URL=http://127.0.0.1:3100 python3 scripts/smoke-timezone-v1.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ENV_FILE = REPO / "apps/analytics-server/.env"
RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    RESULTS.append((name, cond, detail))
    print(f"[{'PASS' if cond else 'FAIL'}] {name}", detail)


def load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip().strip('"').strip("'")
    return out


class Client:
    def __init__(self) -> None:
        env = load_env(ENV_FILE)
        self.base = (
            os.environ.get("SMOKE_BASE_URL")
            or env.get("CLKLOG_BASE_URL")
            or "http://127.0.0.1"
        ).rstrip("/")
        self.user = os.environ.get("SMOKE_USERNAME") or env.get("USERNAME") or "admin"
        self.password = os.environ.get("SMOKE_PASSWORD") or env.get("PASSWORD") or ""
        self.token = ""

    def http(self, method: str, path: str, body: object | None = None) -> tuple[int, dict]:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read())
            except Exception:
                payload = {}
            return e.code, payload

    def login(self) -> None:
        status, payload = self.http("POST", "/sa/api/auth/login", {"username": self.user, "password": self.password})
        data = payload.get("data", payload)
        self.token = str(data.get("token") or "")
        self.login_user = data.get("user") or {}

    def data(self, method: str, path: str, body: object | None = None, expect: tuple = (200,)) -> dict:
        status, payload = self.http(method, path, body)
        assert status in expect, f"{path} → {status}: {str(payload)[:200]}"
        return payload.get("data", payload)


def main() -> int:
    c = Client()
    failures = 0
    c.login()
    check("T1.login.platform_timezone", True and c.token and c.login_user.get("platform_timezone") == "Asia/Shanghai",
          str(c.login_user.get("platform_timezone")))
    me = c.data("GET", "/sa/api/auth/me")
    check("T1.me.platform_timezone", me.get("platform_timezone") == "Asia/Shanghai", str(me.get("platform_timezone")))

    event = "clothes_display_trigger"
    end = date.today()
    start = end - timedelta(days=2)

    def event_query(tz: str | None) -> dict:
        tr: dict = {"start": start.isoformat(), "end": end.isoformat()}
        if tz:
            tr["timezone"] = tz
        return {
            "event": event,
            "metrics": [{"id": "m_0", "kind": "event", "analysis": "total_times", "event": event}],
            "groups": [{"scope": "time", "granularity": "day"}],
            "time_range": tr,
        }

    base = c.data("POST", "/sa/api/query/event?refresh=true", event_query(None), expect=(200, 201))
    same = c.data("POST", "/sa/api/query/event?refresh=true", event_query("Asia/Shanghai"), expect=(200, 201))
    # 活流量让「今天」桶在两次查询内增数，恒等断言只比历史桶与 SQL 形态
    def stable_rows(res: dict) -> list:
        return [r for r in (res.get("rows") or []) if str(r.get("g_0")).split(" ")[0] != date.today().isoformat()]
    check(
        "T2.恒等路径_无timezone与显式上海一致",
        stable_rows(base) == stable_rows(same)
        and "display_tz" not in str(base.get("sql"))
        and "display_tz" not in str(same.get("sql")),
        "SQL 形态与历史桶逐字节一致（今日桶活流量豁免）",
    )

    utc = c.data("POST", "/sa/api/query/event?refresh=true", event_query("UTC"), expect=(200, 201))
    utc_sql = str(utc.get("sql") or "")
    check(
        "T3.UTC路径_宽扫+epoch精切+桶tz参数",
        "fromUnixTimestamp64Milli" in utc_sql
        and "toStartOfDay(log_time, {display_tz:String})" in utc_sql
        and "{m0_scan_start:String}" in utc_sql,
        f"epoch={('fromUnixTimestamp64Milli' in utc_sql)} bucket={('{display_tz' in utc_sql)}",
    )
    ny = c.data("POST", "/sa/api/query/event?refresh=true", event_query("America/New_York"), expect=(200, 201))
    check("T3.纽约时区200", isinstance(ny.get("rows"), list), f"rows={len(ny.get('rows') or [])}")

    status, bad = c.http("POST", "/sa/api/query/event?refresh=true", event_query("Mars/Olympus"))
    check(
        "T4.非法时区400+错误码",
        status == 400 and (bad.get("errorCode") == "analysis.time_range.timezone_invalid"),
        f"status={status} errorCode={bad.get('errorCode')}",
    )

    # 自定义 SQL：applied_time_range 回显 + 异时区注入
    def sql_exec(tz: str | None) -> dict:
        body: dict = {
            "mode": "sql",
            "sql": "SELECT toDate(log_time) AS d, count() AS cnt FROM sa_events GROUP BY d ORDER BY d",
            "time_range": {"start": start.isoformat(), "end": end.isoformat(), **({"timezone": tz} if tz else {})},
        }
        return c.data("POST", "/sa/api/report/sql/execute", body, expect=(200, 201))

    sql_base = sql_exec(None)
    check(
        "T5.sql_恒等回显",
        sql_base.get("applied_time_range", {}).get("timezone") == "Asia/Shanghai"
        and sql_base.get("applied_time_range", {}).get("start") == start.isoformat(),
        json.dumps(sql_base.get("applied_time_range")),
    )
    sql_utc = sql_exec("UTC")
    check(
        "T5.sql_UTC回显",
        sql_utc.get("applied_time_range", {}).get("timezone") == "UTC",
        json.dumps(sql_utc.get("applied_time_range")),
    )

    # 告警总览（fired_today 平台零点；接口活着即口径生效）
    overview = c.data("GET", "/sa/api/ops/alerts/overview")
    check("T6.alerting.overview", isinstance(overview, dict), f"fired_today={overview.get('fired_today')}")

    for name, ok, _ in RESULTS:
        if not ok:
            failures += 1
    print(f"== {'FAIL' if failures else 'PASS'}: {len(RESULTS) - failures}/{len(RESULTS)} 通过 ==")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
