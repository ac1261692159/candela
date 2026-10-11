/** Merge `/workspace` into DSH's durable workspace registry without clobbering user-added folders. */

const STORAGE_UNIT = { name: 'workspace', version: 2 };

export function mergeDefaultWorkspace(current, canonical, id, now) {
  const tables =
    current?.tables?.workspaces && typeof current.tables.workspaces === 'object' && !Array.isArray(current.tables.workspaces)
      ? current.tables.workspaces
      : {};
  for (const record of Object.values(tables)) {
    if (record && record.path === canonical) return current;
  }
  const workspaceIds = Array.isArray(current?.global?.workspaceIds) ? [...current.global.workspaceIds] : [];
  workspaceIds.push(id);
  return {
    unit: STORAGE_UNIT,
    global: {
      initialized: true,
      workspaceIds,
      archivedSessionIds: Array.isArray(current?.global?.archivedSessionIds)
        ? current.global.archivedSessionIds
        : [],
    },
    tables: {
      workspaces: {
        ...tables,
        [id]: {
          path: canonical,
          title: 'workspace',
          sessionIds: [],
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  };
}
