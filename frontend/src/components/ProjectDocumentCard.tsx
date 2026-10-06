import { useState } from 'react';
import { api, ApiError, formatDateTime, relativeTime } from '../api/client';
import { useApi } from '../lib/useApi';
import { useProject } from '../context/ProjectContext';
import { Modal, Loading, ErrorBox } from '../components/ui';
import { Markdown } from '../lib/markdown';
import { useProjectMonitor } from '../lib/useDocumentMonitor';
import { DOCUMENT_MONITOR_STATE_LABEL, PROJECT_DOCUMENT_SYNC_STATE_LABEL } from '../api/types';
import type {
  DocumentChangeNotification,
  DocumentMonitorState,
  ProjectDocumentConflict,
  ProjectDocumentConflictResolution,
  ProjectDocumentContent,
  ProjectDocumentStatus,
  ProjectDocumentSyncHistoryEntry,
  ProjectDocumentSyncState,
  ProjectDocumentSyncPreview,
  ProjectDocumentSyncResult,
  ProjectDocumentSyncStatus
} from '../api/types';

/**
 * PROJECT.md: the human-readable document that lives in the project workspace.
 *
 * This card carries three features that are deliberately kept apart:
 *
 *  - Phase 4: Project Hub *writes* PROJECT.md from the database. Generate and
 *    Regenerate are the only actions that touch the file, Regenerate is behind an
 *    explicit confirmation, and there is no automatic regeneration, because a
 *    background rewrite would silently discard the user's edits.
 *  - Phase 6: Project Hub can *read* PROJECT.md back and apply it to the database,
 *    but only when the user explicitly asks. There is a Check button (read-only),
 *    a Preview button (builds the change set and writes nothing) and a
 *    Synchronize button (applies it in one transaction, behind a confirmation that
 *    lists what will change).
 *  - Phase 7: the backend *notices* when the file changed and says so. The banner
 *    below is that notice. It is read-only - detecting a change applies nothing -
 *    and it leads to the same Check / Preview / Synchronize buttons. Nothing is
 *    ever applied automatically.
 *
 * STATUS.md is not involved in any of this.
 */
