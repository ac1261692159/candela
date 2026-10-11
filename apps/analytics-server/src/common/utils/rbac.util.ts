import type { AuthUser } from '../../modules/auth/auth.service';
import { forbidden } from '../../i18n/domain-error';

/** 平台超管。项目内分析能力请走 IamContext / AssetPolicy。 */
export function isAdmin(user: AuthUser): boolean {
  return user?.platform_role === 'super_admin';
}

/** @deprecated 写路径改走 AssetPolicy；仅保留给未迁完的调用方。 */
export function assertOwner(user: AuthUser, owner: string): void {
  if (isAdmin(user)) return;
  if (owner !== user.id) {
    throw forbidden({
      code: 'common.rbac.forbidden',
      messageKey: 'errors:rbac.forbidden',
      message: '无权访问该资源',
    });
  }
}

/** @deprecated 列表不再按 owner 过滤观看。 */
export function ownerFilter(user: AuthUser): { owner: string } | undefined {
  return isAdmin(user) ? undefined : { owner: user.id };
}
