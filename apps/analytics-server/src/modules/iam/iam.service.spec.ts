import { IamService } from './iam.service';
import { codesForRole } from './permission-catalog';
import { DataScopeService } from './data-scope.service';
import { assertEventsAllowed, assertPropsAllowed, eventsPredicate } from './data-scope';
import { PrismaService } from '../shared/prisma.service';
import { DomainError } from '../../i18n/domain-error';
import type { DataPolicyDef } from './iam.types';

const PROJECT = 'clklogapp';

function policy(def: DataPolicyDef) {
  return { id: 'p-' + Math.random().toString(16).slice(2), definition_json: JSON.stringify(def) };
}

const allowAB = policy({
  events: { mode: 'allow', keys: ['AppLaunch', 'PageView'] },
  event_properties: { mode: 'all', keys: [] },
  user_properties: { mode: 'all', keys: [] },
});
const allowBC = policy({
  events: { mode: 'allow', keys: ['PageView', 'Purchase'] },
  event_properties: { mode: 'allow', keys: ['$country'] },
  user_properties: { mode: 'all', keys: [] },
  row_filter: { rel: 'and', children: [{ prop: 'channel', op: '=', value: 'app' }] },
});
const allowEmpty = policy({
  events: { mode: 'allow', keys: [] },
  event_properties: { mode: 'all', keys: [] },
  user_properties: { mode: 'all', keys: [] },
});

type User = { id: string; username: string; status: string; platform_role: string };
type Member = {
  id: string;
  project_name: string;
  user_id: string;
  role_key: string;
  data_policy_id: string | null;
  data_policy: { id: string; definition_json: string } | null;
};
type Group = {
  id: string;
  project_name: string;
  name: string;
  role_key: string;
  data_policy_id: string | null;
  data_policy: { id: string; definition_json: string } | null;
};

