import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useApi } from '../lib/useApi';
import { ProjectContext } from '../context/ProjectContext';
import { useApp } from '../context/AppContext';
import { Badge, ConfirmButton, Loading, ProgressBar } from '../components/ui';
import { STAGES, humanize } from '../resources';
import { statusColor } from '../lib/status';
import type { FullProject } from '../api/types';

const TABS: { to: string; label: string; end?: boolean }[] = [
  { to: '', label: 'Overview', end: true },
  { to: 'idea', label: 'Idea' },
  { to: 'research', label: 'Research' },
  { to: 'requirements', label: 'Requirements' },
  { to: 'features', label: 'Features' },
  { to: 'tasks', label: 'Tasks' },
  { to: 'milestones', label: 'Milestones' },
  { to: 'architecture', label: 'Architecture' },
  { to: 'decisions', label: 'Decisions' },
  { to: 'development', label: 'Development' },
  { to: 'prompts', label: 'AI Prompts' },
  { to: 'prompt-generator', label: 'Prompt Generator' },
  { to: 'bugs', label: 'Bugs' },
  { to: 'testing', label: 'Testing' },
  { to: 'deployments', label: 'Deployments' },
  { to: 'production', label: 'Production' },
  { to: 'documentation', label: 'Documentation' },
  { to: 'notes', label: 'Notes' },
  { to: 'activity', label: 'Activity' },
  { to: 'settings', label: 'Settings' }
];

export function ProjectLayout() {
  const { slug } = useParams();
  const { toast } = useApp();
  const { data: project, loading, error, reload } = useApi<FullProject>(slug ? `/projects/${slug}` : null);
  const [stageBusy, setStageBusy] = useState(false);

  useEffect(() => {
    const handler = () => reload();
    window.addEventListener('data-changed', handler);
    return () => window.removeEventListener('data-changed', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  if (loading && !project) return <div className="page"><Loading /></div>;
  if (error)
    return (
      <div className="page">
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Unable to load this project.</div>
          <div className="dim">{error}</div>
          <button className="btn" style={{ marginTop: 12 }} onClick={() => reload()}>
            Retry
          </button>
        </div>
      </div>
    );
  if (!project)
    return (
      <div className="page">
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Project not found.</div>
          <Link className="btn" to="/projects">
            ← Back to Projects
          </Link>
        </div>
      </div>
    );

  const changeStage = async (stage: string) => {
    setStageBusy(true);
    try {
      await api.post(`/projects/${project.id}/stage`, { stage });
      toast(`Stage → ${humanize(stage)}`);
      reload();
      window.dispatchEvent(new CustomEvent('data-changed'));
    } finally {
      setStageBusy(false);
    }
  };

  const archive = async () => {
    await api.post(`/projects/${project.id}/${project.isArchived ? 'activate' : 'archive'}`, {});
    toast(project.isArchived ? 'Project reactivated' : 'Project archived');
    reload();
    window.dispatchEvent(new CustomEvent('data-changed'));
  };

  return (
    <ProjectContext.Provider value={{ project, reload }}>
      <div>
        <div style={{ padding: '16px 24px 0', maxWidth: 1400 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Link to="/projects" className="dim tiny">
              ← Projects
            </Link>
            {project.isArchived ? <Badge value="ARCHIVED" /> : null}
            <h1 style={{ fontSize: 20, margin: 0, letterSpacing: '-0.3px' }}>{project.name}</h1>
            <span className="mono dim tiny">{project.slug}</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
              {project.repositoryUrl ? (
                <a className="btn sm" href={project.repositoryUrl} target="_blank" rel="noreferrer">
                  Repo ↗
                </a>
              ) : null}
              <select
                value={project.stage}
                disabled={stageBusy}
                onChange={e => changeStage(e.target.value)}
                style={{
                  background: 'var(--bg)',
                  border: `1px solid ${statusColor(project.stage)}66`,
                  color: statusColor(project.stage),
                  borderRadius: 'var(--radius)',
                  padding: '4px 8px'
                }}
              >
                {STAGES.map(s => (
                  <option key={s} value={s} style={{ color: 'var(--text)' }}>
                    {humanize(s)}
                  </option>
                ))}
              </select>
              <ConfirmButton
                className="btn sm"
                label={project.isArchived ? 'Reactivate' : 'Archive'}
                confirmLabel="Confirm"
                question="Archive preserves all history. Continue?"
                onConfirm={archive}
              />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 320px', minWidth: 220 }}>
              <ProgressBar value={project.stats.progress} color={statusColor(project.stage)} />
            </div>
            <span className="tiny muted">
              {project.stats.progress}% · {project.stats.tasksCompleted}/{project.stats.tasksTotal} tasks · {project.stats.issuesOpen} open issues ·{' '}
              {project.stats.prompts} prompts
            </span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {project.tags.map(t => (
                <span className="tag-chip tag" key={t.id}>
                  {t.name}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="tabs" style={{ padding: '0 24px', marginTop: 12, marginBottom: 0 }}>
          {TABS.map(t => (
            <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => 'tab' + (isActive ? ' active' : '')}>
              {t.label}
            </NavLink>
          ))}
        </div>

        <Outlet />
      </div>
    </ProjectContext.Provider>
  );
}