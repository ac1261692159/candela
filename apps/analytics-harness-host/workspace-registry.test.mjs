import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDefaultWorkspace } from './workspace-registry.mjs';

const empty = {
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
  tables: { workspaces: {} },
};

test('empty DSH registry gains the bound /workspace folder', () => {
  const next = mergeDefaultWorkspace(empty, '/workspace', 'ws-1', '2026-09-02T00:00:00.000Z');
  assert.deepEqual(next.global.workspaceIds, ['ws-1']);
  assert.equal(next.tables.workspaces['ws-1'].path, '/workspace');
  assert.equal(next.tables.workspaces['ws-1'].title, 'workspace');
});

test('already registered /workspace is left unchanged', () => {
  const current = mergeDefaultWorkspace(empty, '/workspace', 'ws-1', '2026-09-02T00:00:00.000Z');
  assert.equal(mergeDefaultWorkspace(current, '/workspace', 'ws-2', '2026-09-02T01:00:00.000Z'), current);
});

test('missing storage file still produces a valid DSH registry document', () => {
  const next = mergeDefaultWorkspace(null, '/workspace', 'ws-1', '2026-09-02T00:00:00.000Z');
  assert.equal(next.unit.version, 2);
  assert.equal(next.global.initialized, true);
  assert.equal(next.tables.workspaces['ws-1'].sessionIds.length, 0);
});
