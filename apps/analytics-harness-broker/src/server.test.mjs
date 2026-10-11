import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test } from './server.mjs';

test('path containment rejects traversal outside the Harness root', () => {
  assert.equal(__test.within('/home/harness/clklog-ai', '/home/harness/clklog-ai/workspaces/a'), '/home/harness/clklog-ai/workspaces/a');
  assert.throws(
    () => __test.within('/home/harness/clklog-ai', '/etc'),
    /path_outside_harness_root/,
  );
});

test('runtime socket path stays within the AF_UNIX address limit', () => {
  const root = '/home/harness/clklog-ai';
  const runtimeId = `air_${'a'.repeat(32)}`;
  const socketPath = join(root, 'rt', runtimeId, 'runtime.sock');
  assert.ok(Buffer.byteLength(socketPath) <= 107);
});

test('ensure request accepts only fixed identifiers and permission presets', () => {
  const valid = {
    runtime_id: `air_${'a'.repeat(24)}`,
    user_id: 'user-a',
    project_name: 'project-a',
    workspace_id: 'aiw_123',
    kind: 'persistent',
    capability: 'b'.repeat(48),
    permission_mode: 'danger-full-access',
  };
  assert.equal(__test.validateEnsure(valid).permissionMode, 'danger-full-access');
  assert.throws(
    () => __test.validateEnsure({ ...valid, workspace_id: '../../etc' }),
    /invalid_workspace_id/,
  );
  assert.throws(
    () => __test.validateEnsure({ ...valid, permission_mode: 'host-root' }),
    /invalid_permission_mode/,
  );
});

test('managed read-only mounts collapse descendants and reject symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clklog-broker-test.'));
  try {
    await mkdir(join(root, '.clklog'), { recursive: true });
    await mkdir(join(root, 'tools', 'nested'), { recursive: true });
    await writeFile(
      join(root, '.clklog', 'managed-manifest.json'),
      JSON.stringify({
        schema_version: 1,
        entries: [
          { path: 'tools', policy: 'managed_readonly' },
          { path: 'tools/nested', policy: 'managed_readonly' },
        ],
      }),
    );
    const mounts = await __test.managedMounts(root);
    assert.deepEqual(mounts.map((mount) => mount.target), ['/workspace/tools']);

    await rm(join(root, 'tools'), { recursive: true });
    await symlink('/etc', join(root, 'tools'));
    await assert.rejects(__test.managedMounts(root), /managed_path_is_symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace quota scan never follows symlinks and rejects oversized content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clklog-broker-quota-test.'));
  try {
    await writeFile(join(root, 'small.txt'), '1234');
    await symlink('/etc', join(root, 'outside-link'));
    const usage = await __test.workspaceUsage(root, 1024);
    assert.ok(usage.bytes >= 4);
    await writeFile(join(root, 'large.txt'), 'x'.repeat(2048));
    await assert.rejects(__test.workspaceUsage(root, 1024), /workspace_quota_exceeded/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace quota scan counts unix sockets instead of stopping the runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clklog-broker-sock-test.'));
  const sockPath = join(root, 'agent.sock');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => resolve(undefined));
  });
  try {
    const usage = await __test.workspaceUsage(root, 1024 * 1024);
    assert.ok(usage.entries >= 1);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    await rm(root, { recursive: true, force: true });
  }
});


/**
 * 项目 app 目录校验（phase: clklog-ai-workspace-project-isolation-v1）。
 *
 * broker 只认一种形状：<root>/workspaces/<hash(project)>/app，且必须是真实目录。
 * 这些用例是「隔离不能被绕过」的守门测试——上游一旦被污染，必须在这里被拒。
 */
test('project app dir accepts only the project-scoped app path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clklog-broker-app-'));
  try {
    const config = { root: await realpath(root) };
    const appDir = join(config.root, 'ai_workspace', 'app', 'clklogapp');
    await mkdir(appDir, { recursive: true });

    // 合法形状
    assert.equal(await __test.projectAppDirectory(config, 'clklogapp', appDir), appDir);

    // 别的项目（拿 A 的目录冒充 B）
    await assert.rejects(
      () => __test.projectAppDirectory(config, 'default', appDir),
      /app_dir_not_allowed/,
    );

    // 任意路径注入 / 缺层级
    await assert.rejects(() => __test.projectAppDirectory(config, 'clklogapp', '/etc'), /app_dir_not_allowed/);
    await assert.rejects(
      () => __test.projectAppDirectory(config, 'clklogapp', join(config.root, 'ai_workspace', 'app')),
      /app_dir_not_allowed/,
    );
    // 旧哈希布局不再被接受（迁移后不应回退）
    await assert.rejects(
      () =>
        __test.projectAppDirectory(
          config,
          'clklogapp',
          join(config.root, 'workspaces', __test.hash('project', 'clklogapp'), 'app'),
        ),
      /app_dir_not_allowed/,
    );

    // 项目名非法（进入路径前就被拒）
    for (const bad of ['..', '../etc', 'A B', 'UPPER', '.hidden', 'a/b']) {
      await assert.rejects(() => __test.projectAppDirectory(config, bad, appDir), /invalid_project_name/);
    }

    // 不存在
    await assert.rejects(
      () =>
        __test.projectAppDirectory(config, 'default', join(config.root, 'ai_workspace', 'app', 'default')),
      /app_dir_missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('project app dir rejects a symlinked app directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clklog-broker-link-'));
  try {
    const config = { root: await realpath(root) };
    const elsewhere = join(config.root, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await mkdir(join(config.root, 'ai_workspace', 'app'), { recursive: true });
    const appDir = join(config.root, 'ai_workspace', 'app', 'clklogapp');
    await symlink(elsewhere, appDir);

    await assert.rejects(
      () => __test.projectAppDirectory(config, 'clklogapp', appDir),
      /app_dir_is_symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensure request carries app_dir through validation', () => {
  const valid = {
    runtime_id: `air_${'a'.repeat(24)}`,
    user_id: 'user-a',
    project_name: 'project-a',
    workspace_id: 'aiw_123',
    kind: 'persistent',
    capability: 'b'.repeat(48),
    permission_mode: 'danger-full-access',
    app_dir: '/home/harness/clklog-ai/workspaces/abc/app',
  };
  assert.equal(__test.validateEnsure(valid).appDir, valid.app_dir);
  // 缺省 = 不挂 app（向后兼容旧调用方）
  const { app_dir: _ignored, ...withoutApp } = valid;
  assert.equal(__test.validateEnsure(withoutApp).appDir, null);
  assert.throws(() => __test.validateEnsure({ ...valid, app_dir: 123 }), /app_dir/);
});