function fixture() {
  const users = new Map<string, User>([
    ['u-owner', { id: 'u-owner', username: 'owner', status: 'active', platform_role: 'super_admin' }],
    ['u-ops', { id: 'u-ops', username: 'ops', status: 'active', platform_role: 'super_admin' }],
    ['u-admin', { id: 'u-admin', username: 'admin2', status: 'active', platform_role: 'none' }],
    ['u-analyst', { id: 'u-analyst', username: 'analyst', status: 'active', platform_role: 'none' }],
    ['u-member', { id: 'u-member', username: 'member', status: 'active', platform_role: 'none' }],
    ['u-external', { id: 'u-external', username: 'external', status: 'active', platform_role: 'none' }],
    ['u-disabled', { id: 'u-disabled', username: 'off', status: 'disabled', platform_role: 'none' }],
    ['u-outsider', { id: 'u-outsider', username: 'out', status: 'active', platform_role: 'none' }],
    ['u-dual', { id: 'u-dual', username: 'dual', status: 'active', platform_role: 'none' }],
    ['u-scoped', { id: 'u-scoped', username: 'scoped', status: 'active', platform_role: 'none' }],
    ['u-intersect', { id: 'u-intersect', username: 'intersect', status: 'active', platform_role: 'none' }],
    ['u-empty', { id: 'u-empty', username: 'empty', status: 'active', platform_role: 'none' }],
    ['u-new', { id: 'u-new', username: 'newbie', status: 'active', platform_role: 'none' }],
  ]);

  const members: Member[] = [
    mem('m-owner', 'u-owner', 'project_owner', allowAB),
    mem('m-admin', 'u-admin', 'analysis_admin', null),
    mem('m-analyst', 'u-analyst', 'analyst', null),
    mem('m-member', 'u-member', 'member', null),
    mem('m-external', 'u-external', 'external', null),
    mem('m-dual', 'u-dual', 'member', null),
    mem('m-scoped', 'u-scoped', 'analyst', allowAB),
    mem('m-intersect', 'u-intersect', 'analyst', allowAB),
    mem('m-empty', 'u-empty', 'analyst', allowEmpty),
  ];

  const groups: Group[] = [
    grp('g-analysts', '分析师组', 'analyst', allowAB),
    grp('g-admins', '管理员组', 'analysis_admin', null),
    grp('g-strict', '严格组', 'member', allowBC),
    grp('g-fake-owner', '伪 owner 组', 'project_owner', null),
  ];

  const groupUsers: { group_id: string; user_id: string }[] = [
    { group_id: 'g-analysts', user_id: 'u-dual' },
    { group_id: 'g-admins', user_id: 'u-dual' },
    { group_id: 'g-fake-owner', user_id: 'u-dual' },
    { group_id: 'g-analysts', user_id: 'u-intersect' },
    { group_id: 'g-strict', user_id: 'u-intersect' },
    { group_id: 'g-analysts', user_id: 'u-analyst' },
    { group_id: 'g-strict', user_id: 'u-member' },
  ];

  const grants = new Map<string, { grants_json: string }>();

  const prisma = {
    saUser: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => users.get(id) ?? null,
    },
    saProjectMember: {
      findUnique: async ({
        where: { project_name_user_id },
      }: {
        where: { project_name_user_id: { project_name: string; user_id: string } };
      }) =>
        members.find(
          (m) =>
            m.project_name === project_name_user_id.project_name && m.user_id === project_name_user_id.user_id,
        ) ?? null,
      create: async ({ data }: { data: Omit<Member, 'id' | 'data_policy'> & { data_policy_id?: string | null } }) => {
        const row: Member = {
          id: 'm-' + data.user_id,
          project_name: data.project_name,
          user_id: data.user_id,
          role_key: data.role_key,
          data_policy_id: data.data_policy_id ?? null,
          data_policy: null,
        };
        members.push(row);
        return row;
      },
    },
    saMemberGroupUser: {
      findMany: async ({
        where,
      }: {
        where: { user_id: string; group: { project_name: string } };
      }) =>
        groupUsers
          .filter((g) => g.user_id === where.user_id)
          .map((g) => {
            const group = groups.find((x) => x.id === g.group_id);
            return group && group.project_name === where.group.project_name
              ? { group_id: g.group_id, user_id: g.user_id, group }
              : null;
          })
          .filter(Boolean),
      create: async ({ data }: { data: { group_id: string; user_id: string } }) => {
        groupUsers.push(data);
        return data;
      },
    },
    saMemberGroup: {
      findFirst: async ({ where }: { where: { id: string; project_name: string } }) =>
        groups.find((g) => g.id === where.id && g.project_name === where.project_name) ?? null,
      create: async ({
        data,
      }: {
        data: { project_name: string; name: string; role_key: string; data_policy_id?: string | null };
      }) => {
        const row: Group = {
          id: 'g-' + data.name,
          project_name: data.project_name,
          name: data.name,
          role_key: data.role_key,
          data_policy_id: data.data_policy_id ?? null,
          data_policy: null,
        };
        groups.push(row);
        return row;
      },
    },
    saRoleGrant: {
      findUnique: async ({
        where: { project_name_role_key },
      }: {
        where: { project_name_role_key: { project_name: string; role_key: string } };
      }) => grants.get(`${project_name_role_key.project_name}:${project_name_role_key.role_key}`) ?? null,
    },
    saDataPolicy: {
      create: async ({
        data,
      }: {
        data: { project_name: string; name: string; definition_json: string };
      }) => ({ id: 'p-new', ...data }),
      findFirst: async ({ where, include }: { where: { id: string; project_name: string }; include?: { _count?: unknown } }) => {
        if (where.id === 'p-used') {
          return { id: 'p-used', project_name: PROJECT, _count: { members: 1, groups: 0 } };
        }
        if (where.id === 'p-free') {
          return { id: 'p-free', project_name: PROJECT, _count: { members: 0, groups: 0 } };
        }
        return include ? null : null;
      },
      delete: async () => ({ ok: true }),
    },
  };

  return { prisma: prisma as unknown as PrismaService, grants };
}

function mem(
  id: string,
  user_id: string,
  role_key: string,
  data_policy: { id: string; definition_json: string } | null,
): Member {
  return {
    id,
    project_name: PROJECT,
    user_id,
    role_key,
    data_policy_id: data_policy?.id ?? null,
    data_policy,
  };
}

function grp(
  id: string,
  name: string,
  role_key: string,
  data_policy: { id: string; definition_json: string } | null,
): Group {
  return {
    id,
    project_name: PROJECT,
    name,
    role_key,
    data_policy_id: data_policy?.id ?? null,
    data_policy,
  };
}

