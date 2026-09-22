import { useApi } from '../lib/useApi';
import { useProject } from '../context/ProjectContext';
import { EmptyState, Loading, TimeAgo } from '../components/ui';
import { humanize } from '../resources';
import type { ActivityEvent } from '../api/types';

export function ActivityPage() {
  const { project } = useProject();
  const { data, loading } = useApi<{ date: string; items: ActivityEvent[] }[]>(`/projects/${project.id}/timeline`);
  const groups = data ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <div className="sub">The complete recorded history of this project, newest first.</div>
        </div>
      </div>

      {loading && groups.length === 0 ? (
        <Loading />
      ) : groups.length === 0 ? (
        <EmptyState title="No activity yet" hint="Actions across the project will show up here automatically." />
      ) : (
        groups.map(group => (
          <div key={group.date}>
            <h2 className="section">{new Date(group.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}</h2>
            <div className="timeline">
              {group.items.map(ev => (
                <div className="timeline-item" key={ev.id}>
                  <div className="tl-head">
                    <span className="tl-type">{humanize(ev.type)}</span>
                    <span className="tl-time">
                      <TimeAgo value={ev.createdAt} />
                    </span>
                  </div>
                  <div className="tl-desc">{ev.description}</div>
                  {ev.metadata && Object.keys(ev.metadata).length > 0 ? (
                    <div className="dim tiny mono" style={{ marginTop: 2 }}>
                      {Object.entries(ev.metadata)
                        .filter(([, v]) => v !== null && v !== undefined)
                        .map(([k, v]) => `${k}=${String(v)}`)
                        .join('  ')}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}