/**
 * 布尔属性筛选绑定（2026-09-10）。
 *
 * 字典把形似 true/false 的属性标为 boolean 时，resolver 生成 JSONExtractBool(...)，
 * 而筛选值来自文本输入（'true'/'false'）——ClickHouse 拒绝 String 与 UInt8 做相等比较。
 * 且底层存储形态不统一：可能是 JSON 布尔，也可能是字符串 "true"
 * （本项目 properties.$is_first_day 实测为后者，用户侧 JSONExtractString='true' 可命中）。
 *
 * 统一降级为 JSONExtractString 比较：JSON 布尔与字符串布尔都会渲染成 'true'/'false'，
 * 两种存储形态都能命中。归一化接受 true/false/1/0 的大小写变体。
 */
export function normalizeBooleanText(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return 'true';
  if (normalized === 'false' || normalized === '0') return 'false';
  return value;
}

export function asStringExtraction(attr: string): string {
  return attr.replace(/JSONExtractBool\(/g, 'JSONExtractString(');
}

/** 布尔属性筛选的整体处理：返回降级后的提取表达式与归一化比较值。 */
export function booleanAwareBinding(
  dataType: string,
  attr: string,
  rawValue: unknown,
): { attr: string; value: string } {
  if (dataType !== 'boolean') return { attr, value: String(rawValue) };
  return { attr: asStringExtraction(attr), value: normalizeBooleanText(String(rawValue)) };
}
