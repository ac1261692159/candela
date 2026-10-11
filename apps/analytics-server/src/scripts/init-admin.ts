/**
 * 初始化默认 admin 用户（首次部署时执行一次）。
 * 密码从环境变量 ADMIN_INIT_PASSWORD 读取。
 * 用法：ADMIN_INIT_PASSWORD=xxx npx ts-node src/scripts/init-admin.ts
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../modules/auth/password.util';

async function main() {
  const prisma = new PrismaClient();
  const password = process.env.ADMIN_INIT_PASSWORD;
  if (!password) {
    console.error('请设置 ADMIN_INIT_PASSWORD 环境变量');
    process.exit(1);
  }

  const existing = await prisma.saUser.findUnique({ where: { username: 'admin' } });
  if (existing) {
    console.log('admin 用户已存在，跳过初始化');
    await prisma.$disconnect();
    return;
  }

  await prisma.saUser.create({
    data: {
      username: 'admin',
      password_hash: hashPassword(password),
      display_name: '管理员',
      platform_role: 'super_admin',
      status: 'active',
      created_by: 'system',
    },
  });
  const admin = await prisma.saUser.findUnique({ where: { username: 'admin' } });
  if (admin) {
    await prisma.saProjectMember.upsert({
      where: { project_name_user_id: { project_name: 'clklogapp', user_id: admin.id } },
      create: { project_name: 'clklogapp', user_id: admin.id, role_key: 'project_owner' },
      update: { role_key: 'project_owner' },
    });
  }
  console.log('已创建默认超管并指定 clklogapp owner');
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('初始化失败', e);
  process.exit(1);
});
