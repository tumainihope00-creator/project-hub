import { createContext, useContext } from 'react';
import type { Project } from '../api/types';

interface ProjectContextValue {
  project: Project;
  reload: () => void;
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used within a project workspace');
  return ctx;
}