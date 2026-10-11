import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../shared/prisma.service';
import {
  catalogForUi,
  codesForRole,
  ROLE_LABEL_KEYS,
  ROLE_LABELS,
  type ProjectRoleKey,
  PROJECT_ROLES,
} from './permission-catalog';
import { emptyScope, type DataPolicyDef, type IamContext } from './iam.types';
import { sanitizeAdminOverlay, maxRole, mergePolicies, unionPermissions } from './iam-evaluate';
import { badRequest, conflict, forbidden, notFound } from '../../i18n/domain-error';
import { isValidTimeZoneName } from '../time/calendar';
import { AuthMailService } from '../auth/auth-mail.service';
import { AuthTokenService, invalidInvite, sha256Hex } from '../auth/auth-token.service';
import { AuthAuditService } from '../auth/auth-audit.service';
import { liveMembershipWhere, membershipExpired } from './membership-expiry';
import { randomBytes } from 'crypto';
import { hashPassword } from '../auth/password.util';
import { assertPasswordPolicy } from '../auth/password-policy';
import type { AuthUser } from '../auth/auth.service';

const DEFAULT_PROJECT = 'clklogapp';
const PROJECT_NAME_RE = /^[a-z][a-z0-9_]{1,62}$/;

export const IAM_DEMO_GROUPS: { name: string; role_key: ProjectRoleKey }[] = [
  { name: '分析师组', role_key: 'analyst' },
  { name: '普通成员组', role_key: 'member' },
  { name: '外部人员组', role_key: 'external' },
];

export const IAM_DEMO_USERS: { username: string; display_name: string; role_key: ProjectRoleKey; group: string }[] = [
  { username: 'analyst1', display_name: '演示分析师', role_key: 'analyst', group: '分析师组' },
  { username: 'member1', display_name: '演示普通成员', role_key: 'member', group: '普通成员组' },
  { username: 'external1', display_name: '演示外部人员', role_key: 'external', group: '外部人员组' },
];

