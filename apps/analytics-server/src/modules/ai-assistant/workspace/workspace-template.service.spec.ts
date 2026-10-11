import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { WorkspaceTemplateService } from './workspace-template.service';
import type { WorkspaceTemplatePolicies } from './workspace-template.types';

describe('WorkspaceTemplateService manifest policy', () => {
  let root: string;
  let service: WorkspaceTemplateService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'clklog-template-'));
    service = new WorkspaceTemplateService({} as never, {} as never);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function scan(policies: WorkspaceTemplatePolicies) {
    const internal = service as unknown as {
      scan: (
        directory: string,
        policyDocument: WorkspaceTemplatePolicies,
        version: number,
      ) => Promise<{
        template_version: number;
        entries: Array<{
          path: string;
          policy: string;
          mode: string;
          sha256: string;
        }>;
      }>;
    };
    return internal.scan(root, policies, 7);
  }

  it('applies a managed directory policy recursively and preserves executable mode', async () => {
    await mkdir(join(root, 'tools'));
    await writeFile(join(root, 'tools', 'query.sh'), '#!/bin/sh\n');
    await chmod(join(root, 'tools', 'query.sh'), 0o755);
    await writeFile(join(root, 'AGENTS.local.md'), 'user notes');

    const manifest = await scan({
      schema_version: 1,
      entries: { tools: 'managed_readonly', 'AGENTS.local.md': 'seed_once' },
    });

    expect(manifest.template_version).toBe(7);
    expect(manifest.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tools', policy: 'managed_readonly', mode: '0555' }),
      expect.objectContaining({
        path: 'tools/query.sh',
        policy: 'managed_readonly',
        mode: '0555',
      }),
      expect.objectContaining({ path: 'AGENTS.local.md', policy: 'seed_once', mode: '0644' }),
    ]));
  });

  it('rejects a seed-once override below a managed directory', async () => {
    await mkdir(join(root, 'tools'));
    await writeFile(join(root, 'tools', 'query.sh'), '#!/bin/sh\n');

    await expect(scan({
      schema_version: 1,
      entries: {
        tools: 'managed_readonly',
        'tools/query.sh': 'seed_once',
      },
    })).rejects.toThrow('只读目录的后代不能改为 seed_once');
  });

  it('rejects links instead of following them into another filesystem path', async () => {
    await symlink('/tmp', join(root, 'linked'));

    await expect(scan({ schema_version: 1, entries: {} })).rejects.toThrow(
      '模板只允许普通文件和目录',
    );
  });
});
