/**
 * 历史资产 owner 回填：把改造前 owner=project 名（如 'clklogapp'）的
 * 看板/报表，回填为默认 admin 用户 id。
 *
 * 背景：RBAC P1 前，Dashboard.owner / SqlReport.owner 存的是 project 名；
 * P1 改造后 owner 应为用户 id。不回填则历史资产因 owner 不等于任何用户 id
 * 而无法被任何用户（含 admin）通过 owner 过滤查询到。
 *
 * 用法：npx ts-node src/scripts/backfill-asset-owner.ts
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();

  // 1. 找 admin 用户
  const admin = await prisma.saUser.findUnique({ where: { username: 'admin' } });
  if (!admin) {
    console.error('未找到 admin 用户，请先运行 init-admin.ts');
    process.exit(1);
  }

  // 2. 取所有用户 id（用于判断 owner 是否已是用户 id）
  const userIds = new Set((await prisma.saUser.findMany({ select: { id: true } })).map((u) => u.id));

  // 3. 回填 Dashboard
  const dashboards = await prisma.dashboard.findMany({ select: { db_id: true, owner: true } });
  let dbCount = 0;
  for (const d of dashboards) {
    if (!userIds.has(d.owner)) {
      await prisma.dashboard.update({ where: { db_id: d.db_id }, data: { owner: admin.id } });
      dbCount++;
    }
  }

  // 4. 回填 Card（SqlReport 已弃用 2026-09：SQL 报表迁移为 type='sql' 卡片）
  const cards = await prisma.card.findMany({ select: { card_id: true, owner: true } });
  let rptCount = 0;
  for (const c of cards) {
    if (!userIds.has(c.owner)) {
      await prisma.card.update({ where: { card_id: c.card_id }, data: { owner: admin.id } });
      rptCount++;
    }
  }

  console.log(`回填完成：Dashboard ${dbCount} 个，Card ${rptCount} 个 → admin(${admin.id})`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('回填失败', e);
  process.exit(1);
});
