import { useMemo, useState } from 'react';
import { api, formatDate, formatDateTime, qs } from '../api/client';
import { useApi, useDebounced } from '../lib/useApi';
import { useProject } from '../context/ProjectContext';
import { useApp } from '../context/AppContext';
import { RESOURCES, humanize } from '../resources';
import { Badge, ConfirmButton, EmptyState, ErrorBox, Loading, Modal } from '../components/ui';
import { ResourceForm, type FormValues } from '../components/ResourceForm';
import { renderCell } from './ResourcePage';
import type { ResourceRow } from '../api/types';

interface DocVersion {
  id: number;
  version: number;
  title: string;
  content: string;
  reason?: string | null;
  createdAt: string;
}

interface DocRow extends ResourceRow {
  title: string;
  type: string;
  currentVersion: number;
  updatedAt: string;
  versions?: DocVersion[];
  tags?: string[];
}

const FULL = RESOURCES['documents'];

export function DocumentsPage() {
  const { project, reload: reloadProject } = useProject();
  const { tags: globalTags, toast, reloadTags } = useApp();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [filterType, setFilterType] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<{ row: DocRow; content: string } | null>(null);
  const [viewing, setViewing] = useState<DocRow | null>(null);

  const path = `/projects/${project.id}/documents${qs({ q: debounced || undefined, type: filterType || undefined, pageSize: 100 })}`;
  const { data, loading, error, reload } = useApi<DocRow[]>(path);
  const rows = data ?? [];
  const tagSuggestions = useMemo(() => globalTags.map(t => t.name), [globalTags]);

  const after = () => {
    reload();
    reloadProject();
    reloadTags();
  };

  const openDetail = async (id: number) => {
    const [res, vres] = await Promise.all([
      api.get<DocRow>(`/projects/${project.id}/documents/${id}`),
      api.get<DocVersion[]>(`/projects/${project.id}/documents/${id}/versions`)
    ]);
    setViewing({ ...res.data, versions: vres.data });
  };

  const create = async (values: FormValues, tags: string[]) => {
    await api.post(`/projects/${project.id}/documents`, { ...values, tags });
    toast('Document created');
    setCreating(false);
    after();
  };

  const startEdit = async (row: DocRow) => {
    const res = await api.get<DocRow>(`/projects/${project.id}/documents/${row.id}`);
    const latest = res.data.versions?.[0];
    setViewing(null);
    setEditing({ row: res.data, content: latest?.content ?? '' });
  };

  const saveEdit = async (values: FormValues, tags: string[]) => {
    if (!editing) return;
    const payload = { ...values };
    if (payload.content === editing.content) delete (payload as Record<string, unknown>).content;
    await api.put(`/projects/${project.id}/documents/${editing.row.id}`, { ...payload, tags });
    toast('Document updated');
    setEditing(null);
    after();
  };

  const remove = async (id: number) => {
    await api.del(`/projects/${project.id}/documents/${id}`);
    toast('Document deleted');
    setViewing(null);
    after();
  };

  const versions = viewing?.versions ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Documentation</h1>
          <div className="sub">{rows.length} documents — each change is kept as a version.</div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setCreating(true)}>
            + New Document
          </button>
        </div>
      </div>

      <div className="toolbar">
        <input type="text" placeholder="Search documents…" value={search} onChange={e => setSearch(e.target.value)} style={{ minWidth: 240 }} />
        <select value={filterType} onChange={e => setFilterType(e.target.value)}>
          <option value="">All types</option>
          {(FULL.filters?.[0]?.options ?? []).map(o => (
            <option key={o} value={o}>
              {humanize(o)}
            </option>
          ))}
        </select>
      </div>

      {error ? <ErrorBox message={error} /> : null}

      <div className="table-wrap">
        {loading && rows.length === 0 ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState title="No documents yet" hint="Write READMEs, specs, guides — and keep every revision." />
        ) : (
          <table className="data">
            <thead>
              <tr>
                {FULL.columns.map(c => (
                  <th key={c.key} style={{ width: c.width }}>
                    {c.label}
                  </th>
                ))}
                <th className="right">Tags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(row.id)}>
                  {FULL.columns.map(c => (
                    <td key={c.key}>{renderCell(row as ResourceRow, c)}</td>
                  ))}
                  <td className="right">
                    {(row.tags ?? []).map(t => (
                      <span className="tag-chip tag" key={t} style={{ marginLeft: 4 }}>
                        {t}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating ? (
        <Modal title="New Document" onClose={() => setCreating(false)} wide>
          <ResourceForm config={FULL} projectId={project.id} tagSuggestions={tagSuggestions} submitLabel="Create" onCancel={() => setCreating(false)} onSubmit={create} />
        </Modal>
      ) : null}

      {editing ? (
        <Modal title={`Edit ${editing.row.title}`} onClose={() => setEditing(null)} wide>
          <div className="dim tiny" style={{ marginBottom: 10 }}>
            Saving with changed content creates version v{editing.row.currentVersion + 1}. Leaving content untouched only updates metadata.
          </div>
          <ResourceForm
            config={FULL}
            projectId={project.id}
            initial={{ ...editing.row, content: editing.content, reason: '' } as unknown as FormValues}
            tagSuggestions={tagSuggestions}
            submitLabel="Save"
            onCancel={() => setEditing(null)}
            onSubmit={saveEdit}
          />
        </Modal>
      ) : null}

      {viewing ? (
        <Modal
          title={viewing.title}
          onClose={() => setViewing(null)}
          wide
          footer={
            <>
              <ConfirmButton className="btn danger" label="Delete" confirmLabel="Confirm delete" question="Delete this document and all versions?" onConfirm={() => remove(viewing.id)} />
              <div className="spacer" />
              <button className="btn" onClick={() => startEdit(viewing)}>
                Edit / new version
              </button>
              <button className="btn" onClick={() => setViewing(null)}>
                Close
              </button>
            </>
          }
        >
          <dl className="kv">
            <dt>Type</dt>
            <dd>
              <Badge value={viewing.type} />
            </dd>
            <dt>Current version</dt>
            <dd className="mono">v{viewing.currentVersion}</dd>
            <dt>Last updated</dt>
            <dd>{formatDateTime(viewing.updatedAt)}</dd>
          </dl>

          {versions[0] ? (
            <>
              <h4 style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--text-dim)', marginTop: 16 }}>
                Latest content (v{versions[0].version})
              </h4>
              <pre className="content-block">{versions[0].content || '(empty)'}</pre>
            </>
          ) : null}

          <h4 style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--text-dim)', marginTop: 16 }}>Version history ({versions.length})</h4>
          <div className="timeline">
            {versions.map(v => (
              <div className="timeline-item" key={v.id}>
                <div className="tl-head">
                  <span className="tl-type">v{v.version}</span>
                  <span className="tl-time">{formatDate(v.createdAt)}</span>
                </div>
                {v.reason ? <div className="tl-desc">{v.reason}</div> : null}
              </div>
            ))}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}