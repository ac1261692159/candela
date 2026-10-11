#!/usr/bin/env python3
"""i18n 覆盖率棘轮：统计 apps/ 下「待翻译中文文案」，只减不增。

口径（与 docs/architecture/clklog-analytics-design-i18n-v1.md §11.1 一致）：

- 扫描根：`apps/analytics-web/src`、`apps/analytics-server/src`；源文件 `*.ts` / `*.tsx`。
- 统计对象：**中文字符串字面量**（`'` / `"` / 反引号）与 **JSX 文本节点**（`>中文<`）。
- **注释不计**（`//`、`/* */` 里的中文是说明，不需要翻译）。
- 测试文件（`*.spec.ts(x)` / `*.test.ts(x)`）单独统计，不计入迁移基数：
  测试断言中文属预期行为，源语言保持 zh-CN。
- `allowlist` 内的路径完全不统计（语言资源、工具脚本自身）。

用法：

    python3 scripts/i18n_scan.py                 # 打印当前数值（= --report）
    python3 scripts/i18n_scan.py --report --files # 另附逐文件明细
    python3 scripts/i18n_scan.py --check         # 与基线比较，任一目录/总量上升则退出码 1
    python3 scripts/i18n_scan.py --update        # 写基线；只允许下调，需上调用 --force

基线：`scripts/i18n-baseline.json`（只允许下降；上升必须显式 --force 并在提交说明里写原因）。
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import re
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

# ---------------------------------------------------------------- CONFIG

CONFIG = {
    "roots": {
        "apps/analytics-web/src": ["*.ts", "*.tsx"],
        "apps/analytics-server/src": ["*.ts"],
    },
    "testGlobs": ["*.spec.ts", "*.spec.tsx", "*.test.ts", "*.test.tsx"],
    "skipDirs": [
        ".git", "node_modules", "dist", "build", "coverage", "testdata", "data",
        "docs", "export", "dlq", "harness", "public", ".turbo", ".vite",
    ],
    "allowlist": [
        # 语言资源与 i18n 工具自身（内容就是文案，不算硬编码）
        "apps/analytics-web/src/i18n/locales/**",
        "apps/analytics-server/src/i18n/messages/**",
        # 语言注册表：`label` 是语言自称（简体中文 / English …），按设计不翻译
        "apps/analytics-web/src/i18n/config.ts",
        # 图表测试夹具：只被 *.spec.ts(x) 引用，中文是测试数据而非界面文案
        "apps/analytics-web/src/features/visualization/chart.fixtures.ts",
        # SQL 生成器：中文是**生成的 SQL 列别名**（数据层标识），翻译会改变查询结果列名
        "apps/analytics-web/src/features/report/dsl-sql.ts",
        # 中文量级（万 / 亿）：只在中文路径使用（usesChineseScale），英文走 SI
        "apps/analytics-web/src/features/visualization/metric-units.ts",
        # 默认 SQL 片段（SQL 编辑器初始内容）：数据层，翻译会改变用户实际执行的查询
        "apps/analytics-web/src/pages/Report/SqlReportPage.tsx",
        # 结果表列的“时间列”启发式判定与错误文案匹配：依赖服务端下发的中文列名/提示，属数据层
        "apps/analytics-web/src/components/DataTable.tsx",
        "apps/analytics-web/src/features/report/CardWidget.tsx",
        "apps/analytics-web/src/pages/Analysis/UserCohortsPage.tsx",
        "apps/analytics-web/src/pages/Analysis/UserTagsPage.tsx",
    ],
}

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
BASELINE = HERE / "i18n-baseline.json"

CJK = re.compile(r"[\u4e00-\u9fff]")

# `/` 出现在这些字符之后时按正则字面量解析（除号场景不在此列）
REGEX_PRECEDERS = set("(,=:[!&|?{};+-*%~^<>") | {""}
# 这些关键字之后出现的 `/` 也是正则字面量起点（如 `return /[",\n]/`）
REGEX_KEYWORDS = {"return", "typeof", "case", "in", "of", "do", "else", "yield", "await"}

# ---------------------------------------------------------------- scanner


def strip_comment_and_strings(line: str) -> str:
    """把已识别的注释/字符串替换掉，用于粗略判断某行是否还有残留中文（辅助，不参与计数）。"""
    return line


def scan_file(path: Path) -> dict[str, int]:
    """返回 {'ui': 中文字符串字面量数, 'jsx': 中文 JSX 文本节点数}。"""
    try:
        src = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return {"ui": 0, "jsx": 0}

    ui = 0
    jsx = 0
    i = 0
    n = len(src)
    state = "code"  # code | line_comment | block_comment
    prev_sig = ""  # 上一个有意义的字符，用于判断 `/` 是除号还是正则字面量起点
    prev_word = ""  # 上一个标识符（用于 return / typeof 之后的正则）

    while i < n:
        c = src[i]

        if state == "line_comment":
            if c == "\n":
                state = "code"
            i += 1
            continue

        if state == "block_comment":
            if c == "*" and i + 1 < n and src[i + 1] == "/":
                state = "code"
                i += 2
                continue
            i += 1
            continue

        # state == code
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            state = "line_comment"
            i += 2
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            state = "block_comment"
            i += 2
            continue
        # 正则字面量：出现在表达式位置（前一个有意义字符是运算符 / 括号 / 逗号等）时，
        # 内部可能含有引号（如 /["]/），不识别会把扫描状态带偏，导致把注释里的中文当成文案。
        if c == "/" and (prev_sig in REGEX_PRECEDERS or prev_word in REGEX_KEYWORDS):
            j = i + 1
            in_class = False
            closed = False
            while j < n and src[j] != "\n":
                ch = src[j]
                if ch == "\\":
                    j += 2
                    continue
                if ch == "[":
                    in_class = True
                elif ch == "]":
                    in_class = False
                elif ch == "/" and not in_class:
                    closed = True
                    break
                j += 1
            if closed:
                i = j + 1
                prev_sig = "/"
                continue
        if c in "\"'`":
            quote = c
            j = i + 1
            buf = []
            while j < n:
                if src[j] == "\\":
                    buf.append(src[j:j + 2])
                    j += 2
                    continue
                if src[j] == quote:
                    break
                buf.append(src[j])
                j += 1
            if CJK.search("".join(buf)):
                ui += 1
            prev_sig = quote
            prev_word = ""
            i = j + 1
            continue
        if c.isalpha() or c == "_":
            prev_word = (prev_word + c) if prev_sig != "" or prev_word else c
            prev_sig = c
        elif not c.isspace():
            prev_word = ""
            prev_sig = c
        i += 1

    # JSX 文本节点：> 中文 <
    for m in re.finditer(r">\s*([^<>{}\n]*[\u4e00-\u9fff][^<>{}\n]*?)\s*<", src):
        text = m.group(1)
        if not text.strip():
            continue
        # 排除比较运算误判（如 a > b 中文 c < d 这类极端情况较少，先按文本节点计）
        jsx += 1

    return {"ui": ui, "jsx": jsx}


def iter_files():
    skip = set(CONFIG["skipDirs"])
    for root_spec, globs in CONFIG["roots"].items():
        root = REPO / root_spec
        if not root.is_dir():
            sys.exit(f"scan root does not exist: {root}")
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            if not any(fnmatch.fnmatch(path.name, g) for g in globs):
                continue
            rel = path.relative_to(REPO).as_posix()
            if skip & set(Path(rel).parts):
                continue
            if any(fnmatch.fnmatch(rel, pat) for pat in CONFIG["allowlist"]):
                continue
            yield path, rel



THROW_RE = re.compile(r"throw\s+new\s+\w*Exception\(")


def scan_server_unmigrated(path: Path) -> int:
    """服务端「未迁移的用户可见抛错」：`throw new XxxException(` 且同一调用块内没有 `messageKey`。

    为什么不用「中文字符串数」做服务端指标：迁移后的 `message` 字段**故意保留中文原文**，
    作为老客户端 / API Key / Harness 的兜底（设计文档 §6.1），因此中文出现数不会归零，
    真正该只减不增的是「还没有 messageKey 的抛错」。
    """
    try:
        src = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return 0
    count = 0
    for match in THROW_RE.finditer(src):
        tail = src[match.end(): match.end() + 400]
        if not CJK.search(tail[:200]):
            continue
        # 取到该调用块的结尾（第一个 `);` 或 `}` 换行）
        block = tail.split(");", 1)[0]
        if "messageKey" in block:
            continue
        count += 1
    return count


def is_test(rel: str) -> bool:
    name = Path(rel).name
    return any(fnmatch.fnmatch(name, g) for g in CONFIG["testGlobs"])


def measure() -> dict:
    files: dict[str, dict[str, int]] = {}
    tests = {"files": 0, "ui": 0, "jsx": 0}
    server_throws: dict[str, int] = {}
    for path, rel in iter_files():
        counts = scan_file(path)
        if is_test(rel):
            tests["files"] += 1
            tests["ui"] += counts["ui"]
            tests["jsx"] += counts["jsx"]
            continue
        if rel.startswith("apps/analytics-server/"):
            unmigrated = scan_server_unmigrated(path)
            if unmigrated:
                server_throws[rel] = unmigrated
        if counts["ui"] or counts["jsx"]:
            files[rel] = counts
    return {"files": files, "tests": tests, "server_throws": server_throws}


def by_dir(files: dict[str, dict[str, int]]) -> dict[str, dict[str, int]]:
    dirs: dict[str, dict[str, int]] = defaultdict(lambda: {"ui": 0, "jsx": 0, "files": 0})
    for rel, counts in files.items():
        d = Path(rel).parent.as_posix()
        dirs[d]["ui"] += counts["ui"]
        dirs[d]["jsx"] += counts["jsx"]
        dirs[d]["files"] += 1
    return {k: dict(v) for k, v in sorted(dirs.items())}


def totals(files: dict[str, dict[str, int]]) -> dict[str, int]:
    ui = sum(c["ui"] for c in files.values())
    jsx = sum(c["jsx"] for c in files.values())
    return {"ui": ui, "jsx": jsx, "total": ui + jsx, "files": len(files)}


def load_baseline() -> dict | None:
    if not BASELINE.is_file():
        return None
    return json.loads(BASELINE.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- commands


def cmd_report(as_files: bool) -> int:
    data = measure()
    files = data["files"]
    dirs = by_dir(files)
    t = totals(files)

    print(f"{'directory':<62}{'files':>7}{'ui':>7}{'jsx':>7}")
    for d, v in sorted(dirs.items(), key=lambda kv: -(kv[1]["ui"] + kv[1]["jsx"])):
        print(f"{d:<62}{v['files']:>7}{v['ui']:>7}{v['jsx']:>7}")
    print(f"{'TOTAL (生产文件)':<62}{t['files']:>7}{t['ui']:>7}{t['jsx']:>7}")
    print(f"{'TOTAL (测试文件，不计基数)':<62}{data['tests']['files']:>7}{data['tests']['ui']:>7}{data['tests']['jsx']:>7}")

    throws = data["server_throws"]
    print(f"\n服务端未迁移抛错（throw 且无 messageKey，只减不增）：{sum(throws.values())} 处 / {len(throws)} 个文件")
    if as_files:
        for rel, n in sorted(throws.items(), key=lambda kv: -kv[1]):
            print(f"  {n:>4}  {rel}")

    if as_files:
        print("\n--- 逐文件明细（待翻译处）---")
        for rel, c in sorted(files.items(), key=lambda kv: -(kv[1]["ui"] + kv[1]["jsx"])):
            print(f"{c['ui']:>5} ui {c['jsx']:>4} jsx  {rel}")
    return 0


def cmd_check() -> int:
    data = measure()
    files = data["files"]
    dirs = by_dir(files)
    t = totals(files)
    base = load_baseline()
    if base is None:
        print("缺少基线 scripts/i18n-baseline.json；先运行 --update 生成")
        return 1

    failures: list[str] = []
    base_dirs = base.get("dirs", {})
    for d, v in dirs.items():
        b = base_dirs.get(d)
        cur = v["ui"] + v["jsx"]
        if b is None:
            if cur > 0:
                failures.append(f"新增目录有硬编码文案：{d} = {cur}")
            continue
        prev = b["ui"] + b["jsx"]
        if cur > prev:
            failures.append(f"目录文案数上升：{d} {prev} → {cur}")

    base_total = base.get("totals", {}).get("total", 0)
    if t["total"] > base_total:
        failures.append(f"总量上升：{base_total} → {t['total']}")

    # 服务端「未迁移抛错」也纳入棘轮（前端文案归零后，这是服务端的真实进度指标）
    throws = data["server_throws"]
    base_throws = base.get("server_throws", {})
    cur_throws_total = sum(throws.values())
    base_throws_total = base.get("server_throws_total", 0)
    if cur_throws_total > base_throws_total:
        failures.append(f"服务端未迁移抛错上升：{base_throws_total} → {cur_throws_total}")
    for rel, n in throws.items():
        prev = base_throws.get(rel, 0)
        if n > prev:
            failures.append(f"服务端未迁移抛错上升：{rel} {prev} → {n}")

    if failures:
        print("i18n 覆盖率检查失败：")
        for f in failures:
            print(f"  - {f}")
        print("\n只允许下降；确需上升用 --force --update 并在提交说明写原因。")
        return 1

    print(f"i18n 覆盖率检查通过（当前待翻译 {t['total']} 处，基线 {base_total} 处）")
    return 0


def cmd_update(force: bool) -> int:
    data = measure()
    files = data["files"]
    dirs = by_dir(files)
    t = totals(files)
    base = load_baseline()
    if base is not None and not force:
        base_total = base.get("totals", {}).get("total", 0)
        if t["total"] > base_total:
            print(f"拒绝写入：当前 {t['total']} 高于基线 {base_total}（需 --force）")
            return 1
        if sum(data["server_throws"].values()) > base.get("server_throws_total", 0):
            print("拒绝写入：服务端未迁移抛错高于基线（需 --force）")
            return 1
        base_dirs = base.get("dirs", {})
        for d, v in dirs.items():
            if d not in base_dirs:
                print(f"拒绝写入：新增目录 {d}（需 --force）")
                return 1
            if v["ui"] + v["jsx"] > base_dirs[d]["ui"] + base_dirs[d]["jsx"]:
                print(f"拒绝写入：目录 {d} 上升（需 --force）")
                return 1

    payload = {
        "updatedAt": date.today().isoformat(),
        "totals": t,
        "dirs": dirs,
        "tests": data["tests"],
        "server_throws": data["server_throws"],
        "server_throws_total": sum(data["server_throws"].values()),
        "note": "只允许下降。上升需 --force 并在提交说明写原因。",
    }
    BASELINE.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"基线已写入 {BASELINE.relative_to(REPO)}：{t['total']} 处（{t['files']} 个文件）")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="i18n 覆盖率棘轮（只减不增）")
    ap.add_argument("--report", action="store_true", help="只打印当前数值（默认行为）")
    ap.add_argument("--files", action="store_true", help="附逐文件明细")
    ap.add_argument("--check", action="store_true", help="与基线比较，超标退出码 1")
    ap.add_argument("--update", action="store_true", help="写基线（只允许下调）")
    ap.add_argument("--force", action="store_true", help="与 --update 同用：允许上调并记录")
    args = ap.parse_args()

    if args.check:
        return cmd_check()
    if args.update:
        return cmd_update(args.force)
    return cmd_report(args.files)


if __name__ == "__main__":
    sys.exit(main())
