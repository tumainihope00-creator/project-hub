import { Link } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { useProject } from '../context/ProjectContext';
import { Loading, ProgressBar, TimeAgo, EmptyState, Badge } from '../components/ui';
import { ProjectDocumentCard } from '../components/ProjectDocumentCard';
import { humanize } from '../resources';
import { statusColor } from '../lib/status';
import type { ProjectOverview as ProjectOverviewData, WorkspaceStatus } from '../api/types';

function Check({ ok, label }: { ok: boolean | null | undefined; label: string }) {
  if (ok === null || ok === undefined) return <span className="dim">{label}</span>;
  return (
    <span>
      <span style={{ color: ok ? 'var(--green)' : 'var(--red)', marginRight: 6 }}>{ok ? '✓' : '✗'}</span>
      {label}
    </span>
  );
}

/**
 * Shows the project's physical workspace and whether it is still on disk.
 *
 * There is deliberately no "Open folder" button. Project Hub is a browser app
 * and the web platform gives a page no way to open a local directory in the
 * operating system's file manager - the File System Access API is
 * permission-gated, not universally supported, and would be a dead button
 * everywhere else. The path is shown and can be copied instead, which is honest
 * about what the architecture can actually do. VS Code integration is a later
 * phase.
 */
function WorkspaceCard() {
  const { project } = useProject();
  const { data } = useApi<WorkspaceStatus>(`/projects/${project.id}/workspace`);

  if (!project.folderPath) {
    return (
      <div className="card dim">
        This project has no workspace folder. Projects created before workspace folders existed, and projects created
        from an imported document, do not have one.
      </div>
    );
  }

  const present = data?.exists === true && data?.isDirectory === true;

  return (
    <div className="card">
      <div className="tiny dim">Workspace</div>
      <div className="mono" style={{ fontSize: 14, wordBreak: 'break-all', margin: '4px 0 8px' }}>
        {project.folderPath}
      </div>
      <dl className="kv" style={{ margin: 0 }}>
        <dt>Folder</dt>
        <dd>
          <Check ok={data?.exists} label={data?.exists === true ? 'Exists on disk' : data?.exists === false ? 'Missing from disk' : 'Checking…'} />
        </dd>
        <dt>Is a folder</dt>
        <dd>
          <Check ok={data?.isDirectory} label={data?.isDirectory === true ? 'Yes' : data?.isDirectory === false ? 'No' : 'Checking…'} />
        </dd>
        <dt>Readable</dt>
        <dd>
          <Check ok={data?.readable} label={data?.readable === true ? 'Yes' : data?.readable === false ? 'No' : 'Checking…'} />
        </dd>
      </dl>
      {present ? (
        <div className="tiny dim" style={{ marginTop: 10 }}>
          Open the folder in your file manager or editor. Project Hub cannot launch it from the browser.
        </div>
      ) : null}
      {data?.problems?.length ? (
        <div className="tiny" style={{ color: 'var(--yellow)', marginTop: 8 }}>
          {data.problems.map((p, i) => (
            <div key={i}>{p.message}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ProjectOverview() {
  const { project } = useProject();
  const { data, loading } = useApi<ProjectOverviewData>(`/projects/${project.id}/overview`);
  const { data: heat } = useApi<{ start: string; days: { date: string; count: number }[] }>(`/projects/${project.id}/heatmap`);

  if (loading && !data) return <div className="page"><Loading /></div>;
  if (!data) return <div className="page"><EmptyState title="No overview available" /></div>;

  const { stats, recentActivity, nextActions } = data;

  const cells: { date: string; count: number }[] = [];
  if (heat) {
    const map = new Map(heat.days.map(d => [d.date, d.count]));
    const start = new Date(heat.start);
    for (let i = 0; i < 70; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      cells.push({ date: key, count: map.get(key) ?? 0 });
    }
  }

  const statItems: { label: string; value: number; hint?: string; to?: string }[] = [
    { label: 'Tasks', value: stats.tasksTotal, hint: `${stats.tasksCompleted} completed · ${stats.tasksOpen} open`, to: 'tasks' },
    { label: 'Blocked', value: stats.tasksBlocked, hint: `${stats.tasksOverdue} overdue`, to: 'tasks' },
    { label: 'Issues', value: stats.issuesOpen, hint: `${stats.issuesCritical} critical`, to: 'bugs' },
    { label: 'Features', value: stats.features, to: 'features' },
    { label: 'Requirements', value: stats.requirements, to: 'requirements' },
    { label: 'Research', value: stats.researchEntries, hint: `${stats.researchQuestions} questions`, to: 'research' },
    { label: 'AI prompts', value: stats.prompts, to: 'prompts' },
    { label: 'AI sessions', value: stats.aiSessions, to: 'development' },
    { label: 'Dev sessions', value: stats.developmentSessions, to: 'development' },
    { label: 'Deployments', value: stats.deployments, to: 'deployments' },
    { label: 'Documents', value: stats.documents, to: 'documentation' },
    { label: 'Notes', value: stats.notes, to: 'notes' }
  ];

  return (
    <div className="page">
      <div className="grid c4">
        <div className="stat">
          <div className="label">Progress</div>
          <div className="value">{stats.progress}%</div>
          <div style={{ marginTop: 8 }}>
            <ProgressBar value={stats.progress} color={statusColor(project.stage)} />
          </div>
        </div>
        <div className="stat">
          <div className="label">Last activity</div>
          <div className="value sm">
            <TimeAgo value={stats.lastActivityAt} />
          </div>
          <div className="hint">{stats.activityCount} recorded events</div>
        </div>
        <div className="stat">
          <div className="label">Last deployment</div>
          <div className="value sm">
            <TimeAgo value={stats.lastDeploymentAt} />
          </div>
          <div className="hint">{stats.deployments} total</div>
        </div>
        <div className="stat">
          <div className="label">Milestones</div>
          <div className="value">{stats.milestones}</div>
          <div className="hint">{stats.decisions} decisions logged</div>
        </div>
      </div>

      <h2 className="section">Workspace</h2>
      <WorkspaceCard />

      <h2 className="section">Project document</h2>
      <ProjectDocumentCard />

      <div className="grid c2" style={{ marginTop: 16 }}>
        <div>
          <h2 className="section">What needs attention</h2>
          <div className="card">
            {nextActions.length === 0 ? (
              <div className="dim">Nothing flagged. Good state.</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {nextActions.map((a, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>
                    {a}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <h2 className="section">The idea</h2>
          <div className="card">
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{project.description || project.problem || 'No description yet.'}</p>
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Link className="btn sm" to="idea">
                View full idea
              </Link>
              <Link className="btn sm primary" to="prompt-generator">
                Generate V1 prompt
              </Link>
            </div>
            {project.stage === 'IDEA' && !project.v1Scope ? (
              <div className="dim tiny" style={{ marginTop: 10 }}>
                Tip: define a V1 scope on the Idea page so the generator knows what the first usable version must include.
              </div>
            ) : null}
          </div>

          <h2 className="section">Activity heatmap (last 10 weeks)</h2>
          <div className="card">
            <div className="heat">
              {cells.map(c => (
                <span
                  key={c.date}
                  className={'cell heat-l' + level(c.count)}
                  title={`${c.date}: ${c.count} event${c.count === 1 ? '' : 's'}`}
                />
              ))}
            </div>
          </div>
        </div>

        <div>
          <h2 className="section">At a glance</h2>
          <div className="grid c2">
            {statItems.map(s => (
              <Link key={s.label} to={s.to ?? '.'} className="stat" style={{ textDecoration: 'none' }}>
                <div className="label">{s.label}</div>
                <div className="value sm">{s.value}</div>
                {s.hint ? <div className="hint">{s.hint}</div> : null}
              </Link>
            ))}
          </div>
          <div style={{ marginTop: 12 }}>
            <Badge value={project.stage} />
          </div>
        </div>
      </div>

      <h2 className="section">Recent activity</h2>
      <div className="card">
        {recentActivity.length === 0 ? (
          <div className="dim">No activity recorded yet.</div>
        ) : (
          <div className="timeline">
            {recentActivity.map(a => (
              <div className="timeline-item" key={a.id}>
                <div className="tl-head">
                  <span className="tl-type">{humanize(a.type)}</span>
                  <span className="tl-time">
                    <TimeAgo value={a.createdAt} />
                  </span>
                </div>
                <div className="tl-desc">{a.description}</div>
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 10 }}>
          <Link className="btn sm" to="activity">
            Full activity timeline →
          </Link>
        </div>
      </div>
    </div>
  );
}

function level(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}