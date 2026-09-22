import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useApi } from '../lib/useApi';
import { useProject } from '../context/ProjectContext';
import { useApp } from '../context/AppContext';
import { Badge, ConfirmButton, Modal, StageBadge } from '../components/ui';
import { ResourceForm, type FormValues } from '../components/ResourceForm';
import { PROJECT_CONFIG } from '../projectConfig';
import { humanize } from '../resources';
import type { ProjectRelationship } from '../api/types';

const REL_TYPES = ['RELATED', 'DEPENDS_ON', 'INSPIRED_BY', 'FORKED_FROM', 'REPLACES', 'PART_OF'];

export function ProjectSettings() {
  const { project, reload } = useProject();
  const { projects, toast, reloadProjects } = useApp();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [relType, setRelType] = useState('RELATED');
  const [relatedId, setRelatedId] = useState('');
  const [relNotes, setRelNotes] = useState('');

  const { data: rels, reload: reloadRels } = useApi<{ outgoing: ProjectRelationship[]; incoming: ProjectRelationship[] }>(
    `/projects/${project.id}/relationships`
  );

  const after = () => {
    reload();
    reloadProjects();
    window.dispatchEvent(new CustomEvent('data-changed'));
  };

  const save = async (values: FormValues, tags: string[]) => {
    await api.put(`/projects/${project.id}`, { ...values, tags });
    toast('Project updated');
    setEditing(false);
    after();
  };

  const addRel = async () => {
    if (!relatedId) return;
    await api.post(`/projects/${project.id}/relationships`, {
      relatedProjectId: Number(relatedId),
      type: relType,
      notes: relNotes || null
    });
    toast('Relationship added');
    setRelatedId('');
    setRelNotes('');
    reloadRels();
    after();
  };

  const removeRel = async (relId: number) => {
    await api.del(`/projects/${project.id}/relationships/${relId}`);
    toast('Relationship removed');
    reloadRels();
    after();
  };

  const toggleArchive = async () => {
    await api.post(`/projects/${project.id}/${project.isArchived ? 'activate' : 'archive'}`, {});
    toast(project.isArchived ? 'Reactivated' : 'Archived');
    after();
  };

  const hardDelete = async () => {
    await api.del(`/projects/${project.id}?hard=true`);
    toast('Project permanently deleted');
    reloadProjects();
    navigate('/projects');
  };

  const exportUrl = `/api/projects/${project.slug}/export?format=json`;
  const others = projects.filter(p => p.id !== project.id);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="sub">Project details, relationships, data export and lifecycle.</div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setEditing(true)}>
            Edit project
          </button>
        </div>
      </div>

      <h2 className="section">Basics</h2>
      <div className="card">
        <dl className="kv">
          <dt>Name</dt>
          <dd>{project.name}</dd>
          <dt>Slug</dt>
          <dd className="mono">{project.slug}</dd>
          <dt>Stage</dt>
          <dd>
            <StageBadge stage={project.stage} />
          </dd>
          <dt>Status</dt>
          <dd>{project.isArchived ? <Badge value="ARCHIVED" /> : <Badge value="ACTIVE" />}</dd>
          <dt>Created</dt>
          <dd>{new Date(project.createdAt).toLocaleString()}</dd>
          <dt>Last updated</dt>
          <dd>{new Date(project.updatedAt).toLocaleString()}</dd>
          <dt>Repository</dt>
          <dd>{project.repositoryUrl ? <a href={project.repositoryUrl} target="_blank" rel="noreferrer">{project.repositoryUrl}</a> : <span className="dim">—</span>}</dd>
          <dt>Tags</dt>
          <dd>
            {project.tags.length === 0 ? (
              <span className="dim">—</span>
            ) : (
              project.tags.map(t => (
                <span className="tag-chip tag" key={t.id} style={{ marginRight: 4 }}>
                  {t.name}
                </span>
              ))
            )}
          </dd>
        </dl>
      </div>

      <h2 className="section">Project relationships</h2>
      <div className="card">
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <select value={relatedId} onChange={e => setRelatedId(e.target.value)}>
            <option value="">Select project…</option>
            {others.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select value={relType} onChange={e => setRelType(e.target.value)}>
            {REL_TYPES.map(t => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </select>
          <input type="text" placeholder="Notes (optional)" value={relNotes} onChange={e => setRelNotes(e.target.value)} />
          <button className="btn" onClick={addRel} disabled={!relatedId}>
            Add relationship
          </button>
        </div>

        {rels && rels.outgoing.length + rels.incoming.length === 0 ? (
          <div className="dim">No relationships yet.</div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Direction</th>
                <th>Type</th>
                <th>Project</th>
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rels?.outgoing.map(r => (
                <tr key={`o${r.id}`}>
                  <td className="dim">outgoing</td>
                  <td>
                    <Badge value={r.type} />
                  </td>
                  <td>{r.toProject?.name}</td>
                  <td className="muted">{r.notes ?? '—'}</td>
                  <td className="actions-cell">
                    <ConfirmButton label="Remove" confirmLabel="Confirm" question="Remove relationship?" onConfirm={() => removeRel(r.id)} />
                  </td>
                </tr>
              ))}
              {rels?.incoming.map(r => (
                <tr key={`i${r.id}`}>
                  <td className="dim">incoming</td>
                  <td>
                    <Badge value={r.type} />
                  </td>
                  <td>{r.fromProject?.name}</td>
                  <td className="muted">{r.notes ?? '—'}</td>
                  <td className="actions-cell">
                    <span className="dim tiny">managed by source project</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2 className="section">Export</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Download a complete JSON snapshot of this project — including tasks, issues, research, prompts with versions, documents, deployments,
          activity history and more. Your data is never locked in.
        </p>
        <a className="btn" href={exportUrl} download>
          Download JSON export
        </a>
      </div>

      <h2 className="section">Danger zone</h2>
      <div className="card" style={{ borderColor: '#6e2a26' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontWeight: 600 }}>{project.isArchived ? 'Reactivate project' : 'Archive project'}</div>
            <div className="dim tiny">Archiving hides the project from active views but preserves all history. It does not change the stage.</div>
          </div>
          <button className="btn" onClick={toggleArchive}>
            {project.isArchived ? 'Reactivate' : 'Archive'}
          </button>
        </div>
        <hr style={{ border: 'none', borderTop: '1px solid var(--border-muted)', margin: '14px 0' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontWeight: 600, color: 'var(--red)' }}>Permanently delete</div>
            <div className="dim tiny">Deletes the project and every related record. This cannot be undone.</div>
          </div>
          <ConfirmButton className="btn danger" label="Delete permanently" confirmLabel="Confirm permanent delete" question="This erases everything. Are you sure?" onConfirm={hardDelete} />
        </div>
      </div>

      {editing ? (
        <Modal title="Edit project" onClose={() => setEditing(false)} wide>
          <ResourceForm
            config={PROJECT_CONFIG}
            projectId={project.id}
            initial={project as unknown as FormValues}
            tagSuggestions={[]}
            submitLabel="Save changes"
            onCancel={() => setEditing(false)}
            onSubmit={save}
          />
        </Modal>
      ) : null}
    </div>
  );
}