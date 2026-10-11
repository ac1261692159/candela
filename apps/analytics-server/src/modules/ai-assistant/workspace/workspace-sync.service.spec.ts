import { createHash } from 'crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { WorkspaceSyncService } from './workspace-sync.service';
import type {
  WorkspaceTemplateEntry,
  WorkspaceTemplateManifest,
} from './workspace-template.types';

const workspace = {
  id: 'aiw_workspace',
  user_id: 'user-1',
  project_name: 'clklogapp',
  kind: 'persistent',
};

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileEntry(
  path: string,
  content: string,
  policy: 'managed_readonly' | 'seed_once',
  mode: WorkspaceTemplateEntry['mode'] = policy === 'managed_readonly' ? '0444' : '0644',
): WorkspaceTemplateEntry {
  return {
    path,
    kind: 'file',
    policy,
    mode,
    sha256: digest(content),
    size: Buffer.byteLength(content),
  };
}

function directoryEntry(
  path: string,
  policy: 'managed_readonly' | 'seed_once',
): WorkspaceTemplateEntry {
  return {
    path,
    kind: 'directory',
    policy,
    mode: policy === 'managed_readonly' ? '0555' : '0755',
    sha256: digest(`directory\0${path}\0${policy}`),
  };
}

describe('WorkspaceSyncService managed and seed policies', () => {
  let root: string;
  let source: string;
  let prisma: ReturnType<typeof prismaMock>;
  let oldManifest: WorkspaceTemplateManifest;
  let service: WorkspaceSyncService;

  function prismaMock() {
    const itemUpdate = jest.fn(async () => ({}));
    const workspaceUpdate = jest.fn(async () => ({}));
    const workspaceUpdateMany = jest.fn(async () => ({ count: 1 }));
    const client = {
      aiWorkspaceSyncItem: { update: itemUpdate },
      aiWorkspace: { update: workspaceUpdate, updateMany: workspaceUpdateMany },
      $transaction: jest.fn(),
    };
    client.$transaction.mockImplementation(async (
      input: Array<Promise<unknown>> | ((transaction: typeof client) => Promise<unknown>),
    ) => (typeof input === 'function' ? input(client) : Promise.all(input)));
    return client;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'clklog-workspace-sync-'));
    source = join(root, 'template');
    const target = join(root, 'workspace');
    await mkdir(join(source, 'tools'), { recursive: true });
    await mkdir(join(target, '.clklog', 'recovery'), { recursive: true });
    prisma = prismaMock();
    oldManifest = {
      schema_version: 1,
      template_version: 1,
      content_digest: 'old',
      entries: [],
    };
    const workspaces = {
      pathFor: jest.fn(async () => target),
      readManagedManifest: jest.fn(async () => oldManifest),
      writeManagedManifest: jest.fn(async (_root: string, manifest: WorkspaceTemplateManifest) => {
        await writeFile(
          join(target, '.clklog', 'managed-manifest.json'),
          JSON.stringify(manifest),
        );
      }),
      ensureOwnership: jest.fn(async () => undefined),
    };
    const runtimes = { closeWorkspace: jest.fn(async () => undefined) };
    service = new WorkspaceSyncService(
      prisma as never,
      {} as never,
      workspaces as never,
      {} as never,
      runtimes as never,
    );
  });

  afterEach(async () => {
    const makeWritable = async (path: string): Promise<void> => {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      await chmod(path, info.isDirectory() ? 0o755 : 0o644);
      if (info.isDirectory()) {
        for (const child of await readdir(path)) await makeWritable(join(path, child));
      }
    };
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  });

  async function sync(manifest: WorkspaceTemplateManifest, initializeLegacy = false) {
    const internal = service as unknown as {
      syncWorkspace: (
        jobId: string,
        itemId: string,
        row: typeof workspace,
        sourceRoot: string,
        next: WorkspaceTemplateManifest,
        legacy?: boolean,
      ) => Promise<void>;
    };
    await internal.syncWorkspace(
      'aiws_job',
      'item-1',
      workspace,
      source,
      manifest,
      initializeLegacy,
    );
  }

  it('backs up and mirrors managed paths without overwriting seed-once content', async () => {
    const target = join(root, 'workspace');
    await writeFile(join(target, 'AGENTS.md'), 'old instructions');
    await writeFile(join(target, 'obsolete.txt'), 'retired');
    await writeFile(join(target, 'user-notes.md'), 'user keeps this');
    await writeFile(join(source, 'AGENTS.md'), 'new instructions');
    await writeFile(join(source, 'user-notes.md'), 'template suggestion');
    await writeFile(join(source, 'tools', 'query.sh'), '#!/bin/sh\necho safe\n');
    await chmod(join(source, 'tools', 'query.sh'), 0o555);
    oldManifest.entries = [
      fileEntry('AGENTS.md', 'old instructions', 'managed_readonly'),
      fileEntry('obsolete.txt', 'retired', 'managed_readonly'),
    ];
    const next: WorkspaceTemplateManifest = {
      schema_version: 1,
      template_version: 2,
      content_digest: 'next',
      entries: [
        fileEntry('AGENTS.md', 'new instructions', 'managed_readonly'),
        directoryEntry('tools', 'managed_readonly'),
        fileEntry('tools/query.sh', '#!/bin/sh\necho safe\n', 'managed_readonly', '0555'),
        fileEntry('user-notes.md', 'template suggestion', 'seed_once'),
      ],
    };

    await sync(next);

    await expect(readFile(join(target, 'AGENTS.md'), 'utf8')).resolves.toBe('new instructions');
    await expect(readFile(join(target, 'user-notes.md'), 'utf8')).resolves.toBe('user keeps this');
    await expect(readFile(join(target, '.clklog', 'recovery', 'aiws_job', 'AGENTS.md'), 'utf8'))
      .resolves.toBe('old instructions');
    await expect(readFile(join(target, '.clklog', 'recovery', 'aiws_job', 'obsolete.txt'), 'utf8'))
      .resolves.toBe('retired');
    await expect(lstat(join(target, 'obsolete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('initializes only missing seed-once entries for a legacy workspace', async () => {
    const target = join(root, 'workspace');
    await writeFile(join(target, 'existing.md'), 'user version');
    await writeFile(join(source, 'existing.md'), 'template version');
    await writeFile(join(source, 'missing.md'), 'seeded knowledge');
    const next: WorkspaceTemplateManifest = {
      schema_version: 1,
      template_version: 3,
      content_digest: 'legacy',
      entries: [
        fileEntry('existing.md', 'template version', 'seed_once'),
        fileEntry('missing.md', 'seeded knowledge', 'seed_once'),
      ],
    };

    await sync(next, true);

    await expect(readFile(join(target, 'existing.md'), 'utf8')).resolves.toBe('user version');
    await expect(readFile(join(target, 'missing.md'), 'utf8')).resolves.toBe('seeded knowledge');
    expect(prisma.aiWorkspace.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ initialized_from: 'legacy_initialized' }),
    }));
  });

  it('records a recovery location when a malicious link makes synchronization fail', async () => {
    const target = join(root, 'workspace');
    await symlink('/tmp', join(target, 'linked'));
    oldManifest.entries = [fileEntry('linked', 'unused', 'managed_readonly')];
    const next: WorkspaceTemplateManifest = {
      schema_version: 1,
      template_version: 4,
      content_digest: 'failure',
      entries: [],
    };

    await expect(sync(next)).rejects.toThrow('同步目标包含软链接');
    expect(prisma.aiWorkspaceSyncItem.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ recovery_path: '.clklog/recovery/aiws_job' }),
    }));
    const recovery = JSON.parse(
      await readFile(
        join(target, '.clklog', 'recovery', 'aiws_job', 'recovery-manifest.json'),
        'utf8',
      ),
    );
    expect(recovery).toMatchObject({ state: 'failed', job_id: 'aiws_job' });
  });
});