describe('IamService 项目空间全量求值', () => {
  let iam: IamService;
  let grants: Map<string, { grants_json: string }>;

  beforeEach(() => {
    const f = fixture();
    grants = f.grants;
    iam = new IamService(f.prisma);
  });

  describe('各角色成员权限', () => {
    it.each([
      ['u-owner', 'project_owner', ['dashboard.view', 'model.query', 'meta.view', 'iam.member.view', 'ops.owner.assign']],
      ['u-admin', 'analysis_admin', ['dashboard.view', 'model.query', 'meta.view', 'iam.member.view']],
      ['u-analyst', 'analyst', ['dashboard.view', 'model.query', 'cohort.view', 'model.card_save', 'iam.member.view']],
      ['u-member', 'member', ['dashboard.view', 'dashboard.filter', 'iam.member.view']],
      ['u-external', 'external', ['dashboard.view', 'model.export', 'iam.member.view']],
    ] as const)('%s 展示角色 %s 且具备关键码', async (userId, role, codes) => {
      const ctx = await iam.evaluate(userId, PROJECT);
      expect(ctx.member).toBe(true);
      expect(ctx.role_key).toBe(role);
      for (const code of codes) expect(ctx.permissions.has(code)).toBe(true);
    });

    it('项目权限全员只读（rbac-v4）：五角色都有 iam.member.view，写码角色档不变', async () => {
      const analyst = await iam.evaluate('u-analyst', PROJECT);
      const member = await iam.evaluate('u-member', PROJECT);
      const external = await iam.evaluate('u-external', PROJECT);
      for (const ctx of [analyst, member, external]) {
        expect(ctx.permissions.has('iam.member.view')).toBe(true);
        expect(ctx.permissions.has('iam.member.edit')).toBe(false);
        expect(ctx.permissions.has('iam.role.edit_admin')).toBe(false);
        expect(ctx.permissions.has('iam.data_policy.manage')).toBe(false);
      }
      const admin = await iam.evaluate('u-admin', PROJECT);
      expect(admin.permissions.has('iam.member.edit')).toBe(true);
      expect(admin.permissions.has('iam.data_policy.manage')).toBe(true);
    });

    it('看板默认可见（rbac-v5）：view_all 只留 owner 与分析管理员', async () => {
      expect((await iam.evaluate('u-owner', PROJECT)).permissions.has('dashboard.view_all')).toBe(true);
      expect((await iam.evaluate('u-admin', PROJECT)).permissions.has('dashboard.view_all')).toBe(true);
      for (const userId of ['u-analyst', 'u-member', 'u-external']) {
        const ctx = await iam.evaluate(userId, PROJECT);
        expect(ctx.permissions.has('dashboard.view_all')).toBe(false);
        // 仍能进「报表 → 看板」模块，只是默认看不到未授权的看板
        expect(ctx.permissions.has('dashboard.view')).toBe(true);
      }
    });

    it('owner 有除运维外的目录码；分析管理员不能改分析管理员定义', async () => {
      const owner = await iam.evaluate('u-owner', PROJECT);
      for (const code of codesForRole('project_owner')) expect(owner.permissions.has(code)).toBe(true);
      const admin = await iam.evaluate('u-admin', PROJECT);
      expect(admin.permissions.has('iam.role.edit_admin')).toBe(false);
      expect(admin.permissions.has('ops.owner.assign')).toBe(false);
    });

    it('分析师持选择器只读码、无治理面（rbac-v3 口径）；普通成员无分析查询；外部人员无 view_all', async () => {
      const analyst = await iam.evaluate('u-analyst', PROJECT);
      expect(analyst.permissions.has('meta.picker.view')).toBe(true);
      expect(analyst.permissions.has('meta.view')).toBe(false);
      expect(analyst.permissions.has('meta.edit')).toBe(false);
      const member = await iam.evaluate('u-member', PROJECT);
      expect(member.permissions.has('model.query')).toBe(false);
      expect(member.permissions.has('model.sql')).toBe(false);
      const ext = await iam.evaluate('u-external', PROJECT);
      expect(ext.permissions.has('dashboard.view_all')).toBe(false);
      expect(ext.permissions.has('dashboard.filter')).toBe(false);
    });
  });

  describe('超管无成员 / 非成员', () => {
    it('超管不是项目成员时只有运维码', async () => {
      const ctx = await iam.evaluate('u-ops', PROJECT);
      expect(ctx.member).toBe(false);
      expect(ctx.role_key).toBeNull();
      expect(ctx.permissions.has('ops.owner.assign')).toBe(true);
      expect(ctx.permissions.has('dashboard.view')).toBe(false);
      expect(ctx.data_scope.unrestricted).toBe(false);
    });

    it('普通账号未加入项目则无权限', async () => {
      const ctx = await iam.evaluate('u-outsider', PROJECT);
      expect(ctx.member).toBe(false);
      expect(ctx.permissions.size).toBe(0);
    });

    it('禁用账号求值失败', async () => {
      // i18n v1：错误改为 DomainError（携带 errorCode / messageKey），状态码语义不变
      await expect(iam.evaluate('u-disabled', PROJECT)).rejects.toBeInstanceOf(DomainError);
      await expect(iam.evaluate('u-disabled', PROJECT)).rejects.toMatchObject({
        errorCode: 'iam.user.unavailable',
        status: 403,
      });
    });
  });

  describe('多成员组', () => {
    it('同一人在分析师组+管理员组：功能取最宽，组不能产生 owner', async () => {
      const ctx = await iam.evaluate('u-dual', PROJECT);
      expect(ctx.member).toBe(true);
      expect(ctx.role_key).toBe('analysis_admin');
      expect(ctx.permissions.has('meta.view')).toBe(true);
      expect(ctx.permissions.has('iam.role.edit_admin')).toBe(false);
      expect(ctx.group_ids).toEqual(expect.arrayContaining(['g-analysts', 'g-admins', 'g-fake-owner']));
    });

    it('分析师组员仍保留分析师码；普通成员进严格组仍无查询', async () => {
      const analyst = await iam.evaluate('u-analyst', PROJECT);
      expect(analyst.group_ids).toContain('g-analysts');
      expect(analyst.permissions.has('model.query')).toBe(true);
      const member = await iam.evaluate('u-member', PROJECT);
      expect(member.group_ids).toContain('g-strict');
      expect(member.role_key).toBe('member');
      expect(member.permissions.has('model.query')).toBe(false);
    });
  });

  describe('数据权限策略', () => {
    it('owner / 超管成员不受数据策略限制，即使成员上挂了策略', async () => {
      const ctx = await iam.evaluate('u-owner', PROJECT);
      expect(ctx.data_scope.unrestricted).toBe(true);
      expect(eventsPredicate(ctx.data_scope)).toBeNull();
    });

    it('分析师成员策略只允许 AppLaunch/PageView', async () => {
      const ctx = await iam.evaluate('u-scoped', PROJECT);
      expect(ctx.data_scope.unrestricted).toBe(false);
      expect(ctx.data_scope.events).toEqual({ mode: 'allow', keys: ['AppLaunch', 'PageView'] });
      expect(() => assertEventsAllowed(ctx.data_scope, ['AppLaunch'])).not.toThrow();
      expect(() => assertEventsAllowed(ctx.data_scope, ['Purchase'])).toThrow(/无权查询事件/);
    });

    it('成员策略与两个组策略取交：事件只剩 PageView，行过滤保留', async () => {
      const ctx = await iam.evaluate('u-intersect', PROJECT);
      expect(ctx.data_scope.events).toEqual({ mode: 'allow', keys: ['PageView'] });
      expect(ctx.data_scope.event_properties).toEqual({ mode: 'allow', keys: ['$country'] });
      expect(ctx.data_scope.row_filter).toEqual([{ prop: 'channel', op: '=', value: 'app' }]);
      const sql = eventsPredicate(ctx.data_scope);
      expect(sql).toContain("event IN ('PageView')");
      expect(sql).toContain("channel");
    });

    it('空 allow 列表生成永假谓词', async () => {
      const ctx = await iam.evaluate('u-empty', PROJECT);
      expect(eventsPredicate(ctx.data_scope)).toBe('0');
    });

    it('属性白名单拒绝未授权属性', () => {
      const scope = {
        unrestricted: false,
        events: { mode: 'all' as const, keys: [] },
        event_properties: { mode: 'allow' as const, keys: ['$country'] },
        user_properties: { mode: 'allow' as const, keys: ['channel'] },
        row_filter: [],
      };
      expect(() => assertPropsAllowed(scope, 'event', ['$country'])).not.toThrow();
      expect(() => assertPropsAllowed(scope, 'event', ['$city'])).toThrow(/无权使用属性/);
      expect(() => assertPropsAllowed(scope, 'user', ['os'])).toThrow(/无权使用属性/);
    });

    it('DataScopeService 把策略注入 extraAnd，unrestricted 不注入', () => {
      const svc = new DataScopeService();
      expect(svc.applyToEventsQuery({ unrestricted: true, events: { mode: 'all', keys: [] }, event_properties: { mode: 'all', keys: [] }, user_properties: { mode: 'all', keys: [] }, row_filter: [] })).toEqual({ extraAnd: null });
      const scoped = svc.applyToEventsQuery({
        unrestricted: false,
        events: { mode: 'allow', keys: ['AppLaunch'] },
        event_properties: { mode: 'all', keys: [] },
        user_properties: { mode: 'all', keys: [] },
        row_filter: [],
      });
      expect(scoped.extraAnd).toContain("event IN ('AppLaunch')");
      expect(svc.cacheKey(null)).toBe('unrestricted');
    });
  });

  describe('分析管理员 overlay', () => {
    it('存在 grant 时用 overlay 替换默认管理员项目码', async () => {
      grants.set(`${PROJECT}:analysis_admin`, { grants_json: JSON.stringify(['dashboard.view', 'ops.user.manage']) });
      const ctx = await iam.evaluate('u-admin', PROJECT);
      expect(ctx.permissions.has('dashboard.view')).toBe(true);
      expect(ctx.permissions.has('meta.view')).toBe(false);
      expect(ctx.permissions.has('ops.user.manage')).toBe(false);
    });
  });

  describe('成员组 / 成员写入校验', () => {
    it('不能通过成员管理或成员组指定 owner', async () => {
      await expect(iam.addMember(PROJECT, 'admin', { user_id: 'u-new', role_key: 'project_owner' })).rejects.toMatchObject({
        errorCode: 'iam.member.ownerAssignForbidden',
        status: 403,
      });
      await expect(iam.createGroup(PROJECT, { name: 'x', role_key: 'project_owner' })).rejects.toMatchObject({
        errorCode: 'iam.group.bindingForbidden',
        status: 403,
      });
    });

    it('组员必须已是项目成员', async () => {
      await expect(iam.addGroupUser(PROJECT, 'g-analysts', 'u-outsider')).rejects.toMatchObject({
        errorCode: 'iam.group.memberRequired',
        status: 403,
      });
    });

    it('可把已有成员加入组；仍被引用的策略不能删', async () => {
      await expect(iam.addGroupUser(PROJECT, 'g-admins', 'u-analyst')).resolves.toEqual({ ok: true });
      await expect(iam.deletePolicy(PROJECT, 'p-used')).rejects.toMatchObject({
        errorCode: 'iam.dataPolicy.inUse',
        status: 409,
      });
      await expect(iam.deletePolicy(PROJECT, 'p-free')).resolves.toEqual({ ok: true });
      await expect(iam.deletePolicy(PROJECT, 'p-missing')).rejects.toMatchObject({
        errorCode: 'iam.dataPolicy.notFound',
        status: 404,
      });
    });
  });
});

