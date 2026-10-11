import { create } from 'zustand';
import { analyzeEvent } from '../services/query.service';
import type { EventAnalysisQuery, QueryResult } from '../types/dsl.types';
import { t } from '../i18n';

interface AnalysisState {
  dsl: EventAnalysisQuery | null;
  result: QueryResult | null;
  loading: boolean;
  error: string | null;
  setDsl: (dsl: EventAnalysisQuery) => void;
  runQuery: (dsl: EventAnalysisQuery) => Promise<void>;
  hydrateCached: (dsl: EventAnalysisQuery, result: QueryResult) => void;
  reset: () => void;
}

export const useAnalysisStore = create<AnalysisState>((set) => {
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
      const result = await analyzeEvent(dsl);
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
