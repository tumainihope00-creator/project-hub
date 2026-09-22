import { useState } from 'react';
import { api } from '../api/client';
import { useProject } from '../context/ProjectContext';
import { useApp } from '../context/AppContext';
import { Modal } from '../components/ui';
import { ResourceForm, type FormValues } from '../components/ResourceForm';
import { PROJECT_CONFIG } from '../projectConfig';
import { humanize } from '../resources';

const IDEA_FIELDS: { key: string; label: string }[] = [
  { key: 'description', label: 'Short description' },
  { key: 'problem', label: 'Problem it solves' },
  { key: 'motivation', label: 'Motivation' },
  { key: 'targetUsers', label: 'Target users' },
  { key: 'expectedValue', label: 'Expected value' },
  { key: 'assumptions', label: 'Assumptions' },
  { key: 'initialQuestions', label: 'Initial questions' },
  { key: 'inspiration', label: 'Inspiration' },
  { key: 'repositoryUrl', label: 'Repository' }
];

export function IdeaPage() {
  const { project, reload } = useProject();
  const { toast, reloadTags } = useApp();
  const [editing, setEditing] = useState(false);

  const save = async (values: FormValues, tags: string[]) => {
    await api.put(`/projects/${project.id}`, { ...values, tags });
    toast('Idea updated');
    setEditing(false);
    reload();
    reloadTags();
    window.dispatchEvent(new CustomEvent('data-changed'));
  };

  let original: Record<string, unknown> | null = null;
  if (project.originalIdea) {
    try {
      original = JSON.parse(project.originalIdea);
    } catch {
      original = null;
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Idea</h1>
          <div className="sub">The original concept, and how your understanding has evolved.</div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setEditing(true)}>
            Edit idea
          </button>
        </div>
      </div>

      <div className="grid c2">
        <div>
          <h2 className="section">Current understanding</h2>
          <div className="card">
            <dl className="kv">
              {IDEA_FIELDS.map(f => {
                const value = project[f.key as keyof typeof project];
                return (
                  <div key={f.key} style={{ display: 'contents' }}>
                    <dt>{f.label}</dt>
                    <dd style={{ whiteSpace: 'pre-wrap' }}>
                      {value ? String(value) : <span className="dim">—</span>}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        </div>

        <div>
          <h2 className="section">Original snapshot (immutable)</h2>
          <div className="card" style={{ borderStyle: 'dashed' }}>
            <div className="dim tiny" style={{ marginBottom: 8 }}>
              Captured when the project was created. This is never overwritten, so you can always see where you started.
            </div>
            {original ? (
              <>
                <dl className="kv">
                  {Object.entries(original)
                    .filter(([k, v]) => k !== 'capturedAt' && v)
                    .map(([k, v]) => (
                      <div key={k} style={{ display: 'contents' }}>
                        <dt>{humanize(k)}</dt>
                        <dd style={{ whiteSpace: 'pre-wrap' }}>{String(v)}</dd>
                      </div>
                    ))}
                </dl>
                {original.capturedAt ? (
                  <div className="dim tiny" style={{ marginTop: 10 }}>
                    Captured {new Date(String(original.capturedAt)).toLocaleString()}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="dim">No original snapshot was recorded for this project.</div>
            )}
          </div>
        </div>
      </div>

      {editing ? (
        <Modal title="Edit idea" onClose={() => setEditing(false)} wide>
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