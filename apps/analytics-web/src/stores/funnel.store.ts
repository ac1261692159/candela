import { create } from 'zustand';
import { analyzeFunnel } from '../services/query.service';
import type { FunnelQuery, FunnelResult } from '../types/dsl.types';
import { t } from '../i18n';

interface FunnelState {
  dsl: FunnelQuery | null;
  result: FunnelResult | null;
  loading: boolean;
  error: string | null;
  setDsl: (dsl: FunnelQuery) => void;
  runQuery: (dsl: FunnelQuery) => Promise<void>;
  hydrateCached: (dsl: FunnelQuery, result: FunnelResult) => void;
  reset: () => void;
}

export const useFunnelStore = create<FunnelState>((set) => {
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
      const result = await analyzeFunnel(dsl);
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
