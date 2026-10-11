import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PERMISSION_KEY = 'iam:require_permission';
export const REQUIRE_MEMBER_KEY = 'iam:require_member';
export const ALLOW_WITHOUT_MEMBERSHIP_KEY = 'iam:allow_without_membership';

/** 需要权限码之一（任一即可）。 */
export const RequirePermission = (...codes: string[]) => SetMetadata(REQUIRE_PERMISSION_KEY, codes);

/** 必须是当前项目成员（超管无成员也拒绝分析接口）。 */
export const RequireMember = () => SetMetadata(REQUIRE_MEMBER_KEY, true);

/** 登录即可，无成员也放行（如 GET /iam/me）。 */
export const AllowWithoutMembership = () => SetMetadata(ALLOW_WITHOUT_MEMBERSHIP_KEY, true);
