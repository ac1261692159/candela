import { describe, expect, it, vi } from 'vitest';
import { useAnalysisStore } from '../../stores/analysis.store';
import { useFunnelStore } from '../../stores/funnel.store';
import { useRetentionStore } from '../../stores/retention.store';
import { analyzeEvent, analyzeFunnel, analyzeRetention } from '../../services/query.service';

vi.mock('../../services/query.service', () => ({ analyzeEvent: vi.fn(), analyzeFunnel: vi.fn(), analyzeRetention: vi.fn() }));
describe('query ownership after project reset or a newer request', () => {
  it.each([
    ['event', useAnalysisStore, analyzeEvent], ['funnel', useFunnelStore, analyzeFunnel], ['retention', useRetentionStore, analyzeRetention],
  ] as const)('%s ignores late success and late failure', async (_page, store, query) => {
    const mock = vi.mocked(query);
    let finish!: (value: never) => void;
    let fail!: (error: Error) => void;
    mock.mockImplementationOnce(() => new Promise<never>((resolve) => { finish = resolve; }));
    const old = store.getState().runQuery({ project: 'old' } as never);
    store.getState().reset();
    finish({ rows: ['old'] } as never);
    await old;
    expect(store.getState().result).toBeNull();
    mock.mockImplementationOnce(() => new Promise<never>((_resolve, reject) => { fail = reject; }));
    const failed = store.getState().runQuery({ project: 'current' } as never);
    mock.mockResolvedValueOnce({ rows: ['new'] } as never);
    await store.getState().runQuery({ project: 'current' } as never);
    fail(new Error('late failure'));
    await failed;
    expect(store.getState().result).toEqual({ rows: ['new'] });
    expect(store.getState().error).toBeNull();
    store.getState().reset();
  });
});
