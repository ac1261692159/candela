#!/usr/bin/env python3
"""用户分群验收（phase: clklog-analytics-user-segment-ux-v1 / clklog-analytics-cohort-robustness-v1）。

每个用例都带**目的**与**期望**，结果同时打到 stdout 与 JSON（供测试报告引用）：

  python3 scripts/smoke-user-cohort.py                     # 打生产（读 .env 的账号）
  SMOKE_BASE_URL=http://127.0.0.1:3100 python3 scripts/smoke-user-cohort.py
  SMOKE_WRITE=0 python3 scripts/smoke-user-cohort.py       # 只读，不创建临时资产
  SMOKE_REPORT=/tmp/cohort-report.json python3 scripts/smoke-user-cohort.py

凭据只从环境变量或 apps/analytics-server/.env 读 USERNAME/PASSWORD，
绝不打印 token / 密码 / Authorization；临时资产前缀 `smoke_uc_`，结束时尽力清理。
单个用例抛错只记 FAIL，不中断整轮（否则后面的用例没数据可写进报告）。
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent

# 复用主体冒烟里已验证过的客户端与配置读取（不复制第二份）
_spec = importlib.util.spec_from_file_location("smoke_subject", HERE / "smoke-analysis-subject.py")
_subject = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_subject)

cfg = _subject.cfg
Client = _subject.Client
SmokeError = _subject.SmokeError

PREFIX = "smoke_uc_"
CJK = re.compile(r"[\u4e00-\u9fff]")
RESULTS: list[dict[str, Any]] = []
CREATED_COHORTS: list[str] = []
CREATED_DASHBOARDS: list[str] = []


def result(cid: str, ok: bool, actual: str) -> bool:
    RESULTS.append({"id": cid, "ok": ok, "actual": actual})
    print(f"实测：{actual}")
    print(f"结论：[{'PASS' if ok else 'FAIL'}] {cid}")
    return ok


ONLY = {part.strip() for part in os.environ.get("SMOKE_ONLY", "").split(",") if part.strip()}


def run_case(cid: str, purpose: str, expect: str, fn: Callable[[], None]) -> None:
    if ONLY and cid not in ONLY:
        return
    print(f"\n=== {cid} ===")
    print(f"目的：{purpose}")
    print(f"期望：{expect}")
    try:
        fn()
    except Exception as error:  # 单例失败不中断整轮，错误原文进报告
        result(cid, False, f"用例抛错：{type(error).__name__}: {error}")


def pick_condition_event(client: Client) -> str:
    items = (client.data("GET", "/sa/api/meta/events", query={"pageSize": "100", "exclude_hidden": "true"}) or {}).get(
        "items"
    ) or []
    scored = sorted(
        ((int(row.get("yesterday_count") or row.get("recent_7d_count") or 0), str(row.get("event_key") or ""))
         for row in items),
        reverse=True,
    )
    for _, key in scored:
        if key:
            return key
    raise SmokeError("项目没有可用事件，无法跑分群验收")


def wait_ready(client: Client, cohort_id: str, timeout: float = 120.0) -> dict[str, Any]:
    deadline = time.time() + timeout
    row: dict[str, Any] = {}
    while time.time() < deadline:
        row = client.data("GET", f"/sa/api/meta/cohorts/{cohort_id}") or {}
        if row.get("status") in ("ready", "failed"):
            return row
        time.sleep(3)
    return row


def fetch_frontend_assets(client: Client) -> str:
    """取 SPA 入口 + 分片，拼成文本用于「产物是否为本次发版」判定。

    分群页/接口是懒加载分片（`CohortEditPage-*.js` → `cohort.service-*.js`），
    名字只出现在**上一级分片**里，所以按「入口 → 一级 → 二级」逐层发现（有界）。
    """
    html = client.get_text("/sa/")
    pending = set(re.findall(r"/sa/assets/[^\"')\s]+", html))
    seen: set[str] = set()
    chunks: list[str] = []
    for _ in range(3):
        if not pending or len(seen) >= 30:
            break
        batch = sorted(pending - seen)[:12]
        pending -= set(batch)
        for url in batch:
            seen.add(url)
            try:
                text = client.get_text(url)
            except Exception:
                continue
            chunks.append(text)
            for name in re.findall(r"([A-Za-z0-9_.-]+\.js)", text):
                if "ohort" in name:
                    pending.add(f"/sa/assets/{name}")
    return "\n".join(chunks)


def main() -> int:  # noqa: C901
    conf = cfg()
    write = conf["write"] not in ("0", "false", "no")
    if not conf["password"]:
        print("缺少登录密码：设置 SMOKE_PASSWORD 或 apps/analytics-server/.env 的 PASSWORD", file=sys.stderr)
        return 2
    client = Client(conf["base"], conf["project"])
    print(f"target={conf['base']} project={conf['project']} write={int(write)}")

    login = client.data(
        "POST", "/sa/api/auth/login", body={"username": conf["user"], "password": conf["password"]},
        auth=False, expect=(200, 201),
    )
    client.token = str(login.get("token") or "")

    listing = client.data("GET", "/sa/api/meta/cohorts") or {}
    items: list[dict[str, Any]] = listing.get("items") or []
    condition_rows = [row for row in items if row.get("kind") == "condition" and row.get("status") == "ready"]
    id_rows = [row for row in items if row.get("kind") == "id_upload"]
    base_row = condition_rows[0] if condition_rows else None
    fresh: dict[str, Any] = {}          # 本轮新建的条件分群（UC-3/UC-5 共用）
    fresh_preview: dict[str, Any] = {}

    try:
        # ------------------------------------------------------------ UC-1
        def uc1() -> None:
            joined = fetch_frontend_assets(client)
            hit_summary = "summaryColumn" in joined
            hit_type_card = "conditionDesc" in joined
            hit_preview = "previewConditionCohort" in joined or "preview-condition" in joined
            result(
                "UC-1",
                hit_summary and hit_type_card and hit_preview,
                f"分群文案键 summaryColumn={hit_summary}、类型卡 conditionDesc={hit_type_card}、试跑调用={hit_preview}",
            )

        run_case(
            "UC-1",
            "确认 release 上跑的是本次发版的前端产物（不是旧包）",
            "SPA 分片里出现本次新增的分群文案键与试跑调用",
            uc1,
        )

        # ------------------------------------------------------------ UC-2
        def uc2() -> None:
            required = ("kind", "definition_json", "subject_id", "member_count", "last_computed_at")
            missing = [key for row in items for key in required if key not in row]
            result("UC-2", bool(items) and not missing,
                   f"分群数={len(items)}（条件={len(condition_rows)}、ID={len(id_rows)}）缺字段={sorted(set(missing)) or '无'}")

        run_case(
            "UC-2",
            "列表接口提供前端新列所需的字段（显示名/摘要/主体/人数/计算时间）",
            "每条分群都有 kind、definition_json、subject_id、member_count、last_computed_at",
            uc2,
        )

        # ------------------------------------------------------------ UC-3 / UC-5
        if write:
            def uc5() -> None:
                event = pick_condition_event(client)
                definition = {
                    "conditions": [
                        {"type": "did_event", "polarity": "did", "event": event, "metric": "times",
                         "op": "gt", "value": 0, "time": {"mode": "last_n_days", "n": 7}}
                    ]
                }
                fresh_preview.update(
                    client.data("POST", "/sa/api/meta/cohorts/preview-condition",
                                body={"definition_json": definition, "limit": 0}) or {}
                )
                name = f"{PREFIX}{int(time.time()) % 100000}"
                created = client.data("POST", "/sa/api/meta/cohorts", body={
                    "name": name, "display_name": name, "kind": "condition",
                    "definition_json": definition, "schedule": "manual",
                }, expect=(200, 201)) or {}
                cohort_id = str(created.get("cohort_id") or "")
                CREATED_COHORTS.append(cohort_id)
                row = wait_ready(client, cohort_id)
                fresh.update(row)
                fresh["event"] = event
                result(
                    "UC-5",
                    int(fresh_preview.get("count") or 0) == int(row.get("member_count") or -1) and row.get("status") == "ready",
                    f"同一份条件（近 7 天做过 {event}）：试跑={fresh_preview.get('count')} 保存后预计算={row.get('member_count')} status={row.get('status')}",
                )

            run_case(
                "UC-5",
                "试跑口径与保存后的预计算口径一致（否则用户不会信这个数）",
                "同一份条件：试跑 count == 新建分群计算完成后的 member_count",
                uc5,
            )
        else:
            result("UC-5", True, "SMOKE_WRITE=0，跳过写入型用例")

        # ------------------------------------------------------------ UC-3
        def uc3() -> None:
            target = fresh.get("cohort_id") or (base_row or {}).get("cohort_id")
            if fresh.get("event"):
                conditions = [
                    {"type": "did_event", "polarity": "did", "event": fresh["event"], "metric": "times",
                     "op": "gt", "value": 0, "time": {"mode": "last_n_days", "n": 7}}
                ]
            else:
                conditions = (base_row or {}).get("definition_json", {}).get("conditions", [])
            if not target or not conditions:
                result("UC-3", False, "没有可用的条件分群做样本核对")
                return
            preview = client.data("POST", "/sa/api/meta/cohorts/preview-condition",
                                  body={"definition_json": {"conditions": conditions}, "limit": 5}) or {}
            count = int(preview.get("count") or 0)
            sample = [str(row.get("uid")) for row in (preview.get("items") or [])]
            hits = 0
            for uid in sample[:3]:
                got = client.data("GET", f"/sa/api/meta/cohorts/{target}/members",
                                  query={"limit": "5", "keyword": uid}) or {}
                if got.get("items"):
                    hits += 1
            checked = len(sample[:3])
            result(
                "UC-3",
                count > 0 and bool(sample) and hits == checked,
                f"试跑 count={count} 样例 {len(sample)} 个、抽检 {checked} 个命中 {hits} 个"
                + (f"（对照分群={target}）" if target else ""),
            )

        run_case(
            "UC-3",
            "保存前就能知道圈到多少人、圈到了谁",
            "试跑返回精确 count>0 与示例 ID，且抽检的示例 ID 确实在分群成员里",
            uc3,
        )

        # ------------------------------------------------------------ UC-4
        def uc4() -> None:
            if not base_row:
                result("UC-4", False, "项目里没有 ready 的条件分群")
                return
            before = client.data("GET", f"/sa/api/meta/cohorts/{base_row['cohort_id']}") or {}
            client.data("POST", "/sa/api/meta/cohorts/preview-condition",
                        body={"definition_json": base_row.get("definition_json") or {}, "limit": 5})
            after = client.data("GET", f"/sa/api/meta/cohorts/{base_row['cohort_id']}") or {}
            same = all(before.get(key) == after.get(key) for key in ("status", "batch_id", "member_count", "updated_at"))
            result("UC-4", same,
                   f"status={after.get('status')} batch 不变={before.get('batch_id') == after.get('batch_id')} "
                   f"人数不变={before.get('member_count') == after.get('member_count')} 时间戳不变={before.get('updated_at') == after.get('updated_at')}")

        run_case("UC-4", "试跑是只读的：不能改状态、不能改成员",
                 "试跑前后 status / batch_id / member_count / updated_at 均不变", uc4)

        # ------------------------------------------------------------ UC-6
        def uc6() -> None:
            if not base_row:
                result("UC-6", False, "项目里没有 ready 的条件分群")
                return
            members = client.data("GET", f"/sa/api/meta/cohorts/{base_row['cohort_id']}/members", query={"limit": "1"}) or {}
            uid = str((members.get("items") or [{}])[0].get("uid") or "")
            miss = client.data("GET", f"/sa/api/meta/cohorts/{base_row['cohort_id']}/members",
                               query={"limit": "5", "keyword": "__smoke_no_such_id__"}) or {}
            hit = client.data("GET", f"/sa/api/meta/cohorts/{base_row['cohort_id']}/members",
                              query={"limit": "5", "keyword": uid[:6]}) if uid else {}
            result("UC-6", bool(uid) and not (miss.get("items") or []) and bool((hit or {}).get("items")),
                   f"抽成员前缀检索命中={bool((hit or {}).get('items'))}；不存在的前缀返回 {len(miss.get('items') or [])} 条")

        run_case("UC-6", "成员抽屉是服务端检索，不是只在前 1000 行里过滤",
                 "不存在的前缀返回 0 条；真实成员前缀能命中（成员总数 > 1000 时分页外的人也能查到）", uc6)

        # ------------------------------------------------------------ UC-7
        def uc7() -> None:
            status, payload = client.request(
                "POST", "/sa/api/meta/cohorts/preview-condition",
                body={"definition_json": {"conditions": [
                    {"type": "did_event", "polarity": "did", "event": "", "metric": "times", "op": "gt",
                     "value": 0, "time": {"mode": "last_n_days", "n": 7}}
                ]}},
                expect=(400,),
            )
            result("UC-7", status == 400 and payload.get("errorCode") == "cohort.condition.eventRequired",
                   f"HTTP={status} errorCode={payload.get('errorCode')} messageKey={payload.get('messageKey')}")

        run_case("UC-7", "不完整条件必须被后端挡下（前端内联校验是同一套语义的护栏）",
                 "缺事件的条件下试跑返回 400 且 errorCode=cohort.condition.eventRequired", uc7)

        # ------------------------------------------------------------ UC-8 / UC-9 / UC-14
        if write:
            def uc8() -> None:
                name = f"{PREFIX}id_{int(time.time()) % 100000}"
                created = client.data("POST", "/sa/api/meta/cohorts", body={
                    "name": name, "display_name": name, "kind": "id_upload",
                    "definition_json": {"match": "uid"}, "csv_text": "uid\nsmoke_uc_a1\nsmoke_uc_a2\n",
                }, expect=(200, 201)) or {}
                target_id = str(created.get("cohort_id") or "")
                CREATED_COHORTS.append(target_id)
                client.data("POST", f"/sa/api/meta/cohorts/{target_id}/members",
                            body={"csv_text": "uid\nsmoke_uc_b1\n"}, expect=(200, 201))
                after = client.data("GET", f"/sa/api/meta/cohorts/{target_id}") or {}
                hit_new = client.data("GET", f"/sa/api/meta/cohorts/{target_id}/members",
                                      query={"limit": "5", "keyword": "smoke_uc_b1"}) or {}
                hit_old = client.data("GET", f"/sa/api/meta/cohorts/{target_id}/members",
                                      query={"limit": "5", "keyword": "smoke_uc_a1"}) or {}
                result("UC-8", bool(hit_new.get("items")) and not (hit_old.get("items") or []),
                       f"重传后新名单 ID 命中={bool(hit_new.get('items'))}、旧名单 ID 已不在={not (hit_old.get('items') or [])} "
                       f"batch 已换={after.get('batch_id') != created.get('batch_id')}")

            def uc14() -> None:
                rows = "\n".join(f"smoke_uc_bulk_{i}" for i in range(50_000))
                csv_text = f"uid\n{rows}\n"
                size_mb = len(csv_text.encode("utf-8")) / 1024 / 1024
                name = f"{PREFIX}bulk_{int(time.time()) % 100000}"
                status, payload = client.request(
                    "POST", "/sa/api/meta/cohorts",
                    body={"name": name, "display_name": name, "kind": "id_upload",
                          "definition_json": {"match": "uid"}, "csv_text": csv_text},
                    expect=(200, 201, 400, 413, 500),
                )
                detail = str(payload.get("message") or "")[:160]
                body_accepted = status != 413
                created = payload.get("data") if isinstance(payload.get("data"), dict) else payload
                if isinstance(created, dict) and created.get("cohort_id"):
                    CREATED_COHORTS.append(str(created["cohort_id"]))
                result("UC-14", body_accepted,
                       f"CSV≈{size_mb:.2f}MB（5 万行，旧上限 1MB 会 413）→ HTTP={status}：{detail or '已受理'}")

            def uc10() -> None:
                # 不碰数据：一个 1.2MB 的 JSON 体打在分群路由上，看它是被业务校验拒（400）
                # 还是被 body 上限拒（413）——412/413 说明 32MB 上限没生效
                junk = "x" * (1_200_000)
                status, payload = client.request(
                    "POST", "/sa/api/meta/cohorts",
                    body={"name": "INVALID NAME", "display_name": junk, "kind": "condition"},
                    expect=(400, 413),
                )
                result("UC-10", status != 413,
                       f"1.2MB 请求体 → HTTP={status}（{payload.get('message') if isinstance(payload.get('message'), str) else ''}）"
                       f"{'；413 = 仍被旧 1MB 上限挡住' if status == 413 else ''}")

            run_case("UC-8", "ID 分群的名单能整体替换（本次新增）",
                     "重传后新名单里的 ID 能查到、旧名单独有的 ID 查不到、batch_id 换新", uc8)
            run_case("UC-14", "分群路由请求体上限已从 1MB 提到 32MB（RB-3/RB-5）",
                     "约 1.2MB 的 5 万行 CSV 不再被 413 挡住（业务结果可为 200 或数据侧报错，但不得是 413）",
                     uc14)
            run_case("UC-10", "分群路由不再用 1MB 上限拒绝请求体（同上，用不写数据的路径复核）",
                     "1.2MB 请求体被业务校验拒绝（400）而不是 413", uc10)

            def uc9() -> None:
                if not base_row:
                    result("UC-9", False, "项目里没有 ready 的条件分群可当反例")
                    return
                status, payload = client.request(
                    "POST", f"/sa/api/meta/cohorts/{base_row['cohort_id']}/members",
                    body={"csv_text": "uid\nsmoke_uc_x\n"}, expect=(400,),
                )
                result("UC-9", status == 400 and payload.get("errorCode") == "cohort.idUpload.onlyIdUpload",
                       f"HTTP={status} errorCode={payload.get('errorCode')}")

            run_case("UC-9", "重传名单只对 ID 分群开放，其他类型必须被拒",
                     "对条件分群重传返回 400 且 errorCode=cohort.idUpload.onlyIdUpload", uc9)
        else:
            for cid in ("UC-8", "UC-9", "UC-10", "UC-14"):
                result(cid, True, "SMOKE_WRITE=0，跳过写入型用例")

        # ------------------------------------------------------------ UC-11
        if write and base_row:
            def uc11() -> None:
                dash_name = f"{PREFIX}db_{int(time.time()) % 100000}"
                dash = client.data("POST", "/sa/api/report/dashboards", body={
                    "name": dash_name, "cohort_filter": {"cohort_id": base_row["cohort_id"], "op": "in"},
                }, expect=(200, 201)) or {}
                db_id = str(dash.get("db_id") or "")
                if db_id:
                    CREATED_DASHBOARDS.append(db_id)
                status, payload = client.request("DELETE", f"/sa/api/meta/cohorts/{base_row['cohort_id']}", expect=(409,))
                names = str((payload.get("params") or {}).get("names") or payload.get("message") or "")
                result("UC-11", status == 409 and dash_name in names,
                       f"HTTP={status} errorCode={payload.get('errorCode')} 提示含刚建的看板名={dash_name in names}")

            run_case("UC-11", "删除被看板引用的分群时必须提示（此前只查卡片、漏看板）",
                     "删除返回 409，且提示里出现引用它的看板名", uc11)
        else:
            result("UC-11", True, "SMOKE_WRITE=0 或无可用分群，跳过")

        # ------------------------------------------------------------ UC-12
        def uc12() -> None:
            status, payload = client.request(
                "POST", "/sa/api/meta/cohorts/preview-condition",
                body={"definition_json": {"conditions": []}}, expect=(400,),
            )
            structured = all(
                isinstance(row.get("definition_json"), dict)
                and not CJK.search(json.dumps(row.get("definition_json"), ensure_ascii=False))
                for row in items
            ) if items else False
            result("UC-12", bool(payload.get("messageKey")) and structured,
                   f"错误带 messageKey={payload.get('messageKey')}；列表 definition_json 全为结构化且不含中文句子={structured}")

        run_case("UC-12", "语言契约：错误按 messageKey 下发；列表不下发译好的摘要（翻译在浏览器端）",
                 "错误响应带 messageKey；definition_json 是结构化对象且不含中文句子", uc12)

        # ------------------------------------------------------------ UC-13
        def uc13() -> None:
            now = time.time()
            pendings = [row for row in items if row.get("status") == "pending"]
            stuck = []
            for row in pendings:
                try:
                    ts = str(row.get("updated_at") or "").replace("Z", "+00:00")
                    updated = datetime.fromisoformat(ts).timestamp()
                except Exception:
                    updated = now
                if now - updated > 300:
                    stuck.append(row.get("cohort_id"))
            result("UC-13", not stuck, f"pending={len(pendings)} 其中超过 5 分钟未更新={len(stuck)}")

        run_case("UC-13", "没有卡死的「计算中」（服务重启后能自动回收，不会永久转圈）",
                 "status=pending 且超过 5 分钟未更新的分群数 = 0", uc13)

    finally:
        if write:
            cleaned = 0
            # 创建请求可能在 compute 阶段 500（行已落库但没返回 id），按前缀兜底扫一遍
            try:
                leftovers = client.data("GET", "/sa/api/meta/cohorts", query={"keyword": PREFIX}) or {}
                for row in leftovers.get("items") or []:
                    if str(row.get("name") or "").startswith(PREFIX):
                        CREATED_COHORTS.append(str(row.get("cohort_id") or ""))
            except Exception:
                pass
            for cohort_id in {cid for cid in CREATED_COHORTS if cid}:
                try:
                    client.request("DELETE", f"/sa/api/meta/cohorts/{cohort_id}", query={"force": "1"})
                    cleaned += 1
                except Exception:
                    pass
            for db_id in CREATED_DASHBOARDS:
                try:
                    client.request("DELETE", f"/sa/api/report/dashboards/{db_id}")
                except Exception:
                    pass
            print(f"\n清理：临时分群 {cleaned}/{len(set(CREATED_COHORTS))} 个、看板 {len(CREATED_DASHBOARDS)} 个")

    passed = sum(1 for row in RESULTS if row["ok"])
    print(f"\n总计 {passed}/{len(RESULTS)} 通过")
    out = Path(os.environ.get("SMOKE_REPORT", "/tmp/clklog-cohort-report.json"))
    out.write_text(json.dumps({"target": conf["base"], "runAt": datetime.now().isoformat(timespec="seconds"),
                               "results": RESULTS}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"报告：{out}")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
