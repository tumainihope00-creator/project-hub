import { useMemo, useState } from 'react';
import { api, formatDate, formatDateTime, qs } from '../api/client';
import { useApi, useDebounced } from '../lib/useApi';
import { useProject } from '../context/ProjectContext';
import { useApp } from '../context/AppContext';
import { RESOURCES, humanize, type ResourceConfig } from '../resources';
import { Badge, ConfirmButton, EmptyState, ErrorBox, Loading, Modal } from '../components/ui';
import { ResourceForm, type FormValues } from '../components/ResourceForm';
import { renderCell } from './ResourcePage';
import type { ResourceRow } from '../api/types';

interface PromptVersion {
  id: number;
  version: number;
  text: string;
  response?: string | null;
  changes?: string | null;
  reason?: string | null;
  isFinal: boolean;
  createdAt: string;
}

interface PromptRow extends ResourceRow {
  code: string;
  title?: string | null;
  purpose?: string | null;
  category?: string | null;
  tool?: string | null;
  model?: string | null;
  resultNote?: string | null;
  result?: string;
  date?: string;
  versions?: PromptVersion[];
  finalVersionId?: number | null;
  tags?: string[];
}

const FULL = RESOURCES['prompts'];
const META: ResourceConfig = { ...FULL, fields: FULL.fields.filter(f => f.name !== 'text' && f.name !== 'response') };

