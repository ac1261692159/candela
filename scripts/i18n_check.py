#!/usr/bin/env python3
"""i18n 资源一致性检查（CI 必跑）。

检查项：

1. 目录一致：`src/i18n/locales/<语言>/` 下的命名空间文件集合在语言之间完全一致。
2. 键一致：同一命名空间在源语言（zh-CN）与其他语言之间的键集合完全相同（缺键 / 多键都报错）。
3. 插值一致：每个键的 `{{占位符}}` 集合在语言之间一致（漏占位符会导致英文丢变量）。
4. 非空：值不得为空串（`ALLOW_EMPTY` 显式登记的中文量词等例外）。
5. 无残留中文：非源语言不得出现中文字符（术语表允许的专有名词走 `CJK_ALLOW`）。
6. 键存在性：业务代码里 `t('ns:key')` 引用的键必须在源语言资源中存在（漏键在这里拦住，不靠运行时）。
7. 无键写错：源语言键路径每一段必须是 lowerCamelCase（命名规范见架构文档 §5.3）。
8. 回归守卫：业务代码不得直接调用 `i18n.t(` / `i18n.changeLanguage(`（必须走 `useT` / `changeLocale`）。

用法：`python3 scripts/i18n_check.py`（退出码 0 = 通过）。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
WEB_SRC = REPO / "apps" / "analytics-web" / "src"
LOCALES_DIR = WEB_SRC / "i18n" / "locales"
SOURCE_LOCALE = "zh-CN"

# 允许为空串的键（中文量词在英语中不存在，占位由调用方决定）
ALLOW_EMPTY = {
    "common:unit.count",
    "common:unit.times",
    "common:unit.items",
}

# 允许出现中文的键（专有名词/术语表）：键 → 说明
CJK_ALLOW: dict[str, str] = {}

# 繁体中文（zh-TW）里不得出现的「简体专用字」（只收简繁字形不同的常用字；两体同形字不入表，
# 例如「城」「里」在两岸都用）。发现即报错——避免用「简体转繁体只转一半」的资源上线。
SIMPLIFIED_ONLY = set(
    "设据数务录后发复关开网账权员统优实时间过还为与这于执个专业东临举义乌乐习乡书买乱争亏亚产亲亿仅从仓仪们价众会伤传伞体儿兑兴养兽"
    "冈册写军农冲决况冻净准凉减凑剧劝办动励劳势勋区医华协单卖卫却厂厅历厉压厌厦参双变叙叠叶号叹吓吗吨听启吴呜唤喷团园围图圆场坏块坚坛坝坟垒垫墙壮声壳壶处备够头夹夺奖"
    "妇妈娱婴爱爷状犹独狭狮狱猎猪猫献环现珑琐电画畅疗疮疯痒痴皱监盘睁瞒矫矶矾矿码砖砚础硕确碍礼祷禄离秃秆粮种积称秽税稳穷窃窍窜窝窥竖竞笃笋笔笼筑筛筹签简箩篓篮类紧纠红纤约级纪纫纬纭纱纲纳纵纷纸纹纺纽线练组绅细织终绊绍绎经绑绒结绕绘给绚络绝绞绢绣继绩绪续绮绰绳维绵绷绸综绽绿缀缄缅缆缉缎缓缔缕编缘缚缝缠缩缴"
    "罗罚罢羁翘耻职联聪肃肠肤肿胀胁胆胜胶脉脏脐脑脓脚脱脸腊腾舆舰舱艰艳艺节芜芦苇苍苏苹茎茧荆荐荚荡荣荧药莱莲获莹莺萝萤营萧萨葱蒋蓝蓟蔷蕴虏虑虚虽虾蚀蚁蚂蚕蛊蛮蛰蝇蝉蝼衅衔补衬袄袜袭装裤"
    "见观规觅视览觉触誉誊计订认讥讨让训议讯记讲讳讶许讹论讼讽访问闭闯闲间闷闸闹闺闻闽阀阁阅阉阎阐阔阕阙队阳阴阵阶际陆陈陕陨险随隐隶难雏雾霉静韦韧韩韵页顶顷项顺须顽顾顿颁颂预领颇颈颊颌频颓颖颗题颜额颠颤"
    "风飘飞饥饭饮饰饱饲饶饼饿馆馈馋馒马驭驮驯驰驱驳驴驶驹驻驼驾驿骂骄骆骇验骏骑骗骚骤髅髋鬓鱼鲁鲜鲤鲨鲸鳄鳍鳖鳗鳞鸟鸡鸣鸥鸦鸭鸯鸳鸽鸿鹅鹉鹊鹏鹤鹦鹰麦黄龙龟齐齿龄"
)


# 使用汉字（含假名汉字词/韩文汉字词）的语言：这些语言出现汉字是正常的
HAN_LOCALES = {"zh", "ja", "ko"}


def uses_han(locale: str) -> bool:
    """该语言是否本来就会用到汉字（zh / ja / ko）。"""
    return locale.split("-")[0].lower() in HAN_LOCALES


def simplified_only_hits(value: str) -> list[str]:
    """返回值里出现的「简体专用字」（按首次出现去重）。"""
    seen: list[str] = []
    for ch in value:
        if ch in SIMPLIFIED_ONLY and ch not in seen:
            seen.append(ch)
    return seen

CJK = re.compile(r"[\u4e00-\u9fff]")

# i18next 的复数后缀（CLDR 类别）。规则：基础键是所有语言都必须有的「兜底形态」，
# 语言可以按自己的 CLDR 规则**追加**变体（英/法/德 one+other；俄 one/few/many/other；
# 中/日/韩只有基础键）；因此跨语言键集比较要先剥掉后缀再比。
PLURAL_SUFFIX = re.compile(r"_(zero|one|two|few|many|other)$")


def strip_plural(path: str) -> str:
    return PLURAL_SUFFIX.sub("", path)
PLACEHOLDER = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")
# 键的每一段用 lowerCamelCase（与 TS 命名一致）：^[a-z][A-Za-z0-9]*$
SEGMENT = re.compile(r"^[a-z][A-Za-z0-9]*$")


def bad_key(path: str) -> bool:
    return any(not SEGMENT.match(seg) for seg in path.split("."))

flatten_errors: list[str] = []


def flatten(obj: dict, prefix: str = "", out: dict[str, str] | None = None) -> dict[str, str]:
    if out is None:
        out = {}
    for key, value in obj.items():
        path = f"{prefix}{key}"
        if isinstance(value, dict):
            flatten(value, f"{path}.", out)
        elif isinstance(value, str):
            out[path] = value
        else:
            flatten_errors.append(f"{path}: 值必须是字符串，实际是 {type(value).__name__}")
    return out


def load_namespace(locale: str, namespace: str) -> dict[str, str]:
    path = LOCALES_DIR / locale / f"{namespace}.json"
    if not path.is_file():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return flatten(raw)


def _extract_keys(text: str, field_names: tuple[str, ...]) -> list[tuple[str, str]]:
    """从源码文本提取 `<字段>: 'ns:path'` 形式的文案键。

    手写扫描而不是正则：正则里的引号字符类在多层转义下容易出错。
    会跳过 URL（含 `//`）与模板插值（含 `${`），避免把 `https://…` 当键。
    """
    out: list[tuple[str, str]] = []
    for field in field_names:
        marker = f"{field}:"
        start = 0
        while True:
            idx = text.find(marker, start)
            if idx < 0:
                break
            start = idx + len(marker)
            before = text[max(0, idx - 12):idx]
            if before.endswith("Key") or before.endswith("key"):
                # 命中的其实是 xxxMessageKey / messageKey 之类，由调用方的字段名精确控制
                pass
            rest = text[start:].lstrip()
            if not rest or rest[0] not in ("'", '"', "`"):
                continue
            quote = rest[0]
            end = rest.find(quote, 1)
            if end < 0:
                continue
            value = rest[1:end]
            if ":" not in value or "${" in value or "//" in value:
                continue
            ns, _, key = value.partition(":")
            if ns and key and ns.isalpha():
                out.append((ns, key))
    return out


def extract_message_keys(text: str) -> list[tuple[str, str]]:
    """接口错误码文案键（`messageKey: 'ns:path'`）。"""
    return _extract_keys(text, ("messageKey",))


def extract_labelled_keys(text: str) -> list[tuple[str, str]]:
    """服务端下发的展示名文案键（`label_key` / `feature_key` / `desc_key` / `*_note_key` …）。

    与 `messageKey` 共用同一套资源，只是字段名不同；这里用后缀 `_key` 通配。
    """
    keys = _extract_keys(text, ("_key",))
    return [(ns, key) for ns, key in keys if not ns.startswith("message")]


def main() -> int:
    if not LOCALES_DIR.is_dir():
        print(f"未找到语言资源目录：{LOCALES_DIR}")
        return 1

    locales = sorted(p.name for p in LOCALES_DIR.iterdir() if p.is_dir())
    if SOURCE_LOCALE not in locales:
        print(f"源语言目录缺失：{SOURCE_LOCALE}")
        return 1

    def namespaces_of(locale: str) -> set[str]:
        return {p.stem for p in (LOCALES_DIR / locale).glob("*.json")}

    ns_by_locale = {lng: namespaces_of(lng) for lng in locales}
    source_ns = ns_by_locale[SOURCE_LOCALE]

    errors: list[str] = list(flatten_errors)

    for lng in locales:
        if lng == SOURCE_LOCALE:
            continue
        missing = source_ns - ns_by_locale[lng]
        extra = ns_by_locale[lng] - source_ns
        for ns in sorted(missing):
            errors.append(f"[{lng}] 缺少命名空间文件 {ns}.json")
        for ns in sorted(extra):
            errors.append(f"[{lng}] 多出命名空间文件 {ns}.json（源语言没有）")

    total_keys = 0
    for ns in sorted(source_ns):
        source = load_namespace(SOURCE_LOCALE, ns)
        total_keys += len(source)

        for path, value in source.items():
            if bad_key(path):
                errors.append(f"[{SOURCE_LOCALE}/{ns}] 键名含大写或空格：{path}")
            if not value.strip() and f"{ns}:{path}" not in ALLOW_EMPTY:
                errors.append(f"[{SOURCE_LOCALE}/{ns}] 值为空：{path}")

        for lng in locales:
            if lng == SOURCE_LOCALE:
                continue
            other = load_namespace(lng, ns)
            # 复数变体按「剥离后缀」比较：源语言只需提供基础键，目标语言可按 CLDR 追加变体
            source_base = {strip_plural(p) for p in source}
            other_base = {strip_plural(p) for p in other}
            for path in sorted(source_base - other_base):
                errors.append(f"[{lng}/{ns}] 缺少键：{path}")
            for path in sorted(other_base - source_base):
                errors.append(f"[{lng}/{ns}] 多出键：{path}")
            # 变体只能挂在源语言存在的键上
            for path in sorted(other):
                base = strip_plural(path)
                if base not in source_base:
                    errors.append(f"[{lng}/{ns}] 复数变体没有对应基础键：{path}")
            for path in sorted(set(source) & set(other)):
                full = f"{ns}:{path}"
                value = other[path]
                if not value.strip() and full not in ALLOW_EMPTY:
                    errors.append(f"[{lng}/{ns}] 值为空：{path}")
                # 「残留中文」只对**不使用汉字**的语言成立：zh 系（繁简）与 ja/ko（含汉字）不适用；
                # 繁中的问题是「简体字残留」，由下面的 SIMPLIFIED_ONLY 单独把关。
                if CJK.search(value) and full not in CJK_ALLOW and not uses_han(lng):
                    errors.append(f"[{lng}/{ns}] 残留中文：{path} = {value!r}")
                if lng == "zh-TW":
                    hits = simplified_only_hits(value)
                    if hits:
                        errors.append(f"[{lng}/{ns}] 残留简体字：{path} = {value!r}（命中 {''.join(hits)}）")
                src_value = source.get(path) or source.get(f"{strip_plural(path)}") or ""
                if not src_value and strip_plural(path) in source:
                    src_value = source[strip_plural(path)]
                want = set(PLACEHOLDER.findall(src_value))
                got = set(PLACEHOLDER.findall(value))
                if want != got:
                    errors.append(
                        f"[{lng}/{ns}] 占位符不一致：{path} 需要 {sorted(want) or '无'}，实际 {sorted(got) or '无'}"
                    )

    # 键存在性 + 回归守卫：扫描业务代码
    guard_hits: list[str] = []
    missing_keys: list[str] = []
    source_bundles = {ns: load_namespace(SOURCE_LOCALE, ns) for ns in source_ns}
    call_re = re.compile(r"""\bt\(\s*(['"])([A-Za-z][\w]*):([\w.]+)\1""")

    for path in WEB_SRC.rglob("*"):
        if not path.is_file() or path.suffix not in {".ts", ".tsx"}:
            continue
        rel = path.relative_to(WEB_SRC).as_posix()
        if rel.startswith("i18n/"):
            continue
        # 测试文件可以直连 i18n 实例（断言渲染结果用），守卫只约束业务代码
        if rel.endswith(".spec.ts") or rel.endswith(".spec.tsx") or rel.endswith(".test.ts") or rel.endswith(".test.tsx"):
            continue
        text = path.read_text(encoding="utf-8")
        for pattern in (r"\bi18n\.t\(", r"\bi18n\.changeLanguage\(", r"\bi18next\.t\("):
            if re.search(pattern, text):
                guard_hits.append(f"{rel}: 命中 {pattern}")
        for match in call_re.finditer(text):
            ns, key = match.group(2), match.group(3)
            bundle = source_bundles.get(ns)
            if bundle is None:
                missing_keys.append(f"{rel}: 命名空间不存在 `{ns}`（键 {ns}:{key}）")
            elif key not in bundle:
                missing_keys.append(f"{rel}: 键不存在 `{ns}:{key}`")
    # 跨层检查：服务端 `messageKey` 必须在前端资源里存在（否则英文用户会看到键名）
    server_src = REPO / "apps" / "analytics-server" / "src"
    server_keys: list[str] = []
    for path in server_src.rglob("*.ts"):
        if path.name.endswith(".spec.ts"):
            continue
        text = path.read_text(encoding="utf-8")
        # 服务端下发的展示名文案键（label_key / feature_key / desc_key / *_note_key …）同样必须有资源
        for ns, key in extract_labelled_keys(text):
            bundle = source_bundles.get(ns)
            rel = path.relative_to(REPO).as_posix()
            if bundle is None:
                server_keys.append(f"{rel}: 命名空间不存在 `{ns}`（文案键 {ns}:{key}）")
            elif key not in bundle:
                server_keys.append(f"{rel}: 文案键缺资源 `{ns}:{key}`")
        for ns, key in extract_message_keys(text):
            bundle = source_bundles.get(ns)
            rel = path.relative_to(REPO).as_posix()
            if bundle is None:
                server_keys.append(f"{rel}: 命名空间不存在 `{ns}`（messageKey {ns}:{key}）")
            elif key not in bundle:
                server_keys.append(f"{rel}: messageKey 缺资源 `{ns}:{key}`")

    # 服务端 messages（通知/模板等按收件人语言渲染的文案）：键集/占位符跨语言一致、
    # 非汉字语言不得残留中文，并且**必须被 messages.ts 注册**（tsc 只把被 import 的 JSON 拷进 dist）。
    server_msgs = REPO / "apps" / "analytics-server" / "src" / "i18n" / "messages"
    if server_msgs.is_dir():
        server_locales = sorted(p.stem for p in server_msgs.glob("*.json"))
        source_msg: dict[str, str] | None = None
        for lng in server_locales:
            bundle = flatten(json.loads((server_msgs / f"{lng}.json").read_text(encoding="utf-8")))
            if lng == SOURCE_LOCALE:
                source_msg = bundle
                continue
        if source_msg is None:
            errors.append("[server] 缺少源语言 messages（zh-CN.json）")
        else:
            for lng in server_locales:
                if lng == SOURCE_LOCALE:
                    continue
                bundle = flatten(json.loads((server_msgs / f"{lng}.json").read_text(encoding="utf-8")))
                for path in sorted(set(source_msg) - set(bundle)):
                    errors.append(f"[server/{lng}] 缺少键：{path}")
                for path in sorted(set(bundle) - set(source_msg)):
                    errors.append(f"[server/{lng}] 多出键：{path}")
                for path in sorted(set(source_msg) & set(bundle)):
                    value = bundle[path]
                    if not value.strip():
                        errors.append(f"[server/{lng}] 值为空：{path}")
                    if CJK.search(value) and not uses_han(lng):
                        errors.append(f"[server/{lng}] 残留中文：{path} = {value!r}")
                    if set(PLACEHOLDER.findall(source_msg[path])) != set(PLACEHOLDER.findall(value)):
                        errors.append(f"[server/{lng}] 占位符不一致：{path}")
        loader_path = REPO / "apps" / "analytics-server" / "src" / "i18n" / "messages.ts"
        loader = loader_path.read_text(encoding="utf-8")
        for lng in server_locales:
            if f"./messages/{lng}.json" not in loader:
                errors.append(f"[server] messages/{lng}.json 未被 messages.ts 注册（import 缺失）")
            if f"'{lng}':" not in loader:
                errors.append(f"[server] messages/{lng}.json 未加入 BUNDLES 映射")

    errors.extend(sorted(set(missing_keys)))
    errors.extend(sorted(set(server_keys)))
    errors.extend(guard_hits)

    if errors:
        print("i18n 资源检查失败：")
        for err in errors:
            print(f"  - {err}")
        return 1

    print(f"i18n 资源检查通过：{len(locales)} 种语言 × {len(source_ns)} 个命名空间，共 {total_keys} 条键")
    return 0


if __name__ == "__main__":
    sys.exit(main())
