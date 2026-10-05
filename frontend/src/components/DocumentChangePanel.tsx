import { Link } from 'react-router-dom';
import { api, ApiError, relativeTime } from '../api/client';
import { useState } from 'react';
import { useDocumentMonitor } from '../lib/useDocumentMonitor';
import { useApp } from '../context/AppContext';
import { ErrorBox } from './ui';
import { DOCUMENT_MONITOR_STATE_LABEL } from '../api/types';
import type { DocumentMonitorState } from '../api/types';

/**
 * Phase 7: the application-wide list of detected PROJECT.md changes.
 *
 * Shown on the dashboard so a document edited in an editor is noticed without
 * opening that project. It is a list of notices, not a set of actions: every entry
 * links to the project, where the Phase 6 Check / Preview / Synchronize flow
 * takes over. Nothing here writes project data; the only action is dismissing a
 * notification, which hides the banner and leaves the change intact.
 *
 * The panel also states the monitor's real operating mode. If some projects are
 * being watched and some are only being polled, or the monitor is not running at
 * all, it says so rather than implying a guarantee the system is not keeping.
 */
export function DocumentChangePanel() {
  const { pending, pendingCount, status, connected, error, skipped, reload } = useDocumentMonitor();
  const { toast } = useApp();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);

  async function dismiss(projectId: number) {
    setBusyId(projectId);
    setDismissError(null);
    try {
      await api.post(`/projects/${projectId}/project-document/monitor/dismiss`, {});
      reload();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setDismissError(message);
      toast(message);
    } finally {
      setBusyId(null);
    }
  }

  const degraded = status ? status.mode !== 'WATCH' || !status.running : false;

  return (
    <div>
      <h2 className="section">
        Document changes
        {pendingCount > 0 ? (
          <span className="badge" style={{ marginLeft: 8 }}>
            {pendingCount}
          </span>
        ) : null}
      </h2>

      {degraded && status ? (
        <div className="tiny dim" style={{ marginBottom: 8 }}>
          {status.running ? (
            <>
              Monitoring is running in <strong>{status.mode}</strong> mode
              {status.polledProjects > 0
                ? `: ${status.watchedProjects} watched, ${status.polledProjects} checked periodically.`
                : '.'}
              {status.skippedProjects > 0 ? ` ${status.skippedProjects} project(s) have no usable workspace folder.` : ''}
            </>
          ) : (
            <>Document monitoring is not running, so changes made outside Project Hub will not be noticed here.</>
          )}
        </div>
      ) : null}

      {error ? (
        <div style={{ marginBottom: 8 }}>
          <ErrorBox message={error} />
        </div>
      ) : null}

      {dismissError ? (
        <div style={{ marginBottom: 8 }}>
          <ErrorBox message={dismissError} />
        </div>
      ) : null}

      <div className="card">
        {pending.length === 0 ? (
          <div className="dim">
            {pendingCount > 0 ? 'Nothing to review.' : 'No PROJECT.md changes waiting to be reviewed.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {pending.slice(0, 10).map(n => (
              <div key={n.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <Link to={`/projects/${n.projectId}`} style={{ fontWeight: 600 }}>
                    {n.projectName}
                  </Link>
                  <span className="tiny dim">{relativeTime(n.detectedAt)}</span>
                </div>
                <div className="tiny dim" style={{ marginTop: 2 }}>
                  <span style={{ color: stateColor(n.state) }}>{DOCUMENT_MONITOR_STATE_LABEL[n.state]}</span>
                  {n.summary ? ` · ${n.summary}` : ''}
                </div>
                <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Link className="btn sm" to={`/projects/${n.projectId}`}>
                    Review and synchronize
                  </Link>
                  <button className="btn sm" onClick={() => dismiss(n.projectId)} disabled={busyId === n.projectId}>
                    {busyId === n.projectId ? 'Dismissing…' : 'Dismiss'}
                  </button>
                </div>
              </div>
            ))}
            {pending.length > 10 ? (
              <div className="tiny dim">and {pending.length - 10} more.</div>
            ) : null}
          </div>
        )}

        {skipped.length > 0 ? (
          <div className="tiny dim" style={{ marginTop: 10 }}>
            {skipped.length} project(s) are not monitored because their workspace folder is not available.
          </div>
        ) : null}

        <div className="tiny dim" style={{ marginTop: 10 }}>
          {connected
            ? 'Project Hub is watching project documents for changes.'
            : 'Live updates are reconnecting; the list refreshes periodically in the meantime.'}
        </div>
      </div>
    </div>
  );
}

function stateColor(state: DocumentMonitorState): string {
  switch (state) {
    case 'CONFLICT':
    case 'ERROR':
      return 'var(--red)';
    case 'INVALID':
    case 'UNSUPPORTED_VERSION':
    case 'IDENTITY_MISMATCH':
    case 'MISSING':
    case 'UNREADABLE':
    case 'UNAVAILABLE':
      return 'var(--yellow)';
    default:
      return 'var(--blue)';
  }
}