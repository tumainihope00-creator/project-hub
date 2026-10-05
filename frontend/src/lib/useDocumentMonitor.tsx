import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api/client';
import type {
  DocumentChangeNotification,
  DocumentMonitorSnapshot,
  DocumentMonitorStatus
} from '../api/types';

/**
 * Phase 7: the client's single view of the centralized document monitor.
 *
 * There is exactly one provider, mounted once in App.tsx, and it holds exactly one
 * server-sent-events subscription for the whole application. Every consumer - the
 * dashboard badge, a project card, the project page - reads from this context, so
 * opening a project cannot create a second subscription and cannot produce a
 * second, divergent picture of the same change. The backend is likewise a single
 * service with one watcher per project, so the "one logical registration per
 * project" property holds on both sides of the wire.
 *
 * Transport: server-sent events from `/api/document-monitor/stream`, plus the
 * regular `GET /api/document-monitor` snapshot fetched on mount. SSE was chosen
 * over WebSockets because this is a strictly one-directional notification channel
 * with no client-to-server messages, and over polling because a browser sitting on
 * a dashboard should not re-read every project's document just to notice an edit.
 *
 * Two fallbacks keep it honest rather than decorative:
 *
 *  - if the stream cannot be established (a proxy that buffers, or a browser
 *    without EventSource), the hook polls the snapshot endpoint on an interval;
 *  - if the stream drops, the snapshot is re-fetched before reconnecting, so a
 *    change detected during the gap is still shown rather than lost.
 */

export interface DocumentMonitorContextValue {
  status: DocumentMonitorStatus | null;
  /** Every pending change, including dismissed ones. */
  allPending: DocumentChangeNotification[];
  /** Pending changes the user has not dismissed, newest first. */
  pending: DocumentChangeNotification[];
  pendingCount: number;
  skipped: { projectId: number; reason: string }[];
  /** True when the live stream is established, not merely the polling fallback. */
  connected: boolean;
  error: string | null;
  reload: () => void;
}

const emptyValue: DocumentMonitorContextValue = {
  status: null,
  allPending: [],
  pending: [],
  pendingCount: 0,
  skipped: [],
  connected: false,
  error: null,
  reload: () => undefined
};

const DocumentMonitorContext = createContext<DocumentMonitorContextValue>(emptyValue);

