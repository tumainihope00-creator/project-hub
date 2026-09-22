import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import { RESOURCES } from '../resources';
import { Modal } from './ui';
import { ResourceForm } from './ResourceForm';

const QUICK_TYPES: { key: string; title: string; desc: string; config?: string }[] = [
  { key: 'project', title: 'Project', desc: 'Start a new project from an idea' },
  { key: 'tasks', title: 'Task', desc: 'Record work to be done', config: 'tasks' },
  { key: 'issues', title: 'Bug / Issue', desc: 'Log a defect or problem', config: 'issues' },
  { key: 'research', title: 'Research', desc: 'Capture findings from research', config: 'research' },
  { key: 'prompts', title: 'AI Prompt', desc: 'Save a prompt and its result', config: 'prompts' },
  { key: 'decisions', title: 'Decision (ADR)', desc: 'Record an architecture decision', config: 'decisions' },
  { key: 'notes', title: 'Note', desc: 'Jot down anything', config: 'notes' },
  { key: 'development-sessions', title: 'Dev Session', desc: 'Log a development session', config: 'development-sessions' },
  { key: 'ai-sessions', title: 'AI Session', desc: 'Log an AI-assisted session', config: 'ai-sessions' }
];

export function QuickAdd({ onCreated }: { onCreated: () => void }) {
  const { projects, toast } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('open-quickadd', handler);
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === 'q' &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)
      ) {
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('open-quickadd', handler);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const close = () => {
    setOpen(false);
    setType(null);
    setProjectId(null);
  };

  const activeProjects = projects.filter(p => !p.isArchived);
  const config = type && type !== 'project' ? RESOURCES[type] : null;

  return (
    <>
      {open ? (
        <Modal title={type ? `Quick add: ${config?.singular ?? 'Project'}` : 'Quick Add'} onClose={close} wide={!!config}>
          {!type ? (
            <div className="qa-grid">
              {QUICK_TYPES.map(t => (
                <button
                  key={t.key}
                  className="qa-item"
                  onClick={() => {
                    if (t.key === 'project') {
                      close();
                      navigate('/projects?new=1');
                    } else {
                      setType(t.key);
                    }
                  }}
                >
                  <span className="t">{t.title}</span>
                  <span className="d">{t.desc}</span>
                </button>
              ))}
            </div>
          ) : !projectId ? (
            <div>
              <p className="muted">Which project?</p>
              {activeProjects.length === 0 ? (
                <p className="dim">
                  No active projects.{' '}
                  <a href="/projects?new=1" onClick={close}>
                    Create one first
                  </a>
                  .
                </p>
              ) : (
                <div className="qa-grid">
                  {activeProjects.map(p => (
                    <button key={p.id} className="qa-item" onClick={() => setProjectId(p.id)}>
                      <span className="t">{p.name}</span>
                      <span className="d">{p.stage}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : config ? (
            <ResourceForm
              config={config}
              projectId={projectId}
              tagSuggestions={[]}
              submitLabel="Create"
              onCancel={close}
              onSubmit={async (values, tags) => {
                await api.post(`/projects/${projectId}/${config.path}`, { ...values, tags });
                toast(`${config.singular} created`);
                close();
                onCreated();
                window.dispatchEvent(new CustomEvent('data-changed'));
              }}
            />
          ) : null}
        </Modal>
      ) : null}
    </>
  );
}