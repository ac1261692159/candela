#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ClkLog 神策数据格式最简上报客户端（Python 3，仅标准库，生产可用骨架）。

规范文档：仓库根目录《数据上报规范与流程.md》§1（编码硬要求）、§2（事件结构）、§3（用户标识口径）。

要点：
- 表单字段 data = JSON 数组 → base64 → urlencode；直接 POST 原始 JSON 会 200 但静默丢数据（§1.3）；
- ClkLog 不解析神策顶层 login_id/original_id：登录ID 走 identities.user_key，
  登录绑定匿名ID 走 properties.$track_signup_original_id（§3）。
"""

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_ENDPOINT = "https://example.com/receiver/api/gp"
DEFAULT_PROJECT = "clklogapp"
EVENT_NAME = "SdkSpecTest"


class ClkLogClient:
    """神策数据格式上报客户端：攒批 + 表单编码 + 超时 + 失败重试退避。"""

    def __init__(self, endpoint, project, token, batch_size=10, timeout=10.0, max_attempts=3):
        self._endpoint = endpoint      # 上报地址
        self._project = project        # 项目名
        self._token = token            # 项目 token（禁止硬编码，见 AGENTS.md 红线 3）
        self._batch_size = batch_size if batch_size > 0 else 10
        self._timeout = timeout        # 单次 HTTP 超时（秒）
        self._max_attempts = max_attempts
        self._queue = []               # 待发送事件
        self._login_id = None          # 登录ID，login() 后自动携带到 identities.user_key

    # ---------- 业务 API ----------

    def track(self, distinct_id, event, properties=None):
        """行为事件；登录后自动携带 identities.user_key。"""
        event_obj = {
            "type": "track",
            "event": event,
            "distinct_id": distinct_id,
            "time": int(time.time() * 1000),  # 毫秒时间戳（秒级会时间错乱）
            "properties": properties if properties is not None else {},
        }
        self._enqueue(self._with_identity(event_obj))

    def profile_set(self, distinct_id, properties):
        """用户属性（覆盖写）；登录后自动携带 identities.user_key。"""
        event_obj = {
            "type": "user_set",
            "distinct_id": distinct_id,
            "time": int(time.time() * 1000),
            "properties": properties if properties is not None else {},
        }
        self._enqueue(self._with_identity(event_obj))

    def login(self, login_id, anonymous_id):
        """登录关联：上报 track_signup 绑定匿名ID，之后事件自动带 user_key。

        ClkLog 口径：identities.user_key=登录ID，properties.$track_signup_original_id=匿名ID。
        """
        self._login_id = login_id
        self._enqueue({
            "type": "track_signup",
            "event": "$SignUp",
            "distinct_id": login_id,
            "identities": {"user_key": login_id},
            "properties": {"$track_signup_original_id": anonymous_id},
            "time": int(time.time() * 1000),
        })

    def flush(self):
        """发送队列内全部事件：JSON 数组 → base64 → urlencode 表单 POST，失败重试退避。"""
        if not self._queue:
            return
        payload = base64.b64encode(
            json.dumps(self._queue, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ).decode("ascii")
        body = urllib.parse.urlencode(
            {"project": self._project, "token": self._token, "data": payload}
        ).encode("ascii")

        last_error = None
        for attempt in range(1, self._max_attempts + 1):
            # 每次重试重建 Request：退避后复用同一 body，避免状态残留
            request = urllib.request.Request(
                self._endpoint,
                data=body,
                method="POST",
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "*/*",
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=self._timeout) as resp:
                    resp.read()
                    if resp.status == 200:
                        print("[clklog] flushed {} events OK".format(len(self._queue)))
                        self._queue = []
                        return
                    last_error = "http {}".format(resp.status)
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", "replace")
                last_error = "http {}: {}".format(exc.code, detail)
            except Exception as exc:  # 网络错误 / 超时
                last_error = "{}: {}".format(type(exc).__name__, exc)
            time.sleep(attempt * 0.5)  # 线性退避
        raise RuntimeError(
            "flush failed after {} attempts: {}".format(self._max_attempts, last_error)
        )

    # ---------- 内部实现 ----------

    def _with_identity(self, event_obj):
        if self._login_id is not None:
            event_obj["identities"] = {"user_key": self._login_id}
        return event_obj

    def _enqueue(self, event_obj):
        self._queue.append(event_obj)
        if len(self._queue) >= self._batch_size:
            self.flush()


def load_dotenv():
    """按需加载 ../.env（已存在的环境变量优先），仅取 CLKLOG_* 键。"""
    candidates = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, ".env"),
        os.path.join(os.getcwd(), ".env"),
    ]
    for path in candidates:
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            continue
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key, value = key.strip(), value.strip()
                if key and not os.environ.get(key):
                    os.environ[key] = value
        print("[clklog] loaded env from {}".format(path))
        return
    print("[clklog] .env not found, fallback to system env")


def main():
    load_dotenv()

    # token 只从环境变量读取，禁止硬编码入库（AGENTS.md 红线 3）
    token = os.environ.get("CLKLOG_TOKEN")
    if not token:
        sys.stderr.write("missing env CLKLOG_TOKEN\n")
        return 1
    endpoint = os.environ.get("CLKLOG_ENDPOINT") or DEFAULT_ENDPOINT
    project = os.environ.get("CLKLOG_PROJECT") or DEFAULT_PROJECT

    run_id = "python-{}".format(int(time.time()))          # <lang>-<unix 秒>
    anon_id = "sdk-test-anon-{}".format(run_id)            # 匿名ID（登录前，全程稳定）
    login_id = "uid-python-{}".format(run_id)              # 登录ID

    cli = ClkLogClient(endpoint, project, token, batch_size=10)

    # 1. 登录前：匿名事件（不带 identities）
    cli.track(anon_id, EVENT_NAME, {
        "test_run_id": run_id, "sdk_lang": "python", "step": "before_login",
    })
    # 2. 登录关联：之后所有事件自动携带 identities.user_key
    cli.login(login_id, anon_id)
    # 3. 用户属性（登录态）
    cli.profile_set(anon_id, {
        "vip_level": 3, "register_channel": "app_store", "sdk_lang": "python",
    })
    # 4. 登录后行为事件：distinct_id 仍为匿名ID，登录ID走 identities.user_key
    cli.track(anon_id, EVENT_NAME, {
        "test_run_id": run_id,
        "sdk_lang": "python",
        "amount": 99.5,
        "is_new_user": True,
        "product_id": "P1001",
        "product_name": "测试商品",
    })
    # 5. 登录后购买事件
    cli.track(anon_id, "Purchase", {
        "test_run_id": run_id,
        "order_id": "O{}".format(run_id),
        "amount": 99.5,
        "pay_type": "alipay",
    })
    cli.flush()

    print("DONE run_id = {}".format(run_id))
    return 0


if __name__ == "__main__":
    sys.exit(main())