@Injectable()
export class IamService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly mail?: AuthMailService,
    @Optional() private readonly tokens?: AuthTokenService,
    @Optional() private readonly audit?: AuthAuditService,
  ) {}

  async onModuleInit() {
    try {
      await this.seedDefaultOwner();
      await this.ensureProjectRegistry();
      await this.seedDemoMembership(DEFAULT_PROJECT);
    } catch {
      // 迁移未执行时跳过
    }
  }

  async evaluate(userId: string, projectName: string): Promise<IamContext> {
    const user = await this.prisma.saUser.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'active') {
      throw forbidden({
        code: 'iam.user.unavailable',
        messageKey: 'iam:error.user.unavailable',
        message: '用户不可用',
      });
    }
    const platform_role = user.platform_role === 'super_admin' ? 'super_admin' : 'none';
    const memberRowRaw = await this.prisma.saProjectMember.findUnique({
      where: { project_name_user_id: { project_name: projectName, user_id: userId } },
      include: { data_policy: true },
    });
    // account-lifecycle-v3：到期直接角色失效（组内角色与授权不受影响）
    const memberRow = memberRowRaw && !membershipExpired(memberRowRaw.expires_at) ? memberRowRaw : null;
    const groupRows = await this.prisma.saMemberGroupUser.findMany({
      where: { user_id: userId, group: { project_name: projectName } },
      include: { group: { include: { data_policy: true } } },
    });
    const roles: ProjectRoleKey[] = [];
    if (memberRow && isProjectRole(memberRow.role_key)) roles.push(memberRow.role_key);
    for (const g of groupRows) {
      if (g.group.role_key === 'project_owner') continue;
      if (isProjectRole(g.group.role_key)) roles.push(g.group.role_key);
    }
    const role_key = maxRole(roles);
    const member = Boolean(memberRow);
    if (!member && platform_role !== 'super_admin') {
      return {
        platform_role,
        member: false,
        role_key: null,
        permissions: unionPermissions(platform_role, []),
        data_scope: emptyScope(false),
        group_ids: [],
      };
    }
    if (!member && platform_role === 'super_admin') {
      return {
        platform_role,
        member: false,
        role_key: null,
        permissions: unionPermissions(platform_role, []),
        data_scope: emptyScope(false),
        group_ids: [],
      };
    }
    let overlay: string[] | null = null;
    if (role_key === 'analysis_admin') {
      const grant = await this.prisma.saRoleGrant.findUnique({
        where: { project_name_role_key: { project_name: projectName, role_key: 'analysis_admin' } },
      });
      if (grant) {
        try {
          overlay = JSON.parse(grant.grants_json) as string[];
        } catch {
          overlay = null;
        }
      }
    }
    const permissions = unionPermissions(platform_role, roles, overlay);
    const unrestricted = platform_role === 'super_admin' || role_key === 'project_owner';
    const policies: DataPolicyDef[] = [];
    if (!unrestricted) {
      if (memberRow?.data_policy) policies.push(parsePolicy(memberRow.data_policy.definition_json));
      for (const g of groupRows) {
        if (g.group.data_policy) policies.push(parsePolicy(g.group.data_policy.definition_json));
      }
    }
    return {
      platform_role,
      member,
      role_key,
      permissions,
      data_scope: unrestricted ? emptyScope(true) : mergePolicies(policies),
      group_ids: groupRows.map((g) => g.group_id),
    };
  }

  has(ctx: IamContext, code: string): boolean {
    return ctx.permissions.has(code);
  }

  assert(ctx: IamContext, code: string): void {
    if (!this.has(ctx, code)) {
      throw forbidden({
        code: 'iam.forbidden',
        messageKey: 'iam:error.forbidden',
        message: '无权访问该资源',
      });
    }
  }

  async me(userId: string, projectName: string) {
    const ctx = await this.evaluate(userId, projectName);
    return {
      platform_role: ctx.platform_role,
      member: ctx.member,
      role_key: ctx.role_key,
      role_label: ctx.role_key ? ROLE_LABELS[ctx.role_key] : null,
      role_label_key: ctx.role_key ? ROLE_LABEL_KEYS[ctx.role_key] : null,
      permissions: [...ctx.permissions],
      data_scope: ctx.data_scope,
    };
  }

  catalog(ctx: IamContext, projectName: string) {
    return this.buildCatalog(ctx, projectName);
  }

  async buildCatalog(ctx: IamContext, projectName: string) {
    this.assert(ctx, 'iam.member.view');
    const grant = await this.prisma.saRoleGrant.findUnique({
      where: { project_name_role_key: { project_name: projectName, role_key: 'analysis_admin' } },
    });
    let adminCodes = codesForRole('analysis_admin');
    let adminAdjusted = false;
    if (grant) {
      try {
        adminCodes = JSON.parse(grant.grants_json) as string[];
        adminAdjusted = true;
      } catch {
        adminCodes = codesForRole('analysis_admin');
      }
    }
    const roles = PROJECT_ROLES.map((key) => ({
      key,
      label: ROLE_LABELS[key],
      label_key: ROLE_LABEL_KEYS[key],
      preset: true,
      adjusted: key === 'analysis_admin' && adminAdjusted,
      codes: key === 'analysis_admin' ? adminCodes : codesForRole(key),
    }));
    return { permissions: catalogForUi(), roles };
  }

  async listUserDirectory() {
    return this.prisma.saUser.findMany({
      where: { status: 'active' },
      select: { id: true, username: true, display_name: true },
      orderBy: { username: 'asc' },
    });
  }

  async listMembers(projectName: string) {
    const rows = await this.prisma.saProjectMember.findMany({
      where: { project_name: projectName },
      include: {
        user: { select: { id: true, username: true, display_name: true, status: true, platform_role: true } },
        data_policy: { select: { id: true, name: true } },
      },
      orderBy: { created_at: 'asc' },
    });
    // account-lifecycle-v3：到期行保留展示（可续约/删除），带 expired 标记
    return rows.map((row) => ({ ...row, expired: membershipExpired(row.expires_at) }));
  }

  private assertExpiryAllowed(roleKey: string, expiresAt: string | null | undefined) {
    if (expiresAt !== undefined && expiresAt !== null && roleKey === 'project_owner') {
      throw badRequest({
        code: 'iam.member.expiryOwnerForbidden',
        messageKey: 'iam:error.member.expiryOwnerForbidden',
        message: '项目 owner 不能设置有效期',
      });
    }
  }

  private parseExpiry(expiresAt: string | null | undefined): Date | null | undefined {
    if (expiresAt === undefined) return undefined;
    if (expiresAt === null || expiresAt === '') return null;
    const d = new Date(expiresAt);
    if (Number.isNaN(d.getTime())) {
      throw badRequest({
        code: 'iam.member.expiryInvalid',
        messageKey: 'iam:error.member.expiryInvalid',
        message: '有效期不是合法时间',
      });
    }
    return d;
  }

  async addMember(projectName: string, operator: string, dto: { user_id: string; role_key: string; data_policy_id?: string | null; expires_at?: string | null }) {
    if (dto.role_key === 'project_owner') {
      throw forbidden({
        code: 'iam.member.ownerAssignForbidden',
        messageKey: 'iam:error.member.ownerAssignForbidden',
        message: '不能通过成员管理指定 owner',
      });
    }
    if (!isProjectRole(dto.role_key)) {
      throw forbidden({
        code: 'iam.role.invalid',
        messageKey: 'iam:error.role.invalid',
        message: '非法角色',
      });
    }
    const user = await this.prisma.saUser.findUnique({ where: { id: dto.user_id } });
    if (!user) {
      throw notFound({
        code: 'iam.user.notFound',
        messageKey: 'iam:error.user.notFound',
        message: '用户不存在',
      });
    }
    this.assertExpiryAllowed(dto.role_key, dto.expires_at);
    const expiresAt = this.parseExpiry(dto.expires_at) ?? null;
    const created = await this.prisma.saProjectMember.create({
      data: {
        project_name: projectName,
        user_id: dto.user_id,
        role_key: dto.role_key,
        data_policy_id: dto.data_policy_id ?? null,
        expires_at: expiresAt,
      },
    });
    if (expiresAt !== null) {
      await this.audit?.record('auth_member_expiry', operator, {
        member_id: created.id,
        project: projectName,
        expires_at: expiresAt.toISOString(),
      });
    }
    return created;
  }

  async patchMember(
    projectName: string,
    id: string,
    dto: { role_key?: string; data_policy_id?: string | null; expires_at?: string | null },
    operator = 'system',
  ) {
    const row = await this.prisma.saProjectMember.findFirst({ where: { id, project_name: projectName } });
    if (!row) {
      throw notFound({
        code: 'iam.member.notFound',
        messageKey: 'iam:error.member.notFound',
        message: '成员不存在',
      });
    }
    if (row.role_key === 'project_owner') {
      throw forbidden({
        code: 'iam.member.ownerRoleForbidden',
        messageKey: 'iam:error.member.ownerRoleForbidden',
        message: '不能改 owner 的项目角色',
      });
    }
    if (dto.role_key === 'project_owner') {
      throw forbidden({
        code: 'iam.member.promoteToOwnerForbidden',
        messageKey: 'iam:error.member.promoteToOwnerForbidden',
        message: '不能把成员改成 owner',
      });
    }
    if (dto.role_key && !isProjectRole(dto.role_key)) {
      throw forbidden({
        code: 'iam.role.invalid',
        messageKey: 'iam:error.role.invalid',
        message: '非法角色',
      });
    }
    if (dto.expires_at !== undefined) this.assertExpiryAllowed(row.role_key, dto.expires_at);
    const expiresAt = this.parseExpiry(dto.expires_at);
    const updated = await this.prisma.saProjectMember.update({
      where: { id },
      data: {
        ...(dto.role_key ? { role_key: dto.role_key } : {}),
        ...(dto.data_policy_id !== undefined ? { data_policy_id: dto.data_policy_id } : {}),
        ...(dto.expires_at !== undefined ? { expires_at: expiresAt ?? null } : {}),
      },
    });
    if (dto.expires_at !== undefined) {
      await this.audit?.record('auth_member_expiry', operator, {
        member_id: id,
        project: projectName,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
      });
    }
    return updated;
  }

  async removeMember(projectName: string, id: string) {
    const row = await this.prisma.saProjectMember.findFirst({ where: { id, project_name: projectName } });
    if (!row) {
      throw notFound({
        code: 'iam.member.notFound',
        messageKey: 'iam:error.member.notFound',
        message: '成员不存在',
      });
    }
    if (row.role_key === 'project_owner') {
      throw forbidden({
        code: 'iam.member.removeOwnerForbidden',
        messageKey: 'iam:error.member.removeOwnerForbidden',
        message: '不能移除项目 owner',
      });
    }
    await this.prisma.saProjectMember.delete({ where: { id } });
    return { ok: true };
  }

  async getOwner(projectName: string) {
    const row = await this.prisma.saProjectMember.findFirst({
      where: { project_name: projectName, role_key: 'project_owner' },
      include: { user: { select: { id: true, username: true, display_name: true } } },
    });
    if (!row) return null;
    return {
      user_id: row.user_id,
      username: row.user.username,
      display_name: row.user.display_name,
    };
  }

  async assignOwner(projectName: string, userId: string) {
    const user = await this.prisma.saUser.findUnique({ where: { id: userId } });
    if (!user) {
      throw notFound({
        code: 'iam.user.notFound',
        messageKey: 'iam:error.user.notFound',
        message: '用户不存在',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.saProjectMember.findMany({
        where: { project_name: projectName, role_key: 'project_owner' },
      });
      for (const row of existing) {
        if (row.user_id === userId) continue;
        await tx.saProjectMember.update({ where: { id: row.id }, data: { role_key: 'analysis_admin' } });
      }
      await tx.saProjectMember.upsert({
        where: { project_name_user_id: { project_name: projectName, user_id: userId } },
        create: { project_name: projectName, user_id: userId, role_key: 'project_owner' },
        update: { role_key: 'project_owner' },
      });
    });
    return { ok: true };
  }

  async putAdminRole(projectName: string, grants: string[], updatedBy: string) {
    const json = JSON.stringify(sanitizeAdminOverlay(grants));
    await this.prisma.saRoleGrant.upsert({
      where: { project_name_role_key: { project_name: projectName, role_key: 'analysis_admin' } },
      create: { project_name: projectName, role_key: 'analysis_admin', grants_json: json, updated_by: updatedBy },
      update: { grants_json: json, updated_by: updatedBy },
    });
    return { ok: true };
  }

  async listGroups(projectName: string) {
    return this.prisma.saMemberGroup.findMany({
      where: { project_name: projectName },
      include: {
        data_policy: { select: { id: true, name: true } },
        users: { select: { user_id: true } },
        _count: { select: { users: true } },
      },
      orderBy: { created_at: 'asc' },
    });
  }

  async createGroup(projectName: string, dto: { name: string; role_key: string; data_policy_id?: string | null }) {
    if (dto.role_key === 'project_owner' || !isProjectRole(dto.role_key)) {
      throw forbidden({
        code: 'iam.group.bindingForbidden',
        messageKey: 'iam:error.group.bindingForbidden',
        message: '成员组不能绑定 owner 或非法角色',
      });
    }
    return this.prisma.saMemberGroup.create({
      data: {
        project_name: projectName,
        name: dto.name,
        role_key: dto.role_key,
        data_policy_id: dto.data_policy_id ?? null,
      },
    });
  }

  async patchGroup(projectName: string, id: string, dto: { name?: string; role_key?: string; data_policy_id?: string | null }) {
    const row = await this.prisma.saMemberGroup.findFirst({ where: { id, project_name: projectName } });
    if (!row) {
      throw notFound({
        code: 'iam.group.notFound',
        messageKey: 'iam:error.group.notFound',
        message: '成员组不存在',
      });
    }
    if (dto.role_key === 'project_owner') {
      throw forbidden({
        code: 'iam.group.ownerForbidden',
        messageKey: 'iam:error.group.ownerForbidden',
        message: '成员组不能绑定 owner',
      });
    }
    return this.prisma.saMemberGroup.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.role_key ? { role_key: dto.role_key } : {}),
        ...(dto.data_policy_id !== undefined ? { data_policy_id: dto.data_policy_id } : {}),
      },
    });
  }

  async addGroupUser(projectName: string, groupId: string, userId: string) {
    const group = await this.prisma.saMemberGroup.findFirst({ where: { id: groupId, project_name: projectName } });
    if (!group) {
      throw notFound({
        code: 'iam.group.notFound',
        messageKey: 'iam:error.group.notFound',
        message: '成员组不存在',
      });
    }
    const member = await this.prisma.saProjectMember.findUnique({
      where: { project_name_user_id: { project_name: projectName, user_id: userId } },
    });
    if (!member) {
      throw forbidden({
        code: 'iam.group.memberRequired',
        messageKey: 'iam:error.group.memberRequired',
        message: '用户必须已是项目成员',
      });
    }
    await this.prisma.saMemberGroupUser.create({ data: { group_id: groupId, user_id: userId } });
    return { ok: true };
  }

  async removeGroupUser(projectName: string, groupId: string, userId: string) {
    const group = await this.prisma.saMemberGroup.findFirst({ where: { id: groupId, project_name: projectName } });
    if (!group) {
      throw notFound({
        code: 'iam.group.notFound',
        messageKey: 'iam:error.group.notFound',
        message: '成员组不存在',
      });
    }
    await this.prisma.saMemberGroupUser.delete({ where: { group_id_user_id: { group_id: groupId, user_id: userId } } });
    return { ok: true };
  }

  async listPolicies(projectName: string) {
    return this.prisma.saDataPolicy.findMany({
      where: { project_name: projectName },
      include: { _count: { select: { members: true, groups: true } } },
      orderBy: { updated_at: 'desc' },
    });
  }

  async createPolicy(projectName: string, dto: { name: string; definition: DataPolicyDef }) {
    return this.prisma.saDataPolicy.create({
      data: { project_name: projectName, name: dto.name, definition_json: JSON.stringify(dto.definition) },
    });
  }

  async patchPolicy(projectName: string, id: string, dto: { name?: string; definition?: DataPolicyDef }) {
    const row = await this.prisma.saDataPolicy.findFirst({ where: { id, project_name: projectName } });
    if (!row) {
      throw notFound({
        code: 'iam.dataPolicy.notFound',
        messageKey: 'iam:error.dataPolicy.notFound',
        message: '策略不存在',
      });
    }
    return this.prisma.saDataPolicy.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.definition ? { definition_json: JSON.stringify(dto.definition) } : {}),
      },
    });
  }

  async deletePolicy(projectName: string, id: string) {
    const row = await this.prisma.saDataPolicy.findFirst({
      where: { id, project_name: projectName },
      include: { _count: { select: { members: true, groups: true } } },
    });
    if (!row) {
      throw notFound({
        code: 'iam.dataPolicy.notFound',
        messageKey: 'iam:error.dataPolicy.notFound',
        message: '策略不存在',
      });
    }
    if (row._count.members + row._count.groups > 0) {
      throw conflict({
        code: 'iam.dataPolicy.inUse',
        messageKey: 'iam:error.dataPolicy.inUse',
        message: '仍被成员或组引用',
      });
    }
    await this.prisma.saDataPolicy.delete({ where: { id } });
    return { ok: true };
  }

  async listAccessibleProjects(userId: string) {
    const user = await this.prisma.saUser.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'active') return [];
    if (user.platform_role === 'super_admin') {
      return this.prisma.saProject.findMany({
        orderBy: { name: 'asc' },
        select: { name: true, display_name: true, timezone: true },
      });
    }
    const members = await this.prisma.saProjectMember.findMany({
      where: { user_id: userId, ...liveMembershipWhere() },
      select: { project_name: true },
    });
    const names = [...new Set(members.map((m) => m.project_name))];
    if (names.length === 0) return [];
    const registered = await this.prisma.saProject.findMany({
      where: { name: { in: names } },
      orderBy: { name: 'asc' },
      select: { name: true, display_name: true, timezone: true },
    });
    const have = new Set(registered.map((p) => p.name));
    return [
      ...registered,
      ...names.filter((n) => !have.has(n)).map((name) => ({ name, display_name: name })),
    ];
  }

  async listRegistryProjects() {
    const projects = await this.prisma.saProject.findMany({ orderBy: { name: 'asc' } });
    const owners = await this.prisma.saProjectMember.findMany({
      where: { role_key: 'project_owner', project_name: { in: projects.map((p) => p.name) } },
      include: { user: { select: { id: true, username: true, display_name: true } } },
    });
    const ownerByProject = new Map(owners.map((row) => [row.project_name, row]));
    return projects.map((p) => {
      const owner = ownerByProject.get(p.name);
      return {
        name: p.name,
        display_name: p.display_name,
        timezone: p.timezone ?? null,
        owner: owner
          ? {
              user_id: owner.user_id,
              username: owner.user.username,
              display_name: owner.user.display_name,
            }
          : null,
      };
    });
  }

  /** 项目时区（IANA；null = 跟随平台，phase: clklog-analytics-timezone-v2） */
  async setProjectTimezone(name: string, timezone: string | null) {
    const tz = (timezone ?? '') .trim() || null;
    if (tz !== null && !isValidTimeZoneName(tz)) {
      throw badRequest({
        code: 'iam.project.timezoneInvalid',
        messageKey: 'iam:error.project.timezoneInvalid',
        params: { timezone },
        message: `不合法的时区：${timezone}（须为 IANA 名，如 Asia/Shanghai）`,
      });
    }
    const updated = await this.prisma.saProject.update({
      where: { name },
      data: { timezone: tz },
      select: { name: true, timezone: true },
    });
    return { ok: true, name: updated.name, timezone: updated.timezone };
  }

  async createProject(dto: { name: string; display_name?: string; owner_user_id: string }) {
    const name = (dto.name ?? '').trim();
    if (!PROJECT_NAME_RE.test(name)) {
      throw badRequest({
        code: 'iam.project.nameInvalid',
        messageKey: 'iam:error.project.nameInvalid',
        message: '项目名须为小写字母开头，仅含小写字母、数字、下划线，长度 2～63',
      });
    }
    const display_name = (dto.display_name ?? '').trim() || name;
    const owner = await this.prisma.saUser.findUnique({ where: { id: dto.owner_user_id } });
    if (!owner) {
      throw notFound({
        code: 'iam.user.notFound',
        messageKey: 'iam:error.user.notFound',
        message: '用户不存在',
      });
    }
    const exists = await this.prisma.saProject.findUnique({ where: { name } });
    if (exists) {
      throw conflict({
        code: 'iam.project.exists',
        messageKey: 'iam:error.project.exists',
        message: '项目已存在',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.saProject.create({ data: { name, display_name } });
      await tx.saProjectMember.create({
        data: { project_name: name, user_id: dto.owner_user_id, role_key: 'project_owner' },
      });
    });
    const rows = await this.listRegistryProjects();
    return rows.find((p) => p.name === name)!;
  }

  async ensureProjectRegistry(): Promise<void> {
    for (const name of [DEFAULT_PROJECT, 'default']) {
      await this.prisma.saProject.upsert({
        where: { name },
        create: { name, display_name: name },
        update: {},
      });
    }
    const members = await this.prisma.saProjectMember.findMany({
      distinct: ['project_name'],
      select: { project_name: true },
    });
    for (const row of members) {
      if (!row.project_name) continue;
      await this.prisma.saProject.upsert({
        where: { name: row.project_name },
        create: { name: row.project_name, display_name: row.project_name },
        update: {},
      });
    }
  }

  // ===== 项目邀请（phase: clklog-analytics-account-lifecycle-v2，PRD AM-5/6/7）=====

  /** 可邀请的角色（与成员管理一致；owner/analysis_admin 均不可经邀请授予） */
  private assertInvitableRole(roleKey: string) {
    if (roleKey !== 'analyst' && roleKey !== 'member' && roleKey !== 'external') {
      throw forbidden({
        code: 'iam.role.invalid',
        messageKey: 'iam:error.role.invalid',
        message: '非法角色',
      });
    }
  }

  /** 创建邀请：邮箱已有账号 → 直接入会+通知；未注册 → 签发 7 天邀请+邮件；均可带入会有效期（v3） */
  async createInvitation(projectName: string, inviter: AuthUser, dto: { email: string; role_key: string; member_expires_at?: string | null }) {
    this.assertInvitableRole(dto.role_key);
    const memberExpiresAt = this.parseExpiry(dto.member_expires_at ?? null) ?? null;
    const email = (dto.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw badRequest({
        code: 'iam.invite.emailInvalid',
        messageKey: 'iam:error.invite.emailInvalid',
        message: '邮箱格式不正确',
      });
    }
    const existingUser = await this.prisma.saUser.findFirst({ where: { email } });
    if (existingUser) {
      const dup = await this.prisma.saProjectMember.findUnique({
        where: { project_name_user_id: { project_name: projectName, user_id: existingUser.id } },
      });
      if (dup) {
        throw conflict({
          code: 'iam.invite.alreadyMember',
          messageKey: 'iam:error.invite.alreadyMember',
          message: '该邮箱对应账号已是本项目成员',
        });
      }
      await this.prisma.saProjectMember.create({
        data: { project_name: projectName, user_id: existingUser.id, role_key: dto.role_key, expires_at: memberExpiresAt },
      });
      const notifyCfg = this.mail ? await this.mail.effectiveConfig() : { enabled: false };
      const sent = notifyCfg.enabled
        ? await this.mail!.sendTemplate(email, existingUser.locale, 'inviteNotify', {
            project: projectName,
            role: dto.role_key,
            inviter: inviter.username,
          })
        : false;
      await this.audit?.record('auth_invite_create', inviter.username, {
        project: projectName,
        email_hash: sha256Hex(email).slice(0, 12),
        mode: 'direct',
        member_expires_at: memberExpiresAt ? memberExpiresAt.toISOString() : null,
      });
      return { added: true as const, invited: false as const, email_sent: sent };
    }
    if (this.mail) await this.mail.assertConfigured();
    await this.tokens!.assertEmailQuota(email, 'both');
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    // 同邮箱未接受的旧邀请作废，由最新一封接管（与令牌「最新有效」一致）
    await this.prisma.saInvitation.updateMany({
      where: { project_name: projectName, email, accepted_at: null },
      data: { accepted_at: new Date(0) },
    });
    const invite = await this.prisma.saInvitation.create({
      data: {
        project_name: projectName,
        email,
        role_key: dto.role_key,
        token_hash: sha256Hex(token),
        invited_by: inviter.username,
        expires_at: expiresAt,
        member_expires_at: memberExpiresAt,
      },
    });
    const link = await this.mail!.buildLink(`/sa/invite/${token}`);
    const sent = await this.mail!.sendTemplate(email, null, 'invite', {
      project: projectName,
      role: dto.role_key,
      link,
      days: 7,
      inviter: inviter.username,
    });
    await this.audit?.record(sent ? 'auth_invite_create' : 'auth_mail_failed', inviter.username, {
      project: projectName,
      email_hash: sha256Hex(email).slice(0, 12),
      mode: 'invite',
      member_expires_at: memberExpiresAt ? memberExpiresAt.toISOString() : null,
    });
    return { added: false as const, invited: true as const, id: invite.id, email_sent: sent };
  }

  /** 待接受邀请列表（未接受且未过期+未被替换的占位作废行一并过滤） */
  async listPendingInvitations(projectName: string) {
    const rows = await this.prisma.saInvitation.findMany({
      where: { project_name: projectName, accepted_at: null, expires_at: { gt: new Date() } },
      orderBy: { created_at: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role_key: r.role_key,
      invited_by: r.invited_by,
      expires_at: r.expires_at.toISOString(),
    }));
  }

  /** 撤销邀请（未接受才允许；占位作废行 accepted_at=epoch 视为已终止） */
  async revokeInvitation(operator: AuthUser, id: string) {
    const row = await this.prisma.saInvitation.findUnique({ where: { id } });
    if (!row || row.accepted_at) {
      throw notFound({
        code: 'iam.invite.notFound',
        messageKey: 'iam:error.invite.notFound',
        message: '邀请不存在或已结束',
      });
    }
    await this.prisma.saInvitation.update({ where: { id }, data: { accepted_at: new Date(0) } });
    await this.audit?.record('auth_invite_revoke', operator.username, { project: row.project_name, email_hash: sha256Hex(row.email).slice(0, 12) });
    return { ok: true };
  }

  /** 邀请有效性（占位作废 accepted_at=epoch / 过期 / 已接受一律视为无效） */
  private async loadValidInvite(token: string) {
    const row = await this.prisma.saInvitation.findUnique({ where: { token_hash: sha256Hex(token) } });
    if (!row || row.accepted_at || row.expires_at.getTime() < Date.now()) throw invalidInvite();
    return row;
  }

  /** 渲染接受页所需公开信息（不消费） */
  async inviteInfo(token: string) {
    const row = await this.loadValidInvite(token);
    return { email: row.email, project_name: row.project_name, role_key: row.role_key, expires_at: row.expires_at.toISOString() };
  }

  /** 注册落地入会（未登录路径，AM-5）：建号（邮箱绑定邀请）+ 建成员 + 消费邀请 */
  async registerViaInvite(
    token: string,
    dto: { username: string; display_name?: string; password: string },
  ) {
    const invite = await this.loadValidInvite(token);
    assertPasswordPolicy(dto.password, dto.username);
    const dup = await this.prisma.saUser.findUnique({ where: { username: dto.username } });
    if (dup) {
      throw conflict({
        code: 'auth.username.exists',
        messageKey: 'auth:error.username.exists',
        message: '用户名已存在',
      });
    }
    const created = await this.prisma.saUser.create({
      data: {
        username: dto.username,
        password_hash: hashPassword(dto.password),
        display_name: dto.display_name,
        email: invite.email,
        platform_role: 'none',
        created_by: invite.invited_by,
      },
    });
    await this.prisma.saProjectMember.create({
      data: { project_name: invite.project_name, user_id: created.id, role_key: invite.role_key, expires_at: invite.member_expires_at ?? null },
    });
    await this.prisma.saInvitation.update({ where: { id: invite.id }, data: { accepted_at: new Date() } });
    await this.audit?.record('auth_invite_accept', created.username, {
      project: invite.project_name,
      email_hash: sha256Hex(invite.email).slice(0, 12),
      mode: 'register',
    });
    return { ok: true };
  }

  /** 已登录接受（AM-7）：账号邮箱必须与邀请一致 */
  async acceptInvite(token: string, user: AuthUser) {
    const invite = await this.loadValidInvite(token);
    if ((user.email ?? '').toLowerCase() !== invite.email) {
      throw forbidden({
        code: 'iam.invite.emailMismatch',
        messageKey: 'iam:error.invite.emailMismatch',
        message: '当前登录账号的邮箱与邀请不匹配',
      });
    }
    await this.prisma.saProjectMember.upsert({
      where: { project_name_user_id: { project_name: invite.project_name, user_id: user.id } },
      create: { project_name: invite.project_name, user_id: user.id, role_key: invite.role_key, expires_at: invite.member_expires_at ?? null },
      update: { role_key: invite.role_key, expires_at: invite.member_expires_at ?? null },
    });
    await this.prisma.saInvitation.update({ where: { id: invite.id }, data: { accepted_at: new Date() } });
    await this.audit?.record('auth_invite_accept', user.username, {
      project: invite.project_name,
      email_hash: sha256Hex(invite.email).slice(0, 12),
      mode: 'accept',
    });
    return { ok: true };
  }

  /** 项目足迹（v3.1 UX-3）：某用户全部成员关系（含已到期）与所属成员组；ops.user.manage 只读 */
  async userFootprint(userId: string) {
    const [memberships, groups] = await Promise.all([
      this.prisma.saProjectMember.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.saMemberGroupUser.findMany({
        where: { user_id: userId },
        include: { group: { select: { name: true, project_name: true, role_key: true } } },
      }),
    ]);
    return {
      memberships: memberships.map((m) => ({
        project_name: m.project_name,
        role_key: m.role_key,
        expires_at: m.expires_at ? m.expires_at.toISOString() : null,
        expired: membershipExpired(m.expires_at),
      })),
      groups: groups.map((g) => ({
        project_name: g.group.project_name,
        group_name: g.group.name,
        role_key: g.group.role_key,
      })),
    };
  }

  /** 演示账号夹具：批量清除强制首登改密标记（account-lifecycle-v1，配合 demo-seed） */  async clearMustChangePassword(usernames: string[]): Promise<void> {
    await this.prisma.saUser.updateMany({
      where: { username: { in: usernames } },
      data: { must_change_password: false },
    });
  }

  /** 确保 clklogapp 有可见的演示组，并把已存在的演示账号挂进成员/组（不创建登录账号、不读环境变量） */
  async seedDemoMembership(projectName: string = DEFAULT_PROJECT): Promise<void> {    for (const g of IAM_DEMO_GROUPS) {
      await this.prisma.saMemberGroup.upsert({
        where: { project_name_name: { project_name: projectName, name: g.name } },
        create: { project_name: projectName, name: g.name, role_key: g.role_key },
        update: {},
      });
    }
    for (const acc of IAM_DEMO_USERS) {
      const user = await this.prisma.saUser.findUnique({ where: { username: acc.username } });
      if (!user || user.platform_role === 'super_admin') continue;
      await this.prisma.saProjectMember.upsert({
        where: { project_name_user_id: { project_name: projectName, user_id: user.id } },
        create: { project_name: projectName, user_id: user.id, role_key: acc.role_key },
        update: {},
      });
      const group = await this.prisma.saMemberGroup.findUnique({
        where: { project_name_name: { project_name: projectName, name: acc.group } },
      });
      if (!group) continue;
      await this.prisma.saMemberGroupUser.upsert({
        where: { group_id_user_id: { group_id: group.id, user_id: user.id } },
        create: { group_id: group.id, user_id: user.id },
        update: {},
      });
    }
  }

  /** 迁移后确保最早超管是 clklogapp owner */
  async seedDefaultOwner(): Promise<void> {
    const admins = await this.prisma.saUser.findMany({
      where: { platform_role: 'super_admin' },
      orderBy: { created_at: 'asc' },
    });
    if (admins.length === 0) return;
    const owner = admins[0];
    const existingOwner = await this.prisma.saProjectMember.findFirst({
      where: { project_name: DEFAULT_PROJECT, role_key: 'project_owner' },
    });
    if (existingOwner) return;
    for (const [i, admin] of admins.entries()) {
      await this.prisma.saProjectMember.upsert({
        where: { project_name_user_id: { project_name: DEFAULT_PROJECT, user_id: admin.id } },
        create: {
          id: randomUUID(),
          project_name: DEFAULT_PROJECT,
          user_id: admin.id,
          role_key: i === 0 ? 'project_owner' : 'analysis_admin',
        },
        update: { role_key: i === 0 && admin.id === owner.id ? 'project_owner' : 'analysis_admin' },
      });
    }
  }
}

function isProjectRole(key: string): key is ProjectRoleKey {
  return PROJECT_ROLES.includes(key as ProjectRoleKey);
}

function parsePolicy(json: string): DataPolicyDef {
  try {
    return JSON.parse(json) as DataPolicyDef;
  } catch {
    return {
      events: { mode: 'all', keys: [] },
      event_properties: { mode: 'all', keys: [] },
      user_properties: { mode: 'all', keys: [] },
    };
  }
}
