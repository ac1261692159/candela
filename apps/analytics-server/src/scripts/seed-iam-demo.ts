/**
 * 可选：用 IAM_DEMO_PASSWORD 创建演示登录账号（analyst1 / member1 / external1）。
 * 不把密码写入仓库。IamService 启动时会把已存在的这些账号挂进 clklogapp 成员组。
 *
 * 用法：IAM_DEMO_PASSWORD=xxx npx ts-node src/scripts/seed-iam-demo.ts
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../modules/auth/password.util';
import { IAM_DEMO_USERS } from '../modules/iam/iam.service';

async function main() {
  const password = process.env.IAM_DEMO_PASSWORD;
  if (!password || password.length < 6) {
    console.error('请设置 IAM_DEMO_PASSWORD（至少 6 位）');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    for (const acc of IAM_DEMO_USERS) {
      const existing = await prisma.saUser.findUnique({ where: { username: acc.username } });
      if (existing) continue;
      await prisma.saUser.create({
        data: {
          username: acc.username,
          password_hash: hashPassword(password),
          display_name: acc.display_name,
          platform_role: 'none',
          status: 'active',
        },
      });
    }
    console.log('演示登录账号已确保存在（已有用户不会改密）');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('演示账号初始化失败', e);
  process.exit(1);
});
