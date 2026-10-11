/**
 * CardRepository：删除卡片的引用级联与看板内列表容错（AC1 / AC2）。
 */
import { CardRepository } from '../../src/modules/report/card.repository';
import { PrismaService } from '../../src/modules/shared/prisma.service';

describe('CardRepository.delete（删除卡片级联清理引用）', () => {
  function setup() {
    const tx = {
      dashboardCard: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
      card: { delete: jest.fn().mockResolvedValue({ card_id: 'c1' }) },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    return { tx, prisma, repo: new CardRepository(prisma as unknown as PrismaService) };
  }

  it('先清理看板引用再删卡片（同一事务）', async () => {
    const { tx, prisma, repo } = setup();

    await repo.delete('c1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.dashboardCard.deleteMany).toHaveBeenCalledWith({ where: { card_id: 'c1' } });
    expect(tx.card.delete).toHaveBeenCalledWith({ where: { card_id: 'c1' } });
  });

  it('被多个看板引用时一次性清理全部引用', async () => {
    const { tx, repo } = setup();
    tx.dashboardCard.deleteMany.mockResolvedValue({ count: 3 });

    await repo.delete('c1');

    // deleteMany 按 card_id 清理，覆盖所有看板，无需逐个 db_id
    expect(tx.dashboardCard.deleteMany).toHaveBeenCalledWith({ where: { card_id: 'c1' } });
  });

  it('删除卡片失败时不留下已清理的引用（事务内）', async () => {
    const { tx, prisma, repo } = setup();
    tx.card.delete.mockRejectedValue(new Error('fk error'));

    await expect(repo.delete('c1')).rejects.toThrow('fk error');
    expect(tx.dashboardCard.deleteMany).toHaveBeenCalled();
  });
});

describe('CardRepository.findDashboardCards（孤儿关联容错）', () => {
  it('关联行卡片缺失时忽略，不抛 Inconsistent query result', async () => {
    const links = [
      { id: 'l1', db_id: 'db1', card_id: 'c1', position_x: 0, position_y: 0, width: 6, height: 4, created_at: new Date() },
      { id: 'l2', db_id: 'db1', card_id: 'c_gone', position_x: 0, position_y: 4, width: 6, height: 4, created_at: new Date() },
    ];
    const prisma = {
      dashboardCard: { findMany: jest.fn().mockResolvedValue(links) },
      card: {
        findMany: jest.fn().mockResolvedValue([
          {
            card_id: 'c1',
            project_name: 'clklogapp',
            owner: 'u1',
            name: '卡片1',
            type: 'sql',
            dsl_json: '{}',
            chart_type: 'line',
            refresh_policy: 'auto',
            locked: false,
            created_at: new Date(),
            updated_at: new Date(),
            cache: null,
          },
        ]),
      },
    };

    const repo = new CardRepository(prisma as unknown as PrismaService);
    const result = await repo.findDashboardCards('db1');

    expect(result).toHaveLength(1);
    expect(result[0].card_id).toBe('c1');
    expect(prisma.dashboardCard.findMany).toHaveBeenCalledWith({
      where: { db_id: 'db1' },
      orderBy: [{ position_y: 'asc' }, { position_x: 'asc' }],
    });
  });
});
