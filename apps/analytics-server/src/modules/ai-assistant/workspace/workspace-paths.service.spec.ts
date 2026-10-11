import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MAX_UNIX_SOCKET_PATH_BYTES,
  PROJECT_APP_DIR_MODE,
  PROJECT_NAME_PATTERN,
  assertProjectName,
  ensureProjectAppDirectoryAt,
  ownedDirectoryChain,
  projectAppSegments,
} from './workspace-paths.service';

describe('ownedDirectoryChain', () => {
  const root = join('/home/harness', 'clklog-ai');

  it('includes every ancestor from the harness root to the target', () => {
    expect(
      ownedDirectoryChain(
        root,
        join(root, 'workspaces', 'proj', 'user', 'persistent', 'aiw_1'),
      ),
    ).toEqual([
      root,
      join(root, 'workspaces'),
      join(root, 'workspaces', 'proj'),
      join(root, 'workspaces', 'proj', 'user'),
      join(root, 'workspaces', 'proj', 'user', 'persistent'),
      join(root, 'workspaces', 'proj', 'user', 'persistent', 'aiw_1'),
    ]);
  });

  it('returns only the root when the target is the root', () => {
    expect(ownedDirectoryChain(root, root)).toEqual([root]);
  });

  it('rejects a path outside the harness root', () => {
    expect(() => ownedDirectoryChain(root, '/tmp/elsewhere')).toThrow(
      '路径越过 Harness 管理根目录',
    );
  });

  it('keeps the Runtime unix socket path within the AF_UNIX limit', () => {
    const runtimeId = `air_${'a'.repeat(32)}`;
    const socketPath = join(root, 'rt', runtimeId, 'runtime.sock');
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(MAX_UNIX_SOCKET_PATH_BYTES);
  });
});


/**
 * 项目 app 目录（phase: clklog-ai-workspace-project-isolation-v1）。
 *
 * 隔离靠两件事：① 路径按项目哈希分层（不同项目必得不同目录）；
 * ② 挂载源必须是真实目录（symlink 会把别的项目目录带进容器）。
 */
describe('项目 app 目录', () => {
  const ROOT = join('/home/harness', 'clklog-ai');
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'clklog-app-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('分层是 ai_workspace/app/<项目名>，与仓库同构（不再用哈希，同步脚本无需复刻哈希）', () => {
    expect(projectAppSegments('clklogapp')).toEqual(['ai_workspace', 'app', 'clklogapp']);
    expect(projectAppSegments('default')).toEqual(['ai_workspace', 'app', 'default']);
  });

  it('项目名进入路径前先校验：非法名一律拒绝', () => {
    for (const bad of ['..', '../etc', 'a/b', 'A B', 'UPPER', '.hidden', '', 'a'.repeat(65)]) {
      expect(() => assertProjectName(bad)).toThrow('项目名不适用于路径');
      expect(() => projectAppSegments(bad)).toThrow('项目名不适用于路径');
    }
    expect(PROJECT_NAME_PATTERN.test('clklogapp')).toBe(true);
    expect(PROJECT_NAME_PATTERN.test('proj-2_x')).toBe(true);
  });

  it('首次创建：建目录 + 写租户标识文件 + 权限 0750', async () => {
    const { path, created } = await ensureProjectAppDirectoryAt({
      root,
      project: 'clklogapp',
      owner: { uid: process.getuid?.() ?? 1, gid: process.getgid?.() ?? 1 },
      applyOwnership: false,
    });

    expect(created).toBe(true);
    expect(path).toBe(join(await realpath(root), ...projectAppSegments('clklogapp')));
    const marker = JSON.parse(await readFile(join(path, 'project.json'), 'utf8')) as { project: string };
    expect(marker.project).toBe('clklogapp');
    expect(await readFile(join(path, 'README.md'), 'utf8')).toContain('当前项目');
    const { stat } = await import('fs/promises');
    expect((await stat(path)).mode & 0o777).toBe(PROJECT_APP_DIR_MODE);
  });

  it('幂等：再次调用不覆盖内容，created=false', async () => {
    const first = await ensureProjectAppDirectoryAt({
      root,
      project: 'clklogapp',
      owner: { uid: 1, gid: 1 },
      applyOwnership: false,
    });
    await writeFile(join(first.path, 'notes.md'), 'user content', 'utf8');

    const second = await ensureProjectAppDirectoryAt({
      root,
      project: 'clklogapp',
      owner: { uid: 1, gid: 1 },
      applyOwnership: false,
    });

    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    expect(await readFile(join(second.path, 'notes.md'), 'utf8')).toBe('user content');
  });

  it('拒绝符号链接的 app 目录（否则可越权指向别的项目）', async () => {
    const { mkdir } = await import('fs/promises');
    const appParent = join(root, 'ai_workspace', 'app');
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await mkdir(appParent, { recursive: true });
    await symlink(elsewhere, join(appParent, 'clklogapp'));

    await expect(
      ensureProjectAppDirectoryAt({
        root,
        project: 'clklogapp',
        owner: { uid: 1, gid: 1 },
        applyOwnership: false,
      }),
    ).rejects.toThrow('符号链接');
  });

  it('app 路径被普通文件占用时报错（不静默换目录）', async () => {
    const { mkdir } = await import('fs/promises');
    const appParent = join(root, 'ai_workspace', 'app');
    await mkdir(appParent, { recursive: true });
    await writeFile(join(appParent, 'clklogapp'), 'not a dir', 'utf8');

    await expect(
      ensureProjectAppDirectoryAt({
        root,
        project: 'clklogapp',
        owner: { uid: 1, gid: 1 },
        applyOwnership: false,
      }),
    ).rejects.toThrow('不是目录');
  });

  it('两个项目各得一份，互不影响', async () => {
    const a = await ensureProjectAppDirectoryAt({
      root,
      project: 'clklogapp',
      owner: { uid: 1, gid: 1 },
      applyOwnership: false,
    });
    const b = await ensureProjectAppDirectoryAt({
      root,
      project: 'default',
      owner: { uid: 1, gid: 1 },
      applyOwnership: false,
    });
    await writeFile(join(a.path, 'only-a.txt'), 'a', 'utf8');

    expect(a.path).not.toBe(b.path);
    expect(a.path.endsWith('/ai_workspace/app/clklogapp')).toBe(true);
    const { readdir } = await import('fs/promises');
    expect(await readdir(b.path)).not.toContain('only-a.txt');
    expect(ROOT).toBeTruthy();
  });
});
