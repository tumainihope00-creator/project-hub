import { useState } from 'react';
import { api, ApiError, formatDateTime } from '../api/client';
import { useApi } from '../lib/useApi';
import { useProject } from '../context/ProjectContext';
import { Modal, Loading, ErrorBox } from '../components/ui';
import { Markdown } from '../lib/markdown';
import type { ProjectDocumentContent, ProjectDocumentStatus } from '../api/types';

/**
 * PROJECT.md: the human-readable document that lives in the project workspace.
 *
 * Three things this card is careful about:
 *
 * 1. It never claims the document is in sync. Phase 4 writes the document from
 *    the database; it does not read the file back. A "last written" time and an
 *    explicit one-way note are shown instead of a green "in sync" tick that
 *    would be a lie.
 * 2. Regenerating is the only destructive action, and it is behind an explicit
 *    confirmation that spells out what is lost. The card also has no automatic
 *    regeneration: a background job here would silently discard the user's edits
 *    to their own file.
 * 3. The document is rendered as React elements, never as HTML, so a PROJECT.md
 *    edited outside Project Hub cannot inject markup into this page.
 */
export function ProjectDocumentCard() {
  const { project } = useProject();
  const status = useApi<ProjectDocumentStatus>(`/projects/${project.id}/project-document`);

  const [viewing, setViewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const data = status.data;

  async function generate() {
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/projects/${project.id}/project-document`, {});
      status.reload();
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
      </dl>

      <div className="tiny dim" style={{ marginTop: 10 }}>
        Project Hub writes this file from the project record. It does not read it back, so edits you make here in your
        editor are not applied to Project Hub.
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

/**
 * Read-only view of the document as it is on disk.
 *
 * Deliberately read-only: there is no edit control and no save button, because
 * Phase 4 has no way to write a user's changes back to the project. Offering an
 * editor that silently does nothing would be worse than not offering one.
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
              Read-only. Last written {formatDateTime(data.modifiedAt)}. Changes here are not applied to Project Hub.
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
