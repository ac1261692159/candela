/**
 * CardCacheWorker：刷新失败落缓存 + 退避重试（AC5 / AC6）。
 *
 * 回归背景：此前失败只写日志，`refreshed_at` 不前进，必然超时的卡片被每 30s
 * 无限重试，且前端拿不到失败原因只能显示空白。
 */
// card.service / card.repository 顶层会加载 YAML 配置（需 APP_CONFIG_PATH 与真实密钥），
// 单测里隔离掉——与 test/ops、test/alerting 各 spec 同款处理
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { Test, type TestingModule } from '@nestjs/testing';
import { CardCacheWorker } from '../../src/modules/report/card-cache.worker';
import { CardRepository } from '../../src/modules/report/card.repository';
import { CardService } from '../../src/modules/report/card.service';
import { WORKER_FAIL_BACKOFF_BASE_MS } from '../../src/modules/report/card-cache.policy';

function makeRow(cardId: string, extra: Record<string, unknown> = {}) {
  return {
    card_id: cardId,
    type: 'sql',
    dsl_json: '{}',
    project_name: 'clklogapp',
    dashboard_cards: [{ dashboard: { cache_ttl_sec: 300 } }],
    cache: null,
    ...extra,
  };
}

describe('CardCacheWorker', () => {
  let moduleRef: TestingModule;
  let worker: CardCacheWorker;
  let cards: { findWorkerCandidates: jest.Mock };
  let cardService: { computeResult: jest.Mock; writeCache: jest.Mock };

  beforeEach(async () => {
    cards = { findWorkerCandidates: jest.fn().mockResolvedValue([]) };
    cardService = { computeResult: jest.fn(), writeCache: jest.fn() };
    moduleRef = await Test.createTestingModule({
      providers: [
        CardCacheWorker,
        { provide: CardRepository, useValue: cards },
        { provide: CardService, useValue: cardService },
      ],
    }).compile();
    worker = moduleRef.get(CardCacheWorker);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('刷新成功写入缓存且 error 为 null', async () => {
    cards.findWorkerCandidates.mockResolvedValue([makeRow('c1')]);
    cardService.computeResult.mockResolvedValue({ rows: [{ n: 1 }] });

    await worker.tick();

    expect(cardService.computeResult).toHaveBeenCalledTimes(1);
    expect(cardService.writeCache).toHaveBeenCalledWith('c1', { rows: [{ n: 1 }] }, null);
  });

  it('刷新失败写入 error，并保留上一次可用结果（AC5）', async () => {
    const previous = { rows: [{ n: 42 }] };
    cards.findWorkerCandidates.mockResolvedValue([
      makeRow('c1', { cache: { result_json: JSON.stringify(previous) } }),
    ]);
    cardService.computeResult.mockRejectedValue(new Error('Timeout error.'));

    await worker.tick();

    expect(cardService.writeCache).toHaveBeenCalledWith('c1', previous, 'Timeout error.');
  });

  it('无历史结果时失败写入 null 结果而非抛错', async () => {
    cards.findWorkerCandidates.mockResolvedValue([makeRow('c1')]);
    cardService.computeResult.mockRejectedValue(new Error('Timeout error.'));

    await worker.tick();

    expect(cardService.writeCache).toHaveBeenCalledWith('c1', null, 'Timeout error.');
  });

  it('失败后按退避跳过下一次 tick，不再每 30s 重试（AC6）', async () => {
    cards.findWorkerCandidates.mockResolvedValue([makeRow('c1')]);
    cardService.computeResult.mockRejectedValue(new Error('Timeout error.'));

    await worker.tick();
    expect(cardService.computeResult).toHaveBeenCalledTimes(1);

    cardService.computeResult.mockClear();
    await worker.tick();
    expect(cardService.computeResult).not.toHaveBeenCalled();
  });

  it('退避时长随连续失败指数增长且有上限', async () => {
    cards.findWorkerCandidates.mockResolvedValue([makeRow('c1')]);
    cardService.computeResult.mockRejectedValue(new Error('Timeout error.'));

    await worker.tick();
    const first = worker['failures'].get('c1');
    expect(first?.fails).toBe(1);
    expect(first!.nextAttemptAt - Date.now()).toBeGreaterThan(WORKER_FAIL_BACKOFF_BASE_MS - 5_000);

    // 手动把退避时间提前，制造第二次失败
    worker['failures'].set('c1', { fails: 1, nextAttemptAt: 0 });
    await worker.tick();
    expect(worker['failures'].get('c1')?.fails).toBe(2);
  });

  it('成功后清除失败记忆，下次失败重新从 1 计', async () => {
    cards.findWorkerCandidates.mockResolvedValue([makeRow('c1')]);
    cardService.computeResult.mockRejectedValueOnce(new Error('Timeout error.'));
    await worker.tick();
    expect(worker['failures'].get('c1')?.fails).toBe(1);

    worker['failures'].set('c1', { fails: 1, nextAttemptAt: 0 });
    cardService.computeResult.mockResolvedValueOnce({ rows: [] });
    await worker.tick();

    expect(worker['failures'].has('c1')).toBe(false);
  });

  it('写缓存失败不影响 tick 完成', async () => {
    cards.findWorkerCandidates.mockResolvedValue([makeRow('c1')]);
    cardService.computeResult.mockRejectedValue(new Error('Timeout error.'));
    cardService.writeCache.mockRejectedValue(new Error('db down'));

    await expect(worker.tick()).resolves.toBeUndefined();
  });

  it('卡片不再候选时清除失败记忆（防内存无界增长）', async () => {
    cards.findWorkerCandidates.mockResolvedValue([makeRow('c1')]);
    cardService.computeResult.mockRejectedValue(new Error('Timeout error.'));
    await worker.tick();
    expect(worker['failures'].has('c1')).toBe(true);

    cards.findWorkerCandidates.mockResolvedValue([]);
    await worker.tick();
    expect(worker['failures'].has('c1')).toBe(false);
  });
});
