import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';

/** 与查询缓存 TTL 对齐：发布后 5 分钟内旧版本仍可供在途读（DT-14） */
export const LEASE_MINUTES = 5;
export const RETAIN_MS = LEASE_MINUTES * 60 * 1000;

/**
 * 数据表导入租约（架构 §9.3）。抢占/发布都是单条 UPDATE，影响行数 = 1 才算成功。
 */
@Injectable()
export class DatatableLease {
  constructor(private readonly prisma: PrismaService) {}

  /** 抢租约并分配 pending_version = version_seq+1。失败返回 null（调用方变 409）。 */
  async acquire(id: string, project: string, owner: string): Promise<number | null> {
    const affected = await this.prisma.$executeRaw`
      UPDATE datatable
         SET import_owner = ${owner},
             lease_until = DATE_ADD(NOW(3), INTERVAL 5 MINUTE),
             version_seq = version_seq + 1,
             pending_version = version_seq
       WHERE id = ${id}
         AND project_name = ${project}
         AND status <> 'deleted'
         AND (lease_until IS NULL OR lease_until < NOW(3))
    `;
    if (Number(affected) !== 1) return null;
    const row = await this.prisma.metaDatatable.findFirst({
      where: { id, project_name: project },
      select: { pending_version: true },
    });
    return row?.pending_version ?? null;
  }

  async heartbeat(id: string, owner: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE datatable
         SET lease_until = DATE_ADD(NOW(3), INTERVAL 5 MINUTE)
       WHERE id = ${id} AND import_owner = ${owner}
    `;
  }

  /** CAS 发布：只在仍持有同一 pending 时切 active。成功则顺带释放租约。 */
  async publish(
    id: string,
    owner: string,
    pendingVersion: number,
    rowCount: number,
    user: string,
  ): Promise<boolean> {
    const affected = await this.prisma.$executeRaw`
      UPDATE datatable
         SET active_version = pending_version,
             row_count = ${rowCount},
             pending_version = NULL,
             import_owner = NULL,
             lease_until = NULL,
             updated_by = ${user}
       WHERE id = ${id}
         AND import_owner = ${owner}
         AND pending_version = ${pendingVersion}
    `;
    return Number(affected) === 1;
  }

  /** 发布前失败：丢掉 pending，不碰 active_version。 */
  async release(id: string, owner: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE datatable
         SET pending_version = NULL,
             import_owner = NULL,
             lease_until = NULL
       WHERE id = ${id} AND import_owner = ${owner}
    `;
  }

  /** 进程启动：租约过期且 pending 未发布 → 清元数据，调用方再删 CH pending 行。 */
  async recoverExpired(): Promise<{ id: string; project_name: string; pending_version: number }[]> {
    const now = new Date();
    const rows = await this.prisma.metaDatatable.findMany({
      where: {
        pending_version: { not: null },
        OR: [{ lease_until: null }, { lease_until: { lt: now } }],
      },
      select: {
        id: true,
        project_name: true,
        pending_version: true,
        active_version: true,
      },
    });
    const recovered: { id: string; project_name: string; pending_version: number }[] = [];
    for (const row of rows) {
      if (row.pending_version == null || row.pending_version === row.active_version) continue;
      recovered.push({
        id: row.id,
        project_name: row.project_name,
        pending_version: row.pending_version,
      });
      await this.prisma.metaDatatable.update({
        where: { id: row.id },
        data: { pending_version: null, import_owner: null, lease_until: null },
      });
    }
    return recovered;
  }
}