describe('IamService 项目登记', () => {
  it('拒绝非法 project_name', async () => {
    const iam = new IamService({ saUser: { findUnique: async () => null }, saProject: { findUnique: async () => null } } as never);
    await expect(
      iam.createProject({ name: 'Bad Name', display_name: 'x', owner_user_id: 'u-owner' }),
    ).rejects.toMatchObject({ errorCode: 'iam.project.nameInvalid', status: 400 });
    await expect(
      iam.createProject({ name: '1abc', owner_user_id: 'u-owner' }),
    ).rejects.toMatchObject({ errorCode: 'iam.project.nameInvalid', status: 400 });
  });

  it('新建项目并指定 owner；重名冲突', async () => {
    const projects: { name: string; display_name: string }[] = [{ name: 'clklogapp', display_name: 'clklogapp' }];
    const members: { project_name: string; user_id: string; role_key: string }[] = [];
    const prisma = {
      saUser: {
        findUnique: async ({ where: { id } }: { where: { id: string } }) =>
          id === 'u-owner' ? { id: 'u-owner', username: 'admin', display_name: '管理员' } : null,
      },
      saProject: {
        findUnique: async ({ where: { name } }: { where: { name: string } }) =>
          projects.find((p) => p.name === name) ?? null,
        findMany: async () => projects,
        create: async ({ data }: { data: { name: string; display_name: string } }) => {
          projects.push(data);
          return data;
        },
      },
      saProjectMember: {
        findMany: async ({ where }: { where: { role_key: string } }) =>
          members
            .filter((m) => m.role_key === where.role_key)
            .map((m) => ({
              ...m,
              user: { id: m.user_id, username: 'admin', display_name: '管理员' },
            })),
        create: async ({ data }: { data: { project_name: string; user_id: string; role_key: string } }) => {
          members.push(data);
          return data;
        },
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    };
    const iam = new IamService(prisma as never);
    const created = await iam.createProject({
      name: 'game_ios',
      display_name: 'iOS 游戏',
      owner_user_id: 'u-owner',
    });
    expect(created.name).toBe('game_ios');
    expect(created.display_name).toBe('iOS 游戏');
    expect(created.owner?.user_id).toBe('u-owner');
    await expect(
      iam.createProject({ name: 'game_ios', owner_user_id: 'u-owner' }),
    ).rejects.toMatchObject({ errorCode: 'iam.project.exists', status: 409 });
  });
});
