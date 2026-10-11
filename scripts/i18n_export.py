#!/usr/bin/env python3
"""翻译工作流工具：导出待译 CSV / 回填语言资源（`--export` / `--import` 两个子命令）。

用途：新增一门语言或修订文案时，把「键 + 源语言原文 + 参考译文」交给译者（CSV），
收回后一键回填到 `apps/analytics-web/src/i18n/locales/<语言>/` 与
`apps/analytics-server/src/i18n/messages/<语言>.json`，再跑 `i18n_check.py` 验收。

用法：

    # 导出（默认源 zh-CN，参考 en-US；目标语言可指定多门）
    python3 scripts/i18n_export.py --export --target ja-JP --out /tmp/ja.csv
    # 回填（CSV 里 target 列非空的行才会写入；缺失的键保持原状）
    python3 scripts/i18n_export.py --import /tmp/ja.csv --target ja-JP

约定（与 `docs/architecture/i18n-glossary.md` 一致）：

- 导出的 `key` 是**扁平化的点名**（`namespace:path.to.key`，数组按 `[i]` 展开）；
- 回填时只写 CSV 中 `target` 列非空的行；`zh-CN` 不允许作为 target（源语言是权威）；
- 回填后请运行 `python3 scripts/i18n_check.py`（键集 / 占位符 / 非源语言无 CJK 残留）。
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
WEB_LOCALES = REPO / "apps" / "analytics-web" / "src" / "i18n" / "locales"
SERVER_MESSAGES = REPO / "apps" / "analytics-server" / "src" / "i18n" / "messages"
SOURCE = "zh-CN"
REFERENCE = "en-US"

PLACEHOLDER_HINT = "保持 {{占位符}} 名字与数量不变"

# 与 scripts/i18n_check.py 的 ALLOW_EMPTY 保持一致：这些键在部分语言里**故意为空**
# （中文量词在英语/韩语里不存在），统计「待译」时不计入。
ALLOW_EMPTY = {"common:unit.count", "common:unit.times", "common:unit.items"}


def flatten(value: object, prefix: str = "") -> dict[str, str]:
    """把嵌套 JSON 扁平化成 {点分路径: 字符串}。"""
    out: dict[str, str] = {}
    if isinstance(value, dict):
        for key, child in value.items():
            out.update(flatten(child, f"{prefix}{key}."))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            out.update(flatten(child, f"{prefix}[{index}]."))
    elif isinstance(value, str):
        out[prefix.rstrip(".")] = value
    return out


def load_locale_dir(locale: str) -> dict[str, str]:
    """读取某语言的 16 个命名空间资源，返回 {命名空间:点分路径: 值}。"""
    directory = WEB_LOCALES / locale
    if not directory.is_dir():
        return {}
    result: dict[str, str] = {}
    for path in sorted(directory.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for key, value in flatten(data).items():
            result[f"{path.stem}:{key}"] = value
    return result


def load_server_messages(locale: str) -> dict[str, str]:
    path = SERVER_MESSAGES / f"{locale}.json"
    if not path.is_file():
        return {}
    return {f"server:{key}": value for key, value in flatten(json.loads(path.read_text(encoding="utf-8"))).items()}


def export_rows(target: str) -> list[dict[str, str]]:
    source = {**load_locale_dir(SOURCE), **load_server_messages(SOURCE)}
    reference = {**load_locale_dir(REFERENCE), **load_server_messages(REFERENCE)}
    existing = {**load_locale_dir(target), **load_server_messages(target)}
    rows = []
    for key in sorted(source):
        rows.append(
            {
                "key": key,
                "source_zh-CN": source.get(key, ""),
                "reference_en-US": reference.get(key, ""),
                "target": existing.get(key, ""),
            }
        )
    return rows


def cmd_export(target: str, out: Path) -> int:
    rows = export_rows(target)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=["key", "source_zh-CN", "reference_en-US", "target"])
        writer.writeheader()
        writer.writerows(rows)
    filled = sum(1 for row in rows if row["target"] or row["key"].replace("zh-CN:", "common:") in ALLOW_EMPTY)
    print(f"已导出 {len(rows)} 条到 {out}（{target} 已填 {filled} 条，待译 {len(rows) - filled} 条）")
    print(f"提示：{PLACEHOLDER_HINT}；术语见 docs/architecture/i18n-glossary.md")
    return 0


def cmd_import(csv_path: Path, target: str) -> int:
    if target == SOURCE:
        print(f"拒绝写入源语言 {SOURCE}")
        return 1
    with csv_path.open(newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))
    if not rows or "key" not in rows[0] or "target" not in rows[0]:
        print("CSV 缺少 key/target 列")
        return 1

    # 按「前端命名空间 / server」分组，再按点分路径还原嵌套结构
    web: dict[str, dict[str, str]] = {}
    server: dict[str, str] = {}
    for row in rows:
        value = (row.get("target") or "").strip()
        if not value:
            continue
        key = row["key"]
        if key.startswith("server:"):
            server[key[len("server:"):]] = value
        else:
            namespace, _, path = key.partition(":")
            if not path:
                print(f"跳过非法键：{key}")
                continue
            web.setdefault(namespace, {})[path] = value

    written = 0
    for namespace, flat in web.items():
        directory = WEB_LOCALES / target
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{namespace}.json"
        current = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
        merged = {**flatten(current), **flat}
        path.write_text(json.dumps(_nest(merged), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        written += len(flat)

    if server:
        path = SERVER_MESSAGES / f"{target}.json"
        current = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
        merged = {**flatten(current), **server}
        path.write_text(json.dumps(_nest(merged), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        written += len(server)

    print(f"已回填 {written} 条到 {target}")
    print("下一步：python3 scripts/i18n_check.py")
    return 0


def _nest(flat: dict[str, str]) -> dict:
    """点分路径 → 嵌套 dict（不支持数组下标：语言资源里没有数组）。"""
    root: dict = {}
    for path, value in flat.items():
        node = root
        segments = path.split(".")
        for segment in segments[:-1]:
            node = node.setdefault(segment, {})  # type: ignore[assignment]
        node[segments[-1]] = value  # type: ignore[index]
    return root


def main() -> int:
    parser = argparse.ArgumentParser(description="i18n 翻译工作流（导出 / 回填 CSV）")
    parser.add_argument("--export", action="store_true", help="导出待译 CSV")
    parser.add_argument("--import", dest="do_import", metavar="CSV", help="从 CSV 回填目标语言")
    parser.add_argument("--target", required=True, help="目标语言标签（如 ja-JP）")
    parser.add_argument("--out", default="/tmp/i18n-translation.csv", help="导出路径（默认 /tmp/i18n-translation.csv）")
    args = parser.parse_args()

    if args.export:
        return cmd_export(args.target, Path(args.out))
    if args.do_import:
        return cmd_import(Path(args.do_import), args.target)
    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