export function ProjectDocumentCard() {
  const { project } = useProject();
  const status = useApi<ProjectDocumentStatus>(`/projects/${project.id}/project-document`);
  const syncState = useApi<ProjectDocumentSyncState>(`/projects/${project.id}/project-document/sync/state`);
  const monitor = useProjectMonitor(project.id, syncState.data);

  const [viewing, setViewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const data = status.data;
  const state = syncState.data;

  async function generate() {
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/projects/${project.id}/project-document`, {});
      status.reload();
      syncState.reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/projects/${project.id}/project-document/regenerate`, { confirm: true });
      setConfirming(false);
      status.reload();
      syncState.reload();
      monitor.reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // A project that cannot have a document gets an explanation, not an error and
  // not a button that would do nothing.
  if (data && !data.available) {
    return (
      <div className="card dim">
        <div className="tiny dim">PROJECT.md</div>
        <div style={{ margin: '4px 0 8px' }}>{data.message}</div>
        {data.possibleAction ? <div className="tiny dim">{data.possibleAction}</div> : null}
      </div>
    );
  }

  if (status.error) {
    return (
      <div className="card">
        <div className="tiny dim">PROJECT.md</div>
        <div style={{ marginTop: 8 }}>
          <ErrorBox message={status.error} />
        </div>
      </div>
    );
  }

  const exists = data?.exists === true;

  return (
    <div className="card">
      <div className="tiny dim">PROJECT.md</div>
      <div className="mono" style={{ fontSize: 14, wordBreak: 'break-all', margin: '4px 0 8px' }}>
        {data?.documentPath ?? data?.relativePath ?? '…'}
      </div>

      <dl className="kv" style={{ margin: 0 }}>
        <dt>Document</dt>
        <dd>
          {exists ? 'Generated' : data?.exists === false ? 'Not generated yet' : 'Checking…'}
        </dd>
        <dt>Last written</dt>
        <dd>{exists && data?.modifiedAt ? formatDateTime(data.modifiedAt) : '—'}</dd>
        <dt>Size</dt>
        <dd>{exists && data?.sizeBytes != null ? `${data.sizeBytes.toLocaleString()} bytes` : '—'}</dd>
        {state ? (
          <>
            <dt>Sync state</dt>
            <dd>{describeSyncState(state)}</dd>
          </>
        ) : null}
        {monitor.state ? (
          <>
            <dt>Watching</dt>
            <dd>
              {monitor.state === 'SYNCHRONIZED'
                ? 'No pending change'
                : `${DOCUMENT_MONITOR_STATE_LABEL[monitor.state]}${monitor.detectedAt ? ` · ${relativeTime(monitor.detectedAt)}` : ''}`}
            </dd>
          </>
        ) : null}
      </dl>

      <MonitorBanner
        state={monitor.state}
        summary={monitor.summary}
        detectedAt={monitor.detectedAt}
        dismissed={!!monitor.anyNotification?.dismissedAt}
        mode={monitor.mode}
        hasChanges={hasRecordDifferences(monitor.notification, state)}
        onDismiss={async () => {
          try {
            await api.post(`/projects/${project.id}/project-document/monitor/dismiss`, {});
            monitor.reload();
            syncState.reload();
          } catch (err) {
            setActionError(err instanceof ApiError ? err.message : String(err));
          }
        }}
      />

      <div className="tiny dim" style={{ marginTop: 10 }}>
        Project Hub writes this file from the project record. You can edit it in your editor; Project Hub notices the
        change and reports it below. Use <strong>Check</strong>, <strong>Preview</strong> and{' '}
        <strong>Synchronize</strong> to apply your changes back. Nothing is applied until you press Synchronize.
      </div>

      {actionError ? (
        <div style={{ marginTop: 10 }}>
          <ErrorBox message={actionError} />
        </div>
      ) : null}

      <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {exists ? (
          <button className="btn sm" onClick={() => setViewing(true)}>
            Open PROJECT.md
          </button>
        ) : null}
        {exists ? (
          <button className="btn sm" onClick={() => setConfirming(true)} disabled={busy}>
            Regenerate
          </button>
        ) : (
          <button className="btn sm primary" onClick={generate} disabled={busy || !data?.available}>
            {busy ? 'Generating…' : 'Generate PROJECT.md'}
          </button>
        )}
      </div>

      {exists ? (
        <ProjectDocumentSyncPanel
          projectId={project.id}
          state={state}
          onDone={() => {
            syncState.reload();
            status.reload();
            monitor.reload();
          }}
        />
      ) : null}

      {viewing ? <DocumentViewer onClose={() => setViewing(false)} /> : null}

      {confirming ? (
        <Modal
          title="Regenerate PROJECT.md?"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn danger" onClick={regenerate} disabled={busy}>
                {busy ? 'Regenerating…' : 'Replace the file'}
              </button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>
            This rebuilds <span className="mono">PROJECT.md</span> from the project record and replaces the file that is
            on disk right now.
          </p>
          <p>
            <strong>Any manual edits you made to the file will be lost.</strong> Everything else in the project folder is
            left alone.
          </p>
          <p className="dim">
            To keep your changes, close this and copy anything you want to keep out of the file first. Project Hub will
            not try to merge the two versions.
          </p>
          {actionError ? <ErrorBox message={actionError} /> : null}
        </Modal>
      ) : null}
    </div>
  );
}

function describeSyncState(state: ProjectDocumentSyncState): string {
  const label = PROJECT_DOCUMENT_SYNC_STATE_LABEL[state.state] ?? 'Checking…';
  if (state.neverSynchronized && state.state !== 'conflict') return 'Not synchronized yet';
  if (state.conflict && state.conflictFields.length > 0) {
    return `${label}: ${state.conflictFields.join(', ')}`;
  }
  return label;
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

/**
 * True when there is something real to apply, rather than only a broken file or a
 * missing workspace folder - i.e. when pointing the user at Synchronize makes
 * sense.
 */
function hasRecordDifferences(
  notification: DocumentChangeNotification | null,
  syncState: ProjectDocumentSyncState | null | undefined
): boolean {
  if (notification) return notification.projectFieldCount + notification.recordChangeCount > 0;
  if (!syncState) return false;
  return syncState.modified || syncState.conflict;
}

/**
 * The Phase 7 banner.
 *
 * Deliberately a notice, not an action. It says what was detected, when, and how
 * it was detected, and it never applies anything. Dismiss hides the banner for
 * this unchanged version of the file; the next real edit brings it back, because
 * the dismissal is recorded against the content, not the project.
 */
function MonitorBanner({
  state,
  summary,
  detectedAt,
  dismissed,
  mode,
  hasChanges,
  onDismiss
}: {
  state: DocumentMonitorState | null;
  summary: string | null;
  detectedAt: string | null;
  dismissed: boolean;
  mode: 'WATCH' | 'POLL' | null;
  hasChanges: boolean;
  onDismiss: () => void;
}) {
  // Nothing detected yet, or nothing pending: stay quiet. A monitor that speaks up
  // when it has nothing to say gets ignored when it does.
  if (!state || state === 'SYNCHRONIZED' || dismissed) return null;
  const color = stateColor(state);

  return (
    <div
      style={{
        marginTop: 12,
        padding: '8px 10px',
        border: `1px solid ${color}`,
        borderRadius: 4
      }}
    >
      <div style={{ color, fontWeight: 600 }}>
        PROJECT.md changed {detectedAt ? relativeTime(detectedAt) : ''}
      </div>
      <div className="tiny dim" style={{ marginTop: 4 }}>
        {DOCUMENT_MONITOR_STATE_LABEL[state]}
        {summary ? ` · ${summary}` : ''}
        {' · '}
        {mode === 'POLL' ? 'detected by periodic check' : 'detected by watching the file'}
      </div>
      <div className="tiny dim" style={{ marginTop: 6 }}>
        {hasChanges
          ? 'Nothing has been applied. Use Check / Preview, then Synchronize to apply it.'
          : 'There is nothing to apply yet. Fix the file, or generate it again from the project record.'}
      </div>
      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * The Phase 6 panel: Check, Preview and Synchronize.
/**
 * Check is read-only and cheap. Preview builds the change set and shows it without
 * writing anything. Synchronize applies that exact set behind a confirmation.
 *
 * Phase 7: when both sides changed the *same* field, nothing is applied until the
 * user says which value to keep, per field. The three choices are Keep database,
 * Keep PROJECT.md, and entering a value by hand; they are applied together, in one
 * transaction, with the rest of the synchronization.
 */
function ProjectDocumentSyncPanel({
  projectId,
  state,
  onDone
}: {
  projectId: number;
  state: ProjectDocumentSyncState | null | undefined;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProjectDocumentSyncPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [lastResult, setLastResult] = useState<ProjectDocumentSyncResult | null>(null);
  const [choices, setChoices] = useState<Record<string, ProjectDocumentConflictResolution['choice']>>({});
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<ProjectDocumentSyncHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    const result = await run(() =>
      api.post<ProjectDocumentSyncPreview>(`/projects/${projectId}/project-document/sync/preview`, {})
    );
    if (result) {
      setPreview(result.data);
      // Start from the safest answer for every conflict: keep the record. Changing a
      // default is one click; applying the wrong default is not something to undo by
      // assumption.
      setChoices(
        Object.fromEntries(result.data.sync.conflicts.map((c) => [conflictKey(c), 'database' as const]))
      );
    }
  }

  async function syncNow() {
    const result = await run(() =>
      api.post<ProjectDocumentSyncResult>(`/projects/${projectId}/project-document/sync`, {})
    );
    if (result) {
      setLastResult(result.data);
      setPreview(null);
      setConfirming(false);
      onDone();
    }
  }

  async function resolveConflicts() {
    const conflicts = preview?.sync.conflicts ?? [];
    const resolutions: ProjectDocumentConflictResolution[] = conflicts.map((c) => {
      const choice = choices[conflictKey(c)] ?? 'database';
      return {
        field: c.field,
        scope: c.scope,
        entity: c.entity,
        key: c.key,
        choice,
        ...(choice === 'manual' ? { value: manualValues[conflictKey(c)] ?? '' } : {})
      };
    });
    const result = await run(() =>
      api.post<ProjectDocumentSyncResult>(`/projects/${projectId}/project-document/sync/resolve`, {
        resolutions
      })
    );
    if (result) {
      setLastResult(result.data);
      setPreview(result.data);
      onDone();
    }
  }

  const canSync = preview !== null && preview.applicable && !preview.unchanged;
  const hasChanges = (preview?.projectChanges.length ?? 0) + (preview?.childChanges.length ?? 0);
  const conflicts = preview?.sync.conflicts ?? [];
  const allDecided = conflicts.length > 0 && conflicts.every((c) => choices[conflictKey(c)]);

  /**
   * Synchronization history, loaded only when asked for. It is not part of every
   * page load because it costs a second query for something most people look at
   * when they are specifically wondering what happened to their file.
   */
  async function loadHistory() {
    if (history) {
      setHistory(null);
      return;
    }
    setBusy(true);
    setHistoryError(null);
    try {
      const result = await api.get<ProjectDocumentSyncStatus>(
        `/projects/${projectId}/project-document/sync/status`
      );
      setHistory(result.data.history);
    } catch (err) {
      setHistoryError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <div className="tiny dim">Apply this file to the project record</div>

      {error ? (
        <div style={{ marginTop: 8 }}>
          <ErrorBox message={error} />
        </div>
      ) : null}

      {lastResult ? (
        <div className="tiny dim" style={{ marginTop: 8 }}>
          {lastResult.skipped === 'unchanged'
            ? 'PROJECT.md is already synchronized.'
            : lastResult.applied
              ? lastResult.changed
                ? `PROJECT.md synchronized — ${lastResult.updatedFields.length} field(s)/record(s) updated.`
                : 'PROJECT.md synchronized — the document parsed cleanly and matched the project record.'
              : lastResult.errors.length > 0
                ? 'Nothing was applied.'
                : 'The decisions were applied.'}
        </div>
      ) : null}

      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={check} disabled={busy}>
          {busy ? 'Checking…' : 'Check / Preview'}
        </button>
        <button
          className="btn sm primary"
          onClick={() => setConfirming(true)}
          disabled={busy || !canSync || conflicts.length > 0}
          title={conflicts.length > 0 ? 'Decide the conflicting fields below first' : undefined}
        >
          Synchronize…
        </button>
      </div>

      {state?.neverSynchronized ? (
        <div className="tiny dim" style={{ marginTop: 6 }}>
          This project has not been synchronized before. The first sync records the document as the synchronized
          version.
        </div>
      ) : null}
      {state?.lastSyncedAt ? (
        <div className="tiny dim" style={{ marginTop: 4 }}>
          Last synchronized {formatDateTime(state.lastSyncedAt)}.
        </div>
      ) : null}
      {preview && !preview.sync.baseline.available ? (
        <div className="tiny dim" style={{ marginTop: 4 }}>
          No comparison baseline is recorded for this project yet, so differences are reported as conflicts rather than
          applied. The first synchronization that finds the two in agreement records the baseline.
        </div>
      ) : null}

      {preview ? <SyncPreview preview={preview} total={hasChanges} /> : null}

      {conflicts.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <div className="tiny" style={{ marginBottom: 6 }}>
            {conflicts.length} field(s) changed in both PROJECT.md and the project record. Choose which value to keep.
            Nothing is written until you apply.
          </div>
          {conflicts.map((c) => {
            const k = conflictKey(c);
            const choice = choices[k];
            return (
              <div key={k} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 8, marginBottom: 8 }}>
                <div className="tiny">
                  <span className="mono">{c.field}</span>
                  {c.scope === 'record' ? (
                    <span className="dim">
                      {' '}
                      · {c.entity} {c.label ?? c.key}
                    </span>
                  ) : null}
                </div>
                <ConflictValue label="Last agreed" value={c.baseline} />
                <ConflictValue label="Project record" value={c.databaseValue} />
                <ConflictValue label="PROJECT.md" value={c.markdownValue} />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {(['database', 'markdown', 'manual'] as const).map((option) => (
                    <button
                      key={option}
                      className={`btn sm${choice === option ? ' primary' : ''}`}
                      disabled={busy}
                      onClick={() => setChoices((prev) => ({ ...prev, [k]: option }))}
                    >
                      {option === 'database' ? 'Keep database' : option === 'markdown' ? 'Keep PROJECT.md' : 'Enter a value…'}
                    </button>
                  ))}
                </div>
                {choice === 'manual' ? (
                  <input
                    className="input"
                    style={{ marginTop: 6, width: '100%' }}
                    value={manualValues[k] ?? ''}
                    placeholder="The value to store"
                    onChange={(e) => setManualValues((prev) => ({ ...prev, [k]: e.target.value }))}
                  />
                ) : null}
              </div>
            );
          })}
          <button className="btn sm primary" onClick={resolveConflicts} disabled={busy || !allDecided}>
            {busy ? 'Applying…' : `Apply ${conflicts.length} decision(s)`}
          </button>
          <div className="tiny dim" style={{ marginTop: 6 }}>
            The file is not rewritten by this. When you keep the database value, PROJECT.md still contains your text —
            regenerate the document when you want it to match the record again.
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <button className="btn sm" onClick={loadHistory} disabled={busy}>
          {history ? 'Hide history' : 'Synchronization history'}
        </button>
        {historyError ? <ErrorBox message={historyError} /> : null}
        {history && history.length === 0 ? (
          <div className="tiny dim" style={{ marginTop: 6 }}>
            No synchronizations have been recorded for this project yet.
          </div>
        ) : null}
        {history && history.length > 0 ? (
          <ul className="tiny" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {history.map((entry, i) => (
              <li key={`${entry.at}-${i}`} style={{ marginTop: 4 }}>
                <span className="dim">{entry.at ? formatDateTime(entry.at) : '—'} · </span>
                {entry.direction === 'CONFLICT_RESOLUTION'
                  ? 'Resolved conflicts'
                  : entry.direction === 'DATABASE_TO_MARKDOWN'
                    ? 'Document regenerated'
                    : 'PROJECT.md applied'}
                {entry.applied.length > 0 ? ` — ${entry.applied.join(', ')}` : ''}
                {entry.conflicts.length > 0 ? (
                  <span className="dim"> (held back: {entry.conflicts.join(', ')})</span>
                ) : null}
                {entry.databaseKept.length > 0 ? (
                  <span className="dim"> (kept from the record: {entry.databaseKept.join(', ')})</span>
                ) : null}
                {entry.resolutions.length > 0 ? (
                  <span className="dim">
                    {' '}
                    ({entry.resolutions.map((r) => `${r.target} = ${r.choice}`).join(', ')})
                  </span>
                ) : null}
                {entry.actor ? <span className="dim"> · {entry.actor}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {confirming && preview ? (
        <Modal
          title="Synchronize PROJECT.md into the project?"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => syncNow()} disabled={busy}>
                {busy ? 'Synchronizing…' : 'Apply changes'}
              </button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>
            This writes the contents of <span className="mono">PROJECT.md</span> into the project record. Records that
            are not in the document are <strong>not</strong> deleted.
          </p>
          {preview.sync.databaseChanged.length > 0 ? (
            <p className="tiny dim">
              {preview.sync.databaseChanged.length} field(s) changed in the project record since the last
              synchronization and will be <strong>kept</strong>: {preview.sync.databaseChanged.join(', ')}. Regenerate
              the document if you want it to catch up.
            </p>
          ) : null}
          <SyncPreview preview={preview} total={hasChanges} />
          {preview.warnings.length > 0 ? (
            <p className="tiny dim">
              {preview.warnings.length} warning(s) will be recorded, including any database records that have no
              counterpart in the document.
            </p>
          ) : null}
          {error ? <ErrorBox message={error} /> : null}
        </Modal>
      ) : null}
    </div>
  );
}

/** Stable identity for one conflicting field, across the choice state and the API. */
function conflictKey(c: ProjectDocumentConflict): string {
  return c.scope === 'project' ? c.field : `${c.entity}:${c.key}.${c.field}`;
}

function ConflictValue({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="tiny" style={{ marginTop: 4 }}>
      <span className="dim">{label}: </span>
      {value === null || value === '' ? <span className="dim">(empty)</span> : value}
    </div>
  );
}
function SyncPreview({ preview, total }: { preview: ProjectDocumentSyncPreview; total: number }) {
  if (preview.errors.length > 0) {
    return (
      <div style={{ marginTop: 10 }}>
        {preview.errors.map((e, i) => (
          <ErrorBox key={i} message={e.message} />
        ))}
      </div>
    );
  }
  if (preview.unchanged) {
    return (
      <div className="tiny dim" style={{ marginTop: 8 }}>
        The document has not changed since the last synchronization. Nothing to apply.
      </div>
    );
  }
  if (total === 0) {
    return (
      <div className="tiny dim" style={{ marginTop: 8 }}>
        The document parses cleanly but nothing in it differs from the project record.
      </div>
    );
  }
  return (
    <div style={{ marginTop: 10 }}>
      <div className="tiny dim" style={{ marginBottom: 6 }}>
        {preview.projectChanges.length} field(s) and {preview.childChanges.length} record(s) would change.
      </div>
      {preview.projectChanges.length > 0 ? (
        <ul className="tiny" style={{ margin: '0 0 6px', paddingLeft: 18 }}>
          {preview.projectChanges.map((c, i) => (
            <li key={`f${i}`}>
              <span className="mono">{c.field}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {preview.childChanges.length > 0 ? (
        <ul className="tiny" style={{ margin: 0, paddingLeft: 18 }}>
          {preview.childChanges.map((c, i) => (
            <li key={`c${i}`}>
              {c.action === 'create' ? 'Create' : 'Update'} {c.entity} <span className="mono">{c.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {preview.unmatchedDatabaseRecords.length > 0 ? (
        <div className="tiny dim" style={{ marginTop: 8 }}>
          {preview.unmatchedDatabaseRecords.length} database record(s) are not in the document and will be left alone.
        </div>
      ) : null}
    </div>
  );
}

/**
 * Read-only view of the document as it is on disk.
 *
 * Deliberately read-only: there is no edit control and no save button, because the
 * file is edited in the user's own editor. Offering an editor here that silently
 * did nothing would be worse than not offering one.
 */
function DocumentViewer({ onClose }: { onClose: () => void }) {
  const { project } = useProject();
  const { data, loading, error } = useApi<ProjectDocumentContent>(
    `/projects/${project.id}/project-document/content`
  );

  return (
    <Modal
      title="PROJECT.md"
      onClose={onClose}
      wide
      footer={
        <>
          {data ? (
            <span className="tiny dim" style={{ marginRight: 'auto' }}>
              Read-only. Last written {formatDateTime(data.modifiedAt)}. Edit it in your editor, then use Synchronize.
            </span>
          ) : null}
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {loading ? <Loading label="Reading PROJECT.md" /> : null}
      {error ? <ErrorBox message={error} /> : null}
      {data ? <Markdown content={data.content} /> : null}
    </Modal>
  );
}
