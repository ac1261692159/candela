/**
 * 成员有效期过滤（phase: clklog-analytics-account-lifecycle-v3）。
 * 权限解析读取 SaProjectMember 的入口统一携带；每次调用求值，无全局缓存。
 */
export function liveMembershipWhere(): { OR: ({ expires_at: null } | { expires_at: { gt: Date } })[] } {
  return { OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] };
}

/** 行级判定：到期直接角色失效（列表端保留展示用，权限路径不应再走这里） */
export function membershipExpired(expiresAt: Date | null | undefined): boolean {
  return Boolean(expiresAt && expiresAt.getTime() <= Date.now());
}
