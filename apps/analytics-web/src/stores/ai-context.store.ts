import { create } from 'zustand';
import type { AiAnalysisPage, AiPageContext } from '../types/ai.types';
import { allocatePageRevision, editableContext } from '../features/ai/page-context-revision';

interface AiContextState {
  context: AiPageContext | null;
  project: string | null;
  publishContext: (context: AiPageContext, project: string) => void;
  clearContext: (page?: AiAnalysisPage, project?: string) => void;
  rebaseRevision: (minimum: number) => void;
}

export const useAiContextStore = create<AiContextState>((set) => ({
  context: null,
  project: null,
  publishContext: (context, project) => set((state) => ({
    project,
    context: { ...context, revision: state.project === project && state.context
      && editableContext(state.context) === editableContext(context)
      ? state.context.revision : allocatePageRevision(state.context?.revision) },
  })),
  rebaseRevision: (minimum) => set((state) => state.context
    ? { context: { ...state.context, revision: allocatePageRevision(minimum) } } : state),
  clearContext: (page, project) =>
    set((state) => {
      if (page && state.context?.page !== page) return state;
      if (project && state.project !== project) return state;
      return { context: null, project: null };
    }),
}));
