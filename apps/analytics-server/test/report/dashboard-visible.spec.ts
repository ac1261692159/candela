/**
 * 看板可见性判定（phase: clklog-analytics-rbac-v5 §4）。
 *
 * 可见 ⇔ view_all ∨ 创建者是本人 ∨ 看板级 view 授权 ∨ 所在文件夹（含父文件夹）view 授权。
 * 这是「默认只对 owner / 分析管理员开放，其余靠成员组或文件夹授权」的唯一裁决点。
 */
import {
  expandGrantedFolders,
  isDashboardVisible,
  visibleDashboards,
  type DashboardVisibilityInput,
} from '../../src/modules/report/dashboard-visibility';

const ME = 'u-analyst';
const OTHER = 'u-owner';

function input(over: Partial<DashboardVisibilityInput> = {}): DashboardVisibilityInput {
  return {
    userId: ME,
    viewAll: false,
    grantedDashboardIds: new Set<string>(),
    grantedFolderIds: new Set<string>(),
    folderOf: new Map<string, string | null>(),
    ...over,
  };
}

describe('看板可见性判定（rbac-v5）', () => {
  it('view_all（owner / 分析管理员）看得到全部', () => {
    const rows = [{ db_id: 'd1', owner: OTHER }, { db_id: 'd2', owner: OTHER }];
    expect(visibleDashboards(rows, input({ viewAll: true }))).toHaveLength(2);
  });

  it('创建者始终可见自己建的，哪怕没有任何授权', () => {
    const rows = [{ db_id: 'mine', owner: ME }, { db_id: 'others', owner: OTHER }];
    const visible = visibleDashboards(rows, input());
    expect(visible.map((r) => r.db_id)).toEqual(['mine']);
  });

  it('看板级 view 授权可见，未授权的不可见', () => {
    const rows = [{ db_id: 'd1', owner: OTHER }, { db_id: 'd2', owner: OTHER }];
    const visible = visibleDashboards(rows, input({ grantedDashboardIds: new Set(['d1']) }));
    expect(visible.map((r) => r.db_id)).toEqual(['d1']);
  });

  it('文件夹级授权覆盖其内看板（含子文件夹，由 expandGrantedFolders 展开）', () => {
    const rows = [
      { db_id: 'inRoot', owner: OTHER },
      { db_id: 'inChild', owner: OTHER },
      { db_id: 'ungrouped', owner: OTHER },
    ];
    const folderOf = new Map<string, string | null>([
      ['inRoot', 'f-root'],
      ['inChild', 'f-child'],
      ['ungrouped', null],
    ]);
    const granted = expandGrantedFolders(
      new Set(['f-root']),
      [
        { folder_id: 'f-root', parent_id: null },
        { folder_id: 'f-child', parent_id: 'f-root' },
      ],
    );
    const visible = visibleDashboards(rows, input({ grantedFolderIds: granted, folderOf }));
    expect(visible.map((r) => r.db_id)).toEqual(['inRoot', 'inChild']);
  });

  it('父文件夹授权同样覆盖：直接给子文件夹授权只影响子文件夹内看板', () => {
    const rows = [{ db_id: 'inRoot', owner: OTHER }, { db_id: 'inChild', owner: OTHER }];
    const folderOf = new Map<string, string | null>([
      ['inRoot', 'f-root'],
      ['inChild', 'f-child'],
    ]);
    const granted = expandGrantedFolders(
      new Set(['f-child']),
      [
        { folder_id: 'f-root', parent_id: null },
        { folder_id: 'f-child', parent_id: 'f-root' },
      ],
    );
    const visible = visibleDashboards(rows, input({ grantedFolderIds: granted, folderOf }));
    expect(visible.map((r) => r.db_id)).toEqual(['inChild']);
  });

  it('三者都没有则不可见（默认不可见的兜底）', () => {
    expect(isDashboardVisible({ db_id: 'd1', owner: OTHER }, input())).toBe(false);
  });
});
