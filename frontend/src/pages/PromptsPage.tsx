import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
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
  status: string;
  isReusable: boolean;
  content?: string;
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
  const [generating, setGenerating] = useState(false);
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

  const copyPrompt = async (row: PromptRow) => {
    const res = await api.post<PromptRow>(`/projects/${project.id}/prompts/${row.id}/copy`);
    toast(`Copied as ${res.data.code}`);
    after();
  };

  const archivePrompt = async (id: number) => {
    await api.post(`/projects/${project.id}/prompts/${id}/archive`);
    toast('Prompt archived — nothing was deleted');
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
          <button className="btn primary" onClick={() => setGenerating(true)}>
            Generate Prompt
          </button>
          <button className="btn" onClick={() => setCreating(true)}>
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
                {f.name === 'isReusable' ? (o === 'true' ? 'Yes' : 'No') : humanize(o)}
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

      {generating ? (
        <GeneratePromptModal projectId={project.id} slug={project.slug} onClose={() => setGenerating(false)} onSaved={() => { setGenerating(false); after(); }} />
      ) : null}

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
              <button className="btn" onClick={() => copyPrompt(viewing)}>
                Copy
              </button>
              {viewing.status !== 'ARCHIVED' ? (
                <ConfirmButton
                  className="btn"
                  label="Archive"
                  confirmLabel="Confirm archive"
                  question="Archive this prompt? It leaves the active lists but is never deleted."
                  onConfirm={() => archivePrompt(viewing.id)}
                />
              ) : (
                <span className="dim tiny" style={{ alignSelf: 'center' }}>
                  Archived — restore via Edit metadata
                </span>
              )}
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
            <dt>Status</dt>
            <dd>
              <Badge value={viewing.status} />
              {viewing.isReusable ? <span className="dim tiny"> · reusable template</span> : null}
            </dd>
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

// ---------------------------------------------------------------------------
// Generate prompt
// ---------------------------------------------------------------------------

/** The purposes the backend generator supports (mirrors PROMPT_PURPOSES). */
const GENERATOR_PURPOSES = [
  'Research',
  'Architecture',
  'Feature implementation',
  'Debugging',
  'Refactoring',
  'Testing',
  'Documentation',
  'Deployment'
];

const PURPOSE_STORAGE_KEY = 'phub.promptPurpose';

/** Where each missing context item can be recorded in this project. */
const FILL_TARGETS: Record<string, { tab: string; label: string }> = {
  description: { tab: 'idea', label: 'Idea / description' },
  problem: { tab: 'idea', label: 'Idea / problem statement' },
  requirements: { tab: 'requirements', label: 'Requirements' },
  features: { tab: 'features', label: 'Features' },
  tasks: { tab: 'tasks', label: 'Tasks' },
  issues: { tab: 'bugs', label: 'Bugs' },
  decisions: { tab: 'decisions', label: 'Decisions' },
  techStack: { tab: 'architecture', label: 'Architecture / tech stack' },
  milestones: { tab: 'milestones', label: 'Milestones' },
  deployments: { tab: 'deployments', label: 'Deployments' },
  notes: { tab: 'notes', label: 'Notes' },
  research: { tab: 'research', label: 'Research' }
};

interface ReadinessItem {
  key: string;
  label: string;
  required: boolean;
  present: boolean;
}

interface ReadinessReport {
  purpose: string;
  ready: boolean;
  items: ReadinessItem[];
  missingRequired: string[];
  missingRecommended: string[];
}

interface PromptDraft {
  title: string;
  category: string;
  purpose: string;
  content: string;
}

/**
 * Offline prompt generator: readiness checklist + editable draft assembled from
 * the project's own records. Nothing here calls an AI provider - "Proceed
 * anyway" just saves the draft as a normal prompt (status DRAFT).
 */
function GeneratePromptModal({
  projectId,
  slug,
  onClose,
  onSaved
}: {
  projectId: number;
  slug: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useApp();
  const [purpose, setPurpose] = useState(() => sessionStorage.getItem(PURPOSE_STORAGE_KEY) || 'Feature implementation');
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFill, setShowFill] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    sessionStorage.setItem(PURPOSE_STORAGE_KEY, purpose);
    setLoading(true);
    setError(null);
    setShowFill(false);
    api
      .post<{ readiness: ReadinessReport; draft: PromptDraft }, { failures?: { source: string }[] }>(
        `/projects/${projectId}/prompts/generate`,
        { purpose }
      )
      .then(res => {
        if (cancelled) return;
        setReadiness(res.data.readiness);
        setDraft(res.data.draft);
        setContent(res.data.draft.content);
        setFailures((res.meta?.failures ?? []).map(f => f.source));
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, purpose]);

  const proceed = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.post(`/projects/${projectId}/prompts`, {
        title: draft.title,
        purpose: draft.purpose,
        category: draft.category,
        text: content,
        status: 'DRAFT'
      });
      toast(readiness?.ready ? 'Prompt saved' : 'Draft saved despite missing information');
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const missingRequired = (readiness?.missingRequired ?? []).map(key => ({
    key,
    ...(FILL_TARGETS[key] ?? { tab: 'notes', label: key })
  }));

  return (
    <Modal
      title="Generate prompt from project context"
      onClose={onClose}
      wide
      footer={
        <>
          <button
            className="btn"
            onClick={() => setShowFill(v => !v)}
            disabled={!readiness || readiness.missingRequired.length === 0}
          >
            Fill missing
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn primary" onClick={proceed} disabled={saving || loading || !draft}>
            {saving ? 'Saving…' : readiness?.ready ? 'Save prompt' : 'Proceed anyway'}
          </button>
        </>
      }
    >
      <div className="field full">
        <label htmlFor="gen-purpose">Purpose</label>
        <select id="gen-purpose" value={purpose} onChange={e => setPurpose(e.target.value)}>
          {GENERATOR_PURPOSES.map(p => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="hint">
          The draft is assembled from this project's records; no AI service is called. Your last purpose is remembered for this session.
        </span>
      </div>

      {error ? <ErrorBox message={error} /> : null}
      {saveError ? <ErrorBox message={saveError} /> : null}
      {failures.length > 0 ? (
        <div style={{ color: 'var(--red)', marginTop: 8 }}>
          Some project sources could not be read ({failures.join(', ')}). The draft may be incomplete.
        </div>
      ) : null}

      {loading ? (
        <Loading />
      ) : readiness && draft ? (
        <>
          <div style={{ marginTop: 10, fontWeight: 600 }}>
            {readiness.ready ? (
              <span style={{ color: 'var(--green)' }}>Ready — every required item is recorded.</span>
            ) : (
              <span style={{ color: 'var(--red)' }}>
                Missing {readiness.missingRequired.length} required{' '}
                {readiness.missingRequired.length === 1 ? 'item' : 'items'}.
              </span>
            )}
          </div>
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {readiness.items.map(item => (
              <li key={item.key}>
                <span style={{ color: item.present ? 'var(--green)' : 'var(--red)' }}>{item.present ? '✓' : '✗'}</span>{' '}
                {item.label}
                {item.required ? <span className="dim tiny"> · required</span> : null}
              </li>
            ))}
          </ul>

          {showFill ? (
            <div className="card" style={{ padding: 12, marginTop: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Record the missing information here, then generate again:</div>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {missingRequired.map(m => (
                  <li key={m.key}>
                    <Link to={`/projects/${slug}/${m.tab}`}>{m.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <h4 style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--text-dim)', marginTop: 16 }}>
            Draft — {draft.title}
          </h4>
          <textarea
            rows={16}
            value={content}
            onChange={e => setContent(e.target.value)}
            style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          />
          <div className="dim tiny" style={{ marginTop: 6 }}>
            Sections marked “Not provided in Project Hub.” have no recorded data. Edit freely — saving stores this as prompt v1 (status DRAFT).
          </div>
        </>
      ) : null}
    </Modal>
  );
}