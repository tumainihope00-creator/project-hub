import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs, relativeTime } from '../api/client';
import { useApi } from '../lib/useApi';
import { useApp } from '../context/AppContext';
import { ConfirmButton, EmptyState, Loading, Modal, StageBadge } from '../components/ui';
import { ResourceForm, type FormValues } from '../components/ResourceForm';
import { DocumentImportWizard } from '../components/DocumentImportWizard';
import { STAGES, humanize } from '../resources';
import { PROJECT_CONFIG } from '../projectConfig';
import type { FullProject, ProjectSummary } from '../api/types';

export function Portfolio() {
  const [params, setParams] = useSearchParams();
  const { tags: globalTags, toast, reloadTags, reloadProjects } = useApp();
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [archived, setArchived] = useState<'all' | 'active' | 'only'>('all');
  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState<'manual' | 'import' | null>(null);
  const [editing, setEditing] = useState<FullProject | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const closeNew = () => {
    setCreating(false);
    setMode(null);
  };

  const path = `/projects${qs({ q: q || undefined, stage: stage || undefined, archived })}`;
  const { data, loading, reload } = useApi<ProjectSummary[]>(path);
  const projects = data ?? [];

  useEffect(() => {
    if (params.get('new') === '1') {
      setCreating(true);
      params.delete('new');
      setParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const tagSuggestions = useMemo(() => globalTags.map(t => t.name), [globalTags]);

  const afterWrite = () => {
    reload();
    reloadProjects();
    reloadTags();
    window.dispatchEvent(new CustomEvent('data-changed'));
  };

  const create = async (values: FormValues, tags: string[]) => {
    await api.post('/projects', { ...values, tags });
    toast('Project created');
    closeNew();
    afterWrite();
  };

  const update = async (id: number, values: FormValues, tags: string[]) => {
    await api.put(`/projects/${id}`, { ...values, tags });
    toast('Project updated');
    setEditing(null);
    afterWrite();
  };

  const loadFull = async (slug: string) => {
    const res = await api.get<FullProject>(`/projects/${slug}`);
    setEditing(res.data);
  };

  const archive = async (p: ProjectSummary) => {
    if (p.isArchived) {
      await api.post(`/projects/${p.id}/activate`, {});
      toast('Project reactivated');
    } else {
      await api.post(`/projects/${p.id}/archive`, {});
      toast('Project archived');
    }
    afterWrite();
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <div className="sub">
            {projects.filter(p => !p.isArchived).length} active · {projects.filter(p => p.isArchived).length} archived
          </div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setCreating(true)}>
            + New Project
          </button>
        </div>
      </div>

      <div className="toolbar">
        <input type="text" placeholder="Filter by name or description…" value={q} onChange={e => setQ(e.target.value)} style={{ minWidth: 260 }} />
        <select value={stage} onChange={e => setStage(e.target.value)}>
          <option value="">All stages</option>
          {STAGES.map(s => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </select>
        <select value={archived} onChange={e => setArchived(e.target.value as typeof archived)}>
          <option value="all">Active + archived</option>
          <option value="active">Active only</option>
          <option value="only">Archived only</option>
        </select>
      </div>

      {loading && projects.length === 0 ? (
        <Loading />
      ) : projects.length === 0 ? (
        <EmptyState title="No projects found" hint="Create your first project to get started." />
      ) : (
        <div className="grid c3">
          {projects.map(p => (
            <div className={'card project-card' + (p.isArchived ? ' archived' : '')} key={p.id}>
              <div className="pc-head">
                <Link to={`/projects/${p.slug}`} className="pc-name">
                  {p.name}
                </Link>
                <span style={{ marginLeft: 'auto' }}>
                  <StageBadge stage={p.stage} />
                </span>
              </div>
              <div className="pc-idea">{p.description || <span className="dim">No description</span>}</div>
              <div className="progress">
                <div style={{ width: `${p.stats.progress}%` }} />
              </div>
              <div className="pc-stats">
                <span>{p.stats.progress}%</span>
                <span>{p.stats.tasksCompleted}/{p.stats.tasksTotal} tasks</span>
                {p.stats.issuesOpen > 0 ? <span style={{ color: 'var(--red)' }}>{p.stats.issuesOpen} issues</span> : null}
                {p.stats.prompts > 0 ? <span>{p.stats.prompts} prompts</span> : null}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {p.tags.slice(0, 4).map(t => (
                  <span className="tag-chip tag" key={t.id}>
                    {t.name}
                  </span>
                ))}
                <span className="dim tiny" style={{ marginLeft: 'auto' }}>
                  {relativeTime(p.lastActivityAt)}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, borderTop: '1px solid var(--border-muted)', paddingTop: 8 }}>
                <Link className="btn sm" to={`/projects/${p.slug}`}>
                  Open
                </Link>
                <button className="btn sm" onClick={() => loadFull(p.slug)}>
                  Edit
                </button>
                <ConfirmButton
                  className="btn sm"
                  label={p.isArchived ? 'Reactivate' : 'Archive'}
                  confirmLabel={p.isArchived ? 'Confirm reactivate' : 'Confirm archive'}
                  question={p.isArchived ? 'Bring this project back to active?' : 'Archive this project? History is preserved.'}
                  onConfirm={() => archive(p)}
                />
                <button
                  className="btn sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => setExpanded(expanded === p.id ? null : p.id)}
                >
                  {expanded === p.id ? 'Less' : 'Idea'}
                </button>
              </div>
              {expanded === p.id ? <IdeaSnapshot slug={p.slug} /> : null}
            </div>
          ))}
        </div>
      )}

      {creating ? (
        <Modal title="New Project" onClose={closeNew} wide>
          <div className="grid c2" style={{ gap: 12 }}>
            <div className="card grid" style={{ gap: 8 }}>
              <strong>Create Manually</strong>
              <div className="tiny dim">
                Type the project details yourself into Project Hub's own fields. Nothing is read from a file.
              </div>
              <div>
                <button className="btn primary" onClick={() => setMode('manual')}>
                  Create Manually
                </button>
              </div>
            </div>
            <div className="card grid" style={{ gap: 8 }}>
              <strong>Import From Document</strong>
              <div className="tiny dim">
                Read a .txt, .md, .json, .docx or .pdf document, review everything it found, then create one new
                project. No existing project is ever modified.
              </div>
              <div>
                <button className="btn primary" onClick={() => setMode('import')}>
                  Import From Document
                </button>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}

      {mode === 'manual' ? (
        <Modal title="New Project" onClose={closeNew} wide>
          <ResourceForm
            config={PROJECT_CONFIG}
            projectId={0}
            initial={{ stage: 'IDEA' }}
            tagSuggestions={tagSuggestions}
            submitLabel="Create project"
            onCancel={closeNew}
            onSubmit={create}
          />
        </Modal>
      ) : null}

      {mode === 'import' ? (
        <DocumentImportWizard
          onClose={closeNew}
          onCreated={result => {
            toast(`Project "${result.slug}" created from document`);
            closeNew();
            afterWrite();
          }}
        />
      ) : null}

      {editing ? (
        <Modal title={`Edit ${editing.name}`} onClose={() => setEditing(null)} wide>
          <ResourceForm
            config={PROJECT_CONFIG}
            projectId={0}
            initial={editing as unknown as FormValues}
            tagSuggestions={tagSuggestions}
            submitLabel="Save changes"
            onCancel={() => setEditing(null)}
            onSubmit={(values, tags) => update(editing.id, values, tags)}
          />
          <div className="dim tiny" style={{ marginTop: 8 }}>
            Original idea captured at creation is preserved separately and never overwritten.
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function IdeaSnapshot({ slug }: { slug: string }) {
  const { data, loading } = useApi<FullProject>(`/projects/${slug}`);
  if (loading) return <Loading />;
  if (!data) return null;
  let original: Record<string, unknown> | null = null;
  if (data.originalIdea) {
    try {
      original = JSON.parse(data.originalIdea);
    } catch {
      original = null;
    }
  }
  return (
    <div style={{ borderTop: '1px solid var(--border-muted)', paddingTop: 8 }}>
      <div className="dim tiny" style={{ marginBottom: 4 }}>
        Original idea snapshot
      </div>
      {original ? (
        <dl className="kv">
          {Object.entries(original)
            .filter(([k, v]) => k !== 'capturedAt' && v)
            .map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{humanize(k)}</dt>
                <dd>{String(v)}</dd>
              </div>
            ))}
        </dl>
      ) : (
        <div className="dim tiny">No snapshot recorded.</div>
      )}
    </div>
  );
}