import type { AssetAction } from './iam.types';

export type AssetDecision = 'allow' | 'forbidden' | 'conflict_lock' | 'conflict_grant';

export interface AssetWriteInput {
  action: AssetAction;
  /** lock 时：目标是否要锁上（解锁不走互斥） */
  locking?: boolean;
  /** grant 时：是否包含 perm=edit */
  grantingEdit?: boolean;
  isProjectAdmin: boolean;
  hasLockPerm: boolean;
  hasGrantPerm: boolean;
  isCreator: boolean;
  effectivelyLocked: boolean;
  hasEditGrant: boolean;
  /** 本对象（文件夹含子孙看板/子文件夹）上仍有 perm=edit */
  hasEditAcls: boolean;
}

/** AssetPolicy 纯函数：写路径唯一裁决。 */
export function decideAssetWrite(input: AssetWriteInput): AssetDecision {
  const {
    action,
    locking,
    grantingEdit,
    isProjectAdmin,
    hasLockPerm,
    hasGrantPerm,
    isCreator,
    effectivelyLocked,
    hasEditGrant,
    hasEditAcls,
  } = input;

  if (action === 'lock') {
    if (!hasLockPerm) return 'forbidden';
    if (locking && hasEditAcls) return 'conflict_lock';
    return 'allow';
  }
  if (action === 'grant') {
    if (!hasGrantPerm) return 'forbidden';
    if (grantingEdit && effectivelyLocked) return 'conflict_grant';
    return 'allow';
  }
  if (action === 'update') {
    if (isProjectAdmin) return 'allow';
    if (effectivelyLocked) return 'forbidden';
    if (isCreator || hasEditGrant) return 'allow';
    return 'forbidden';
  }
  if (action === 'delete') {
    if (isProjectAdmin) return 'allow';
    if (isCreator && !effectivelyLocked) return 'allow';
    void hasEditGrant;
    return 'forbidden';
  }
  return 'forbidden';
}