export function DocumentMonitorProvider({
  children,
  pollIntervalMs = 20_000
}: {
  children: ReactNode;
  pollIntervalMs?: number;
}) {
  const [snapshot, setSnapshot] = useState<DocumentMonitorSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(() => setReloadKey(k => k + 1), []);

  // The snapshot fetch: on mount, on `reload()`, and as the reconnect path.
  useEffect(() => {
    let cancelled = false;
    api
      .get<DocumentMonitorSnapshot>('/document-monitor')
      .then(res => {
        if (!cancelled && mounted.current) {
          setSnapshot(res.data);
          setError(null);
        }
      })
      .catch(err => {
        if (!cancelled && mounted.current) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // The event stream, with a polling fallback for when it cannot be opened.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;

    let source: EventSource | null = null;
    let fallback: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const startPolling = () => {
      if (fallback || cancelled) return;
      fallback = setInterval(() => {
        if (cancelled) return;
        api
          .get<DocumentMonitorSnapshot>('/document-monitor')
          .then(res => {
            if (mounted.current) setSnapshot(res.data);
          })
          .catch(() => undefined);
      }, pollIntervalMs);
    };

    const fetchSnapshot = () => {
      api
        .get<DocumentMonitorSnapshot>('/document-monitor')
        .then(res => {
          if (mounted.current) setSnapshot(res.data);
        })
        .catch(() => undefined);
    };

    try {
      source = new EventSource('/api/document-monitor/stream');
    } catch {
      startPolling();
      return;
    }

    source.onopen = () => {
      if (!cancelled) setConnected(true);
      // The stream superseded the fallback.
      if (fallback) {
        clearInterval(fallback);
        fallback = null;
      }
    };

    // The server sends a full snapshot as the first frame, so a fresh connection
    // is correct immediately without an extra request.
    source.addEventListener('snapshot', e => {
      if (cancelled || !mounted.current) return;
      try {
        setSnapshot(JSON.parse((e as MessageEvent).data));
        setConnected(true);
      } catch {
        // A malformed frame must not take the dashboard down; the next frame or
        // the next poll corrects it.
      }
    });

    source.addEventListener('change', e => {
      if (cancelled || !mounted.current) return;
      try {
        const payload = JSON.parse((e as MessageEvent).data) as {
          notification: DocumentChangeNotification;
          pendingCount: number;
        };
        setSnapshot(prev => {
          if (!prev) return prev;
          const pending = [
            payload.notification,
            ...prev.pending.filter(n => n.projectId !== payload.notification.projectId)
          ].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
          return { ...prev, pending, pendingCount: payload.pendingCount };
        });
      } catch {
        // ignored, as above
      }
    });

    source.addEventListener('dismissed', e => {
      if (cancelled || !mounted.current) return;
      try {
        const payload = JSON.parse((e as MessageEvent).data) as { projectId: number; pendingCount: number };
        setSnapshot(prev =>
          prev
            ? {
                ...prev,
                pending: prev.pending.map(n =>
                  n.projectId === payload.projectId ? { ...n, dismissedAt: new Date().toISOString() } : n
                ),
                pendingCount: payload.pendingCount
              }
            : prev
        );
      } catch {
        // ignored
      }
    });

    source.addEventListener('synchronized', e => {
      if (cancelled || !mounted.current) return;
      try {
        const payload = JSON.parse((e as MessageEvent).data) as { projectId: number; pendingCount: number };
        setSnapshot(prev =>
          prev
            ? {
                ...prev,
                pending: prev.pending.filter(n => n.projectId !== payload.projectId),
                pendingCount: payload.pendingCount
              }
            : prev
        );
      } catch {
        // ignored
      }
    });

    source.onerror = () => {
      if (cancelled) return;
      setConnected(false);
      // EventSource reconnects on its own, but a change made during the gap would
      // be missed. Reconcile now, and poll for as long as the stream is down -
      // the HTTP status endpoint may well still answer even when the stream does
      // not, so polling has to start whether or not the snapshot request succeeds.
      fetchSnapshot();
      startPolling();
    };

    return () => {
      cancelled = true;
      if (fallback) clearInterval(fallback);
      source.close();
    };
  }, [pollIntervalMs, reloadKey]);

  const value = useMemo<DocumentMonitorContextValue>(
    () => ({
      status: snapshot?.status ?? null,
      allPending: snapshot?.pending ?? [],
      pending: (snapshot?.pending ?? []).filter(n => n.dismissedAt == null),
      pendingCount: snapshot?.pendingCount ?? 0,
      skipped: snapshot?.skipped ?? [],
      connected,
      error,
      reload
    }),
    [snapshot, connected, error, reload]
  );

  return <DocumentMonitorContext.Provider value={value}>{children}</DocumentMonitorContext.Provider>;
}

/** The shared monitor state. Safe to call anywhere under the provider. */
export function useDocumentMonitor(): DocumentMonitorContextValue {
  return useContext(DocumentMonitorContext);
}

export interface ProjectMonitorView {
  state: DocumentChangeNotification['state'] | null;
  /** The undismissed notification, if any. */
  notification: DocumentChangeNotification | null;
  /** The notification including a dismissed one, so the card can show it quietly. */
  anyNotification: DocumentChangeNotification | null;
  hasPendingChange: boolean;
  summary: string | null;
  detectedAt: string | null;
  mode: 'WATCH' | 'POLL' | null;
  monitored: boolean;
  reload: () => void;
}

/**
 * One project's monitored state, derived from the shared snapshot.
 *
 * Derived rather than fetched, so a project card on the dashboard and the same
 * project's page cannot disagree, and mounting the card costs no request.
 *
 * When the monitor has nothing recorded for a project - one created before the
 * monitor started, or one the monitor does not manage - the Phase 6 change
 * detection state is used as the fallback. It answers the same question from the
 * database, so the card still shows the truth; it simply does not claim a
 * notification the monitor never produced.
 */
export function useProjectMonitor(
  projectId: number | null,
  syncState?: { modified: boolean; conflict: boolean; neverSynchronized: boolean } | null
): ProjectMonitorView {
  const { allPending, pending, status, reload } = useDocumentMonitor();

  const any = allPending.find(n => n.projectId === projectId) ?? null;
  const undismissed = pending.find(n => n.projectId === projectId) ?? null;

  let state: DocumentChangeNotification['state'] | null = any?.state ?? null;
  if (!state && syncState) {
    if (syncState.conflict) state = 'CONFLICT';
    else if (syncState.modified) state = 'MODIFIED';
    else state = 'SYNCHRONIZED';
  }

  return {
    state,
    notification: undismissed,
    anyNotification: any,
    hasPendingChange: !!undismissed,
    summary: any?.summary ?? null,
    detectedAt: any?.detectedAt ?? null,
    mode: any?.mode ?? null,
    monitored: status?.running ?? false,
    reload
  };
}