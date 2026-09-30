import { useState } from 'react';
import { api, ApiError, formatDateTime } from '../api/client';
import { useApi } from '../lib/useApi';
import { useProject } from '../context/ProjectContext';
import { Modal, Loading, ErrorBox, StageBadge } from './ui';
import { Markdown } from '../lib/markdown';
import { humanize } from '../resources';
import type {
  ChangeProjectStatusResponse,
  LifecycleStage,
  StatusConsistency,
  StatusConsistencyState,
  StatusDocumentContent
} from '../api/types';

/**
 * STATUS.md: the lifecycle control file, and the panel that changes the status.
 *
 * What this card is careful about:
 *
 * 1. It never implies the file decides anything. The database holds the status;
 *    STATUS.md is written from it. So the card's primary control is the status
 *    selector, and the file is shown as the representation of it, with the
 *    disagreement - if any - stated in words.
 * 2. It never resolves a mismatch by itself. There is no "fix" button that
 *    silently rewrites the database from the file, and no "sync" that picks a
 *    side. The user chooses: change the status in Project Hub, or regenerate the
 *    document from the database.
 * 3. Initialize and regenerate are separate, and regenerating asks first,
 *    because it discards manual edits to the user's own file.
 */

/** One line per state, in the user's terms rather than in code terms. */
const STATE_COPY: Record<StatusConsistencyState, { title: string; tone: string }> = {
  SYNCHRONIZED: { title: 'STATUS.md matches the project status', tone: 'state-ok' },
  STATUS_MISMATCH: { title: 'STATUS.md declares a different status', tone: 'state-warn' },
  DOCUMENT_MISSING: { title: 'STATUS.md is missing', tone: 'state-warn' },
  DOCUMENT_INVALID: { title: 'STATUS.md cannot be read as a status', tone: 'state-warn' },
  DOCUMENT_UNREADABLE: { title: 'STATUS.md cannot be read', tone: 'state-warn' },
  UNAVAILABLE: { title: 'STATUS.md is unavailable for this project', tone: 'state-dim' }
};

export function ProjectStatusCard() {
  const { project, reload } = useProject();
  const status = useApi<StatusConsistency>(`/projects/${project.id}/status`);

  const [selected, setSelected] = useState<string>(project.stage);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<ChangeProjectStatusResponse['warning'] | null>(null);

  const data = status.data;

  // The option list is the one the backend sent, so this control cannot offer a
  // status the enum does not have. The local copy in resources.ts is only used
  // until that first response lands.
  const options: LifecycleStage[] = data?.validStatuses?.length ? data.validStatuses : (data ? [] : []);

  async function run(action: () => Promise<ChangeProjectStatusResponse | void>) {
    setBusy(true);
    setActionError(null);
    try {
      const result = await action();
      status.reload();
      reload();
      if (result && typeof result === 'object' && 'warning' in result && result.warning) {
        setOutcome(result.warning);
      }
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function changeStatus() {
    const next = selected as LifecycleStage;
    if (!next || next === data?.databaseStatus) return;
    return run(async () => {
      const res = await api.put<{ statusChange: ChangeProjectStatusResponse }>(`/projects/${project.id}/status`, {
        stage: next
      });
      return res.data.statusChange;
    });
  }

  function initialize() {
    return run(async () => {
      await api.post(`/projects/${project.id}/status-document`, {});
    });
  }

  function regenerate() {
    return run(async () => {
      await api.post(`/projects/${project.id}/status-document/regenerate`, { confirm: true });
      setConfirming(false);
    });
  }

  if (status.error) {
    return (
      <div className="card">
        <div className="tiny dim">STATUS.md</div>
        <div style={{ marginTop: 8 }}>
          <ErrorBox message={status.error} />
        </div>
      </div>
    );
  }

  const unavailable = data?.state === 'UNAVAILABLE';
  const documentMissing = data?.state === 'DOCUMENT_MISSING';
  const copy = data ? STATE_COPY[data.state] : null;

  return (
    <div className="card">
      <div className="tiny dim">STATUS.md</div>

      <dl className="kv" style={{ margin: '8px 0 0' }}>
        <dt>Project status</dt>
        <dd>
          <StageBadge stage={data?.databaseStatus ?? project.stage} />
        </dd>
        <dt>STATUS.md</dt>
        <dd>
          {status.loading ? 'Checking…' : copy ? <span className={copy.tone}>{copy.title}</span> : '—'}
        </dd>
        {data && data.state !== 'SYNCHRONIZED' && !unavailable ? (
          <>
            <dt>Declares</dt>
            <dd>{data.documentStatus ? humanize(data.documentStatus) : data.rawDocumentStatus || 'nothing'}</dd>
          </>
        ) : null}
        <dt>Last written</dt>
        <dd>{data?.documentModifiedAt ? formatDateTime(data.documentModifiedAt) : '—'}</dd>
      </dl>

      {data?.message && data.state !== 'SYNCHRONIZED' ? (
        <div className="tiny dim" style={{ marginTop: 8 }}>
          {data.message}
        </div>
      ) : null}
      {data?.possibleAction && data.state !== 'SYNCHRONIZED' ? (
        <div className="tiny dim" style={{ marginTop: 4 }}>
          {data.possibleAction}
        </div>
      ) : null}

      {outcome ? (
        <div className="tiny" style={{ marginTop: 10, color: 'var(--warn, #c98a00)' }}>
          {outcome.message}
          {outcome.possibleAction ? ` ${outcome.possibleAction}` : ''}
        </div>
      ) : null}
      {actionError ? (
        <div style={{ marginTop: 10 }}>
          <ErrorBox message={actionError} />
        </div>
      ) : null}

      <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={selected} onChange={e => setSelected(e.target.value)} disabled={busy || unavailable}>
          {options.map(s => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </select>
        <button
          className="btn sm primary"
          onClick={changeStatus}
          disabled={busy || unavailable || !selected || selected === data?.databaseStatus}
          title="Change the status in Project Hub. This is what STATUS.md is updated from."
        >
          {busy ? 'Saving…' : 'Set status'}
        </button>
      </div>

      <div className="tiny dim" style={{ marginTop: 10 }}>
        The project status lives in Project Hub. Creating this folder, writing PROJECT.md or STATUS.md, and adding source
        files or a Git repository do not change it - it changes when you change it here.
      </div>
      <div className="tiny dim" style={{ marginTop: 4 }}>
        Editing STATUS.md in your editor does not change the project. Project Hub reports the difference and leaves the
        choice to you.
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={() => setViewing(true)} disabled={documentMissing || unavailable}>
          Open STATUS.md
        </button>
        {documentMissing ? (
          <button className="btn sm primary" onClick={initialize} disabled={busy}>
            {busy ? 'Creating…' : 'Initialize STATUS.md'}
          </button>
        ) : (
          <button className="btn sm" onClick={() => setConfirming(true)} disabled={busy || unavailable}>
            Regenerate from status
          </button>
        )}
      </div>

      {viewing ? <StatusViewer onClose={() => setViewing(false)} /> : null}

      {confirming ? (
        <Modal
          title="Regenerate STATUS.md?"
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
            This rebuilds <span className="mono">STATUS.md</span> from the project status in Project Hub (
            <strong>{humanize(data?.databaseStatus ?? project.stage)}</strong>) and replaces the file on disk.
          </p>
          <p>
            <strong>Any manual edits you made to the file will be lost.</strong> Only STATUS.md is replaced - PROJECT.md
            and everything else in the project folder are left alone.
          </p>
          <p className="dim">
            The project status itself does not change. If STATUS.md is right and Project Hub is wrong, close this and
            change the status with the selector above instead.
          </p>
          {actionError ? <ErrorBox message={actionError} /> : null}
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * Read-only view of STATUS.md as it is on disk.
 *
 * No editor on purpose: this phase cannot write a change made here back to the
 * project, so an editable box would be a control that silently does nothing.
 */
function StatusViewer({ onClose }: { onClose: () => void }) {
  const { project } = useProject();
  const { data, loading, error } = useApi<StatusDocumentContent>(`/projects/${project.id}/status-document/content`);

  return (
    <Modal
      title="STATUS.md"
      onClose={onClose}
      wide
      footer={
        <>
          {data ? (
            <span className="tiny dim" style={{ marginRight: 'auto' }}>
              Read-only. Last written {formatDateTime(data.modifiedAt)}. Edits here are not applied to Project Hub.
            </span>
          ) : null}
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {loading ? <Loading label="Reading STATUS.md" /> : null}
      {error ? <ErrorBox message={error} /> : null}
      {data ? <Markdown content={data.content} /> : null}
    </Modal>
  );
}
