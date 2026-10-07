import React, { createContext, useCallback, useContext, useState } from 'react';
import { CheckCircle2, CircleAlert, Info } from 'lucide-react';
import type { ProjectSummary, TagUsage } from '../api/types';
import { useApi } from '../lib/useApi';

export type ToastKind = 'success' | 'info' | 'error';

interface AppContextValue {
  toast: (message: string, kind?: ToastKind) => void;
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

const TOAST_ICON: Record<ToastKind, React.ReactNode> = {
  success: <CheckCircle2 />,
  info: <Info />,
  error: <CircleAlert />
};

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [toastState, setToastState] = useState<{ msg: string; kind: ToastKind } | null>(null);
  const [quickAddFn, setQuickAddFn] = useState<(() => void) | null>(null);

  const { data: tagsResp, reload: reloadTags } = useApi<TagUsage[]>('/tags');
  const { data: projectsResp, reload: reloadProjects } = useApi<ProjectSummary[]>('/projects?archived=all');

  /**
   * 5s auto-dismiss, announced via role="alert" (unchanged contract). The kind
   * decides the accent so success does not look like a failure. The timer
   * compares by entry identity, so a newer toast is never cleared by the older
   * toast's timer.
   */
  const toast = useCallback((msg: string, kind: ToastKind = 'success') => {
    const entry = { msg, kind };
    setToastState(entry);
    setTimeout(() => setToastState(cur => (cur === entry ? null : cur)), 5000);
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
      {toastState ? (
        <div className={`toast ${toastState.kind}`} role="alert">
          {TOAST_ICON[toastState.kind]}
          {toastState.msg}
        </div>
      ) : null}
    </AppContext.Provider>
  );
}
