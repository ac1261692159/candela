/**
 * 指标写入口归属判定（phase: clklog-analytics-rbac-v3 §6）。
 *
 * 修正前：`metric.edit_own` 被当成「可写全项目指标」的路由守卫，`metric.edit_others`
 * 从未被任何代码消费。修正后：本人指标放行，否则要求 `metric.edit_others`。
 */
import { MetaSavedMetricService } from './meta-saved-metric.service';
import { emptyIam, type IamContext } from '../iam/iam.types';

const PROJECT = 'clklogapp';

function metricRow(owner: string) {
  return {
    metric_id: 'metric_abc',
    project_name: PROJECT,
    owner,
    name: 'pv',
    display_name: 'PV',
    remark: null,
    kind: 'event',
    definition_json: JSON.stringify({ metric: { event: 'PageView', analysis: 'count' } }),
    format: 'number',
    created_at: new Date('2026-09-01T00:00:00Z'),
    updated_at: new Date('2026-09-01T00:00:00Z'),
  };
}

function iamWith(codes: string[]): IamContext {
  return { ...emptyIam(), member: true, role_key: 'analyst', permissions: new Set(codes) };
}

function build(existing: ReturnType<typeof metricRow> | null) {
  const repository = {
    findById: jest.fn().mockResolvedValue(existing),
    update: jest.fn().mockResolvedValue({ count: 1 }),
    delete: jest.fn().mockResolvedValue({ count: 1 }),
    list: jest.fn().mockResolvedValue([]),
    findByName: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
  };
  const prisma = { opsActionLog: { create: jest.fn().mockResolvedValue({}) } };
  const service = new MetaSavedMetricService(repository as never, prisma as never);
  return { service, repository, prisma };
}

describe('指标写入口归属判定（rbac-v3）', () => {
  it('分析师删自己的指标：放行，审计记录真实操作者', async () => {
    const { service, repository, prisma } = build(metricRow('u-analyst'));

    await expect(
      service.delete('metric_abc', PROJECT, 'u-analyst', iamWith(['metric.edit_own'])),
    ).resolves.toEqual({ success: true });

    expect(repository.delete).toHaveBeenCalledWith('metric_abc', PROJECT);
    expect(prisma.opsActionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'alert_metric_delete', operator: 'u-analyst' }),
      }),
    );
  });

  it('分析师删他人指标：403 meta.metric.notOwner，且不落删除', async () => {
    const { service, repository } = build(metricRow('u-admin'));

    await expect(
      service.delete('metric_abc', PROJECT, 'u-analyst', iamWith(['metric.edit_own'])),
    ).rejects.toMatchObject({ errorCode: 'meta.metric.notOwner' });

    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('持 metric.edit_others 的管理员删他人指标：放行', async () => {
    const { service, repository } = build(metricRow('u-analyst'));

    await expect(
      service.delete('metric_abc', PROJECT, 'u-admin', iamWith(['metric.edit_own', 'metric.edit_others'])),
    ).resolves.toEqual({ success: true });

    expect(repository.delete).toHaveBeenCalled();
  });

  it('分析师改他人指标：403 且不落写库；改自己的成功', async () => {
    const other = build(metricRow('u-admin'));
    await expect(
      other.service.update('metric_abc', PROJECT, { display_name: 'PV2' }, 'u-analyst', iamWith(['metric.edit_own'])),
    ).rejects.toMatchObject({ errorCode: 'meta.metric.notOwner' });
    expect(other.repository.update).not.toHaveBeenCalled();

    const own = build(metricRow('u-analyst'));
    await expect(
      own.service.update('metric_abc', PROJECT, { display_name: 'PV2' }, 'u-analyst', iamWith(['metric.edit_own'])),
    ).resolves.toMatchObject({ metric_id: 'metric_abc' });
    expect(own.repository.update).toHaveBeenCalled();
    expect(own.prisma.opsActionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'alert_metric_update', operator: 'u-analyst' }),
      }),
    );
  });

  it('指标不存在：先给 404，不泄露归属', async () => {
    const { service } = build(null);

    await expect(
      service.delete('metric_missing', PROJECT, 'u-analyst', iamWith(['metric.edit_own'])),
    ).rejects.toMatchObject({ errorCode: 'meta.metric.notFound' });
  });
});