export function PromptsPage() {
  const { project, reload: reloadProject } = useProject();
  const { tags: globalTags, toast, reloadTags } = useApp();

  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PromptRow | null>(null);
  const [viewing, setViewing] = useState<PromptRow | null>(null);
  const [addingVersion, setAddingVersion] = useState(false);

  const path = `/projects/${project.id}/prompts${qs({ q: debounced || undefined, ...filters, pageSize: 100 })}`;
  const { data, loading, error, reload } = useApi<PromptRow[]>(path);
  const rows = data ?? [];
  const tagSuggestions = useMemo(() => globalTags.map(t => t.name), [globalTags]);

  const after = () => {
    reload();
    reloadProject();
    reloadTags();
  };

  const openDetail = async (id: number) => {
    const res = await api.get<PromptRow>(`/projects/${project.id}/prompts/${id}`);
    setViewing(res.data);
  };

  const create = async (values: FormValues, tags: string[]) => {
    await api.post(`/projects/${project.id}/prompts`, { ...values, tags });
    toast('Prompt recorded');
    setCreating(false);
    after();
  };

  const update = async (values: FormValues, tags: string[]) => {
    if (!editing) return;
    await api.put(`/projects/${project.id}/prompts/${editing.id}`, { ...values, tags });
    toast('Prompt updated');
    setEditing(null);
    after();
  };

  const remove = async (id: number) => {
    await api.del(`/projects/${project.id}/prompts/${id}`);
    toast('Prompt deleted');
    setViewing(null);
    after();
  };

  const versions = viewing?.versions ?? [];
  const latest = versions.length ? versions[versions.length - 1] : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>AI Prompts</h1>
          <div className="sub">{rows.length} recorded prompts — including prompts that failed.</div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setCreating(true)}>
            + New Prompt
          </button>
        </div>
      </div>

      <div className="toolbar">
        <input type="text" placeholder="Search prompts…" value={search} onChange={e => setSearch(e.target.value)} style={{ minWidth: 240 }} />
        {(FULL.filters ?? []).map(f => (
          <select key={f.name} value={filters[f.name] ?? ''} onChange={e => setFilters(prev => ({ ...prev, [f.name]: e.target.value }))}>
            <option value="">All {f.label.toLowerCase()}</option>
            {(f.options ?? []).map(o => (
              <option key={o} value={o}>
                {humanize(o)}
              </option>
            ))}
          </select>
        ))}
      </div>

      {error ? <ErrorBox message={error} /> : null}

      <div className="table-wrap">
        {loading && rows.length === 0 ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState title="No prompts yet" hint="Record prompt engineering history — including dead ends." />
        ) : (
          <table className="data">
            <thead>
              <tr>
                {FULL.columns.map(c => (
                  <th key={c.key} style={{ width: c.width }}>
                    {c.label}
                  </th>
                ))}
                <th className="right">Ver</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(row.id)}>
                  {FULL.columns.map(c => (
                    <td key={c.key}>{renderCell(row as ResourceRow, c)}</td>
                  ))}
                  <td className="right mono">{row.versions?.length ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating ? (
        <Modal title="New Prompt" onClose={() => setCreating(false)} wide>
          <ResourceForm config={FULL} projectId={project.id} tagSuggestions={tagSuggestions} submitLabel="Create" onCancel={() => setCreating(false)} onSubmit={create} />
        </Modal>
      ) : null}

      {editing ? (
        <Modal title="Edit prompt metadata" onClose={() => setEditing(null)} wide>
          <div className="dim tiny" style={{ marginBottom: 10 }}>
            Prompt text lives in versions. Use “Add version” to record a revised prompt.
          </div>
          <ResourceForm config={META} projectId={project.id} initial={editing} tagSuggestions={tagSuggestions} submitLabel="Save" onCancel={() => setEditing(null)} onSubmit={update} />
        </Modal>
      ) : null}

      {viewing ? (
        <Modal
          title={`${viewing.code} ${viewing.title ?? ''}`}
          onClose={() => setViewing(null)}
          wide
          footer={
            <>
              <ConfirmButton className="btn danger" label="Delete" confirmLabel="Confirm delete" question="Delete this prompt and all its versions?" onConfirm={() => remove(viewing.id)} />
              <div className="spacer" />
              <button className="btn" onClick={() => setAddingVersion(true)}>
                + Add version
              </button>
              <button className="btn" onClick={() => setEditing(viewing)}>
                Edit metadata
              </button>
              <button className="btn" onClick={() => setViewing(null)}>
                Close
              </button>
            </>
          }
        >
          <dl className="kv">
            <dt>Category</dt>
            <dd>{viewing.category ? <Badge value={viewing.category.toUpperCase()} /> : '—'}</dd>
            <dt>Tool / model</dt>
            <dd>
              {viewing.tool ?? '—'} {viewing.model ? `· ${viewing.model}` : ''}
            </dd>
            <dt>Result</dt>
            <dd>{viewing.result ? <Badge value={viewing.result} /> : '—'}</dd>
            <dt>Date</dt>
            <dd>{formatDate(viewing.date)}</dd>
            <dt>Purpose</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{viewing.purpose ?? '—'}</dd>
            <dt>Result note</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{viewing.resultNote ?? '—'}</dd>
          </dl>

          {latest ? (
            <>
              <h4 style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--text-dim)', marginTop: 16 }}>Current prompt (v{latest.version})</h4>
              <pre className="content-block">{latest.text}</pre>
              {latest.response ? (
                <>
                  <h4 style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--text-dim)', marginTop: 12 }}>AI response</h4>
                  <pre className="content-block">{latest.response}</pre>
                </>
              ) : null}
            </>
          ) : null}

          <h4 style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--text-dim)', marginTop: 16 }}>Version history ({versions.length})</h4>
          <div className="timeline">
            {versions
              .slice()
              .reverse()
              .map(v => (
                <div className="timeline-item" key={v.id}>
                  <div className="tl-head">
                    <span className="tl-type">v{v.version}</span>
                    {v.isFinal ? <Badge value="SUCCESSFUL" /> : null}
                    <span className="tl-time">{formatDateTime(v.createdAt)}</span>
                  </div>
                  {v.changes ? <div className="tl-desc">{v.changes}</div> : null}
                  {v.reason ? <div className="dim tiny">reason: {v.reason}</div> : null}
                </div>
              ))}
          </div>
        </Modal>
      ) : null}

      {addingVersion && viewing ? (
        <Modal title={`Add version to ${viewing.code}`} onClose={() => setAddingVersion(false)} wide>
          <VersionForm
            onSubmit={async payload => {
              await api.post(`/projects/${project.id}/prompts/${viewing.id}/versions`, payload);
              toast('Version added');
              setAddingVersion(false);
              const res = await api.get<PromptRow>(`/projects/${project.id}/prompts/${viewing.id}`);
              setViewing(res.data);
              after();
            }}
            onCancel={() => setAddingVersion(false)}
          />
        </Modal>
      ) : null}
    </div>
  );
}

function VersionForm({ onSubmit, onCancel }: { onSubmit: (p: Record<string, string>) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState('');
  const [response, setResponse] = useState('');
  const [changes, setChanges] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) {
      setErr('Prompt text is required');
      return;
    }
    setBusy(true);
    try {
      await onSubmit({ text, response, changes, reason });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <div className="field full">
          <label>Prompt text *</label>
          <textarea rows={7} value={text} onChange={e => setText(e.target.value)} />
        </div>
        <div className="field full">
          <label>AI response</label>
          <textarea rows={5} value={response} onChange={e => setResponse(e.target.value)} />
        </div>
        <div className="field">
          <label>What changed</label>
          <input value={changes} onChange={e => setChanges(e.target.value)} />
        </div>
        <div className="field">
          <label>Reason</label>
          <input value={reason} onChange={e => setReason(e.target.value)} />
        </div>
      </div>
      {err ? <div style={{ color: 'var(--red)', marginTop: 10 }}>{err}</div> : null}
      <div className="modal-foot" style={{ border: 'none', paddingRight: 0 }}>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Add version'}
        </button>
      </div>
    </form>
  );
}