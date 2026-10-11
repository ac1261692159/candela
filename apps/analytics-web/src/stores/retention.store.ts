import { create } from 'zustand';
import { analyzeRetention } from '../services/query.service';
import type { RetentionQuery, QueryResult } from '../types/dsl.types';
import { t } from '../i18n';

interface RetentionState {
  dsl: RetentionQuery | null;
  result: QueryResult | null;
  loading: boolean;
  error: string | null;
  setDsl: (dsl: RetentionQuery) => void;
  runQuery: (dsl: RetentionQuery) => Promise<void>;
  hydrateCached: (dsl: RetentionQuery, result: QueryResult) => void;
  reset: () => void;
}

export const useRetentionStore = create<RetentionState>((set) => {
  let generation = 0;
  return ({
  dsl: null,
  result: null,
  loading: false,
  error: null,
  setDsl: (dsl) => set({ dsl }),
  hydrateCached: (dsl, result) => {
    generation += 1;
    set({ dsl, result: { ...result, from_cache: true }, loading: false, error: null });
  },
  runQuery: async (dsl) => {
    const request = ++generation;
    set({ loading: true, error: null });
    try {
      const result = await analyzeRetention(dsl);
      if (request === generation) set({ result, dsl, loading: false });
    } catch (err) {
      if (request !== generation) return;
      set({
        error: err instanceof Error ? err.message : t('errors:queryFailed'),
        loading: false,
      });
    }
  },
  reset: () => { generation++; set({ dsl: null, result: null, loading: false, error: null }); },
  });
});
