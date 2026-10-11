/**
 * 项目权限可见面的守卫（phase: clklog-analytics-rbac-v4 §5）。
 *
 * `iam.member.view` 放开到五个角色后，邀请队列（含未入会者邮箱）与权限审计流水
 * 必须收紧到 `iam.member.edit`，不能随母码外溢。本用例锁死这两个端点。
 */
// 控制器经 service 顶层加载 clickhouse.service → YAML 配置（需要真实密钥），CI 无密钥，
// 按仓库既有约定隔离 configuration。
jest.mock('../../config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { REQUIRE_PERMISSION_KEY } from './require-permission';
import { IamController } from './iam.controller';
import { AuthController } from '../auth/auth.controller';

function handlerCodes(controller: { prototype: object }, method: string): string[] | undefined {
  const fn = (controller.prototype as Record<string, unknown>)[method];
  return fn ? (Reflect.getMetadata(REQUIRE_PERMISSION_KEY, fn) as string[] | undefined) : undefined;
}

describe('项目权限可见面守卫（rbac-v4）', () => {
  it('邀请列表由 iam.member.edit 把守，不接受 iam.member.view', () => {
    const codes = handlerCodes(IamController, 'listInvitations');
    expect(codes).toEqual(['iam.member.edit']);
    expect(codes).not.toContain('iam.member.view');
  });

  it('权限审计流水由 ops.user.manage | iam.member.edit 把守，不接受 iam.member.view', () => {
    const codes = handlerCodes(AuthController, 'auditLogs');
    expect(codes).toEqual(['ops.user.manage', 'iam.member.edit']);
    expect(codes).not.toContain('iam.member.view');
  });

  it('只读可见面保持在 iam.member.view（成员/成员组/策略）', () => {
    expect(handlerCodes(IamController, 'catalog')).toEqual(['iam.member.view']);
    expect(handlerCodes(IamController, 'members')).toEqual(['iam.member.view']);
    expect(handlerCodes(IamController, 'groups')).toEqual(['iam.member.view']);
    expect(handlerCodes(IamController, 'policies')).toEqual(['iam.member.view']);
  });

  it('写入口仍是各自的码', () => {
    expect(handlerCodes(IamController, 'addMember')).toEqual(['iam.member.edit']);
    expect(handlerCodes(IamController, 'removeMember')).toEqual(['iam.member.edit']);
    expect(handlerCodes(IamController, 'createGroup')).toEqual(['iam.member.edit']);
    expect(handlerCodes(IamController, 'createPolicy')).toEqual(['iam.data_policy.manage']);
    expect(handlerCodes(IamController, 'deletePolicy')).toEqual(['iam.data_policy.manage']);
    expect(handlerCodes(IamController, 'putAdminRole')).toEqual(['iam.role.edit_admin']);
  });
});
