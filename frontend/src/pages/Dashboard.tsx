import { Link } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { useApp } from '../context/AppContext';
import type { DashboardData, NextAction } from '../api/types';
import { Badge, Loading, StageBadge, TimeAgo, EmptyState } from '../components/ui';
import { humanize } from '../resources';
import { statusColor } from '../lib/status';

export function Dashboard() {
  const { data, loading } = useApi<DashboardData>('/dashboard');
  const { data: nextActions } = useApi<NextAction[]>('/dashboard/next-actions');
  const { projects } = useApp();

  if (loading && !data) return <div className="page"><Loading /></div>;
  if (!data) return <div className="page"><EmptyState title="Nothing to show yet" /></div>;

  const { totals, byStage, tasksByStatus, recentActivity } = data;
  const stageEntries = Object.entries(byStage).sort((a, b) => b[1] - a[1]);
  const maxStage = Math.max(1, ...stageEntries.map(s => s[1]));
  const taskEntries = Object.entries(tasksByStatus);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <div className="sub">Everything across your projects, in one place.</div>
        </div>
        <div className="actions">
          <Link to="/projects?new=1" className="btn primary">
            + New Project
          </Link>
        </div>
      </div>

      <div className="grid c4">
        <div className="stat">
          <div className="label">Active projects</div>
          <div className="value">{totals.active}</div>
          <div className="hint">{totals.archived} archived</div>
        </div>
        <div className="stat">
          <div className="label">Total tasks</div>
          <div className="value">{totals.tasks}</div>
          <div className="hint">{tasksByStatus['COMPLETED'] ?? 0} completed · {tasksByStatus['IN_PROGRESS'] ?? 0} in progress</div>
        </div>
        <div className="stat">
          <div className="label">Open issues</div>
          <div className="value" style={{ color: totals.openIssues ? 'var(--red)' : undefined }}>
            {totals.openIssues}
          </div>
          <div className="hint">bugs &amp; problems in flight</div>
        </div>
        <div className="stat">
          <div className="label">Projects tracked</div>
          <div className="value">{totals.projects}</div>
          <div className="hint">across all stages</div>
        </div>
      </div>

      <div className="grid c2" style={{ marginTop: 16 }}>
        <div>
          <h2 className="section">Next actions</h2>
          <div className="card">
            {!nextActions || nextActions.length === 0 ? (
              <div className="dim">You're all caught up.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {nextActions.slice(0, 10).map((a, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span>→</span>
                    <Link to={`/projects/${a.projectId}`} className="tiny">
                      {a.projectName}
                    </Link>
                    <span className="muted">{a.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div>
          <h2 className="section">Stage distribution</h2>
          <div className="card">
            {stageEntries.length === 0 ? (
              <div className="dim">No projects yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {stageEntries.map(([stage, count]) => (
                  <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ width: 115, flex: '0 0 auto' }}>
                      <Badge value={stage} />
                    </span>
                    <div className="progress" style={{ flex: 1 }}>
                      <div style={{ width: `${(count / maxStage) * 100}%`, background: statusColor(stage) }} />
                    </div>
                    <span className="tiny" style={{ width: 24, textAlign: 'right' }}>{count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid c2" style={{ marginTop: 16 }}>
        <div>
          <h2 className="section">Projects</h2>
          <div className="card">
            {projects.filter(p => !p.isArchived).length === 0 ? (
              <div className="dim">No active projects.</div>
            ) : (
              projects
                .filter(p => !p.isArchived)
                .slice(0, 8)
                .map(p => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border-muted)' }}>
                    <Link to={`/projects/${p.slug}`} style={{ fontWeight: 500 }}>
                      {p.name}
                    </Link>
                    <span style={{ marginLeft: 'auto', minWidth: 90 }}>
                      <StageBadge stage={p.stage} />
                    </span>
                    <span className="dim tiny nowrap" style={{ minWidth: 70, textAlign: 'right' }}>
                      {p.stats.progress}%
                    </span>
                  </div>
                ))
            )}
          </div>
        </div>

        <div>
          <h2 className="section">Recent activity</h2>
          <div className="card">
            {recentActivity.length === 0 ? (
              <div className="dim">No activity yet.</div>
            ) : (
              <div className="timeline">
                {recentActivity.slice(0, 12).map(a => (
                  <div className="timeline-item" key={a.id}>
                    <div className="tl-head">
                      <span className="tl-type">{humanize(a.type)}</span>
                      {a.project ? (
                        <Link to={`/projects/${a.project.slug}`} className="tiny">
                          {a.project.name}
                        </Link>
                      ) : null}
                      <span className="tl-time">
                        <TimeAgo value={a.createdAt} />
                      </span>
                    </div>
                    <div className="tl-desc">{a.description}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <h2 className="section">Task status</h2>
        <div className="grid c4">
          {taskEntries.length === 0 ? (
            <div className="dim">No tasks yet.</div>
          ) : (
            taskEntries.map(([status, count]) => (
              <div className="stat" key={status}>
                <div className="label">{humanize(status)}</div>
                <div className="value sm">{count}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}