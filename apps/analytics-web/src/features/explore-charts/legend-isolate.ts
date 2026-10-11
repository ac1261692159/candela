/** 图例点击：独立显示该系列；再点同一系列则恢复全部。覆盖 ECharts 默认的「隐藏」。 */

export function nextLegendIsolate(
  names: string[],
  isolatedName: string | null,
  clickedName: string,
): { selected: Record<string, boolean>; isolatedName: string | null } {
  if (!clickedName || !names.includes(clickedName)) {
    return {
      selected: Object.fromEntries(names.map((name) => [name, true])),
      isolatedName,
    };
  }
  if (isolatedName === clickedName) {
    return {
      selected: Object.fromEntries(names.map((name) => [name, true])),
      isolatedName: null,
    };
  }
  return {
    selected: Object.fromEntries(names.map((name) => [name, name === clickedName])),
    isolatedName: clickedName,
  };
}

export function seriesNamesFromOption(option: { series?: Array<{ name?: string }> } | undefined): string[] {
  if (!option?.series?.length) return [];
  return option.series.map((item) => String(item.name ?? '')).filter(Boolean);
}

export function applyLegendIsolate(
  chart: { getOption: () => unknown; setOption: (opt: unknown) => void } | undefined,
  isolatedName: { current: string | null },
  lock: { current: boolean },
  clickedName: string,
) {
  if (!chart || lock.current || !clickedName) return;
  const names = seriesNamesFromOption(chart.getOption() as { series?: Array<{ name?: string }> });
  const next = nextLegendIsolate(names, isolatedName.current, clickedName);
  isolatedName.current = next.isolatedName;
  lock.current = true;
  chart.setOption({ legend: { selected: next.selected } });
  queueMicrotask(() => {
    lock.current = false;
  });
}

