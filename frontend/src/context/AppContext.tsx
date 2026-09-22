import React, { createContext, useCallback, useContext, useState } from 'react';
import type { ProjectSummary, TagUsage } from '../api/types';
import { useApi } from '../lib/useApi';

interface AppContextValue {
  toast: (message: string) => void;
  tags: TagUsage[];
  reloadTags: () => void;
  projects: ProjectSummary[];
  reloadProjects: () => void;
  openQuickAdd: () => void;
  registerQuickAdd: (fn: () => void) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const [quickAddFn, setQuickAddFn] = useState<(() => void) | null>(null);

  const { data: tagsResp, reload: reloadTags } = useApi<TagUsage[]>('/tags');
  const { data: projectsResp, reload: reloadProjects } = useApi<ProjectSummary[]>('/projects?archived=all');

  const toast = useCallback((msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(null), 5000);
  }, []);

  const registerQuickAdd = useCallback((fn: () => void) => {
    setQuickAddFn(() => fn);
  }, []);

  const openQuickAdd = useCallback(() => {
    if (quickAddFn) quickAddFn();
    else window.dispatchEvent(new CustomEvent('open-quickadd'));
  }, [quickAddFn]);

  return (
    <AppContext.Provider
      value={{
        toast,
        tags: tagsResp ?? [],
        reloadTags,
        projects: projectsResp ?? [],
        reloadProjects,
        openQuickAdd,
        registerQuickAdd
      }}
    >
      {children}
      {message ? (
        <div className="toast" role="alert">
          {message}
        </div>
      ) : null}
    </AppContext.Provider>
  );
}