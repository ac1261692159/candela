/**
 * 看板可见性判定（phase: clklog-analytics-rbac-v5 §4）。
 *
 * 可见 ⇔ view_all ∨ 创建者是本人 ∨ 看板级 view 授权 ∨ 所在文件夹（含父文件夹）view 授权。
 * 抽成纯函数以便直接覆盖四种组合；`DashboardService.list` 只用它做过滤。
 */
export interface VisibleDashboardRef {
  db_id: string;
  owner: string;
}

export interface DashboardVisibilityInput {
  /** 当前用户 id */
  userId: string;
  /** 是否持 dashboard.view_all（owner / 分析管理员） */
  viewAll: boolean;
  /** 命中 ACL(view) 的看板 id 集合 */
  grantedDashboardIds: ReadonlySet<string>;
  /** 命中 ACL(view) 的文件夹 id 集合（含由父文件夹展开出的子文件夹） */
  grantedFolderIds: ReadonlySet<string>;
  /** 看板 id → 所属文件夹 id（未分组为 null/undefined） */
  folderOf: ReadonlyMap<string, string | null>;
}

/** 判断单块看板是否可见 */
export function isDashboardVisible(row: VisibleDashboardRef, input: DashboardVisibilityInput): boolean {
  if (input.viewAll) return true;
  if (row.owner === input.userId) return true;
  if (input.grantedDashboardIds.has(row.db_id)) return true;
  const folderId = input.folderOf.get(row.db_id);
  return Boolean(folderId && input.grantedFolderIds.has(folderId));
}

/** 过滤出可见看板 */
export function visibleDashboards<T extends VisibleDashboardRef>(
  rows: readonly T[],
  input: DashboardVisibilityInput,
): T[] {
  if (input.viewAll) return [...rows];
  return rows.filter((row) => isDashboardVisible(row, input));
}

/**
 * 文件夹授权继承：把已授权的文件夹向下一级展开（v2 限定最多两层，故一趟足够）。
 * 返回展开后的集合（不改入参）。
 */
export function expandGrantedFolders(
  granted: ReadonlySet<string>,
  folders: readonly { folder_id: string; parent_id: string | null }[],
): Set<string> {
  const out = new Set(granted);
  if (out.size === 0) return out;
  for (const folder of folders) {
    if (folder.parent_id && out.has(folder.parent_id)) out.add(folder.folder_id);
  }
  return out;
}
