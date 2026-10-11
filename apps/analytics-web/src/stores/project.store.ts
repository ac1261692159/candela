import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ProjectOption {
  name: string;
  display_name: string;
  timezone?: string | null;
}

interface ProjectState {
  projects: ProjectOption[];
  currentProject: string;
  setProjects: (projects: ProjectOption[]) => void;
  setCurrentProject: (project: string) => void;
}

const defaultProjects: ProjectOption[] = [
  { name: 'clklogapp', display_name: 'clklogapp' },
  { name: 'default', display_name: 'default' },
];

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      projects: defaultProjects,
      currentProject: defaultProjects[0].name,
      setProjects: (projects) => set({ projects: projects.length ? projects : defaultProjects }),
      setCurrentProject: (project) => set({ currentProject: project }),
    }),
    {
      name: 'clklog-analytics-project',
      partialize: (state) => ({ currentProject: state.currentProject }),
    },
  ),
);
