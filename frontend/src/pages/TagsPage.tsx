import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { EmptyState, Loading, StageBadge } from '../components/ui';
import type { ProjectSummary, TagUsage } from '../api/types';

export function TagsPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('tag') ?? '';
  const { data: tags, loading } = useApi<TagUsage[]>('/tags');
  const { data: projects } = useApi<ProjectSummary[]>(selected ? `/projects?tag=${encodeURIComponent(selected)}&archived=all` : null);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Tags</h1>
          <div className="sub">Cross-cutting labels across your projects, tasks, prompts, research and docs.</div>
        </div>
      </div>

      <div className="grid c2">
        <div>
          <h2 className="section">All tags</h2>
          <div className="card">
            {loading ? (
              <Loading />
            ) : !tags || tags.length === 0 ? (
              <div className="dim">No tags yet. Add tags while creating records.</div>
            ) : (
              <div className="tag-cloud">
                {tags.map(t => (
                  <button
                    key={t.id}
                    className="tag"
                    onClick={() => {
                      const next = new URLSearchParams(params);
                      if (selected === t.name) next.delete('tag');
                      else next.set('tag', t.name);
                      setParams(next);
                    }}
                    style={{
                      cursor: 'pointer',
                      background: 'none',
                      border: '1px solid ' + (selected === t.name ? 'var(--accent)' : 'var(--border)'),
                      color: selected === t.name ? 'var(--accent)' : undefined
                    }}
                  >
                    {t.name}
                    <span className="n">{t.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div>
          <h2 className="section">{selected ? `Projects tagged “${selected}”` : 'Select a tag'}</h2>
          <div className="card">
            {!selected ? (
              <div className="dim">Choose a tag to see matching projects.</div>
            ) : !projects || projects.length === 0 ? (
              <EmptyState title="No projects with this tag" />
            ) : (
              projects.map(p => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border-muted)' }}>
                  <Link to={`/projects/${p.slug}`} style={{ fontWeight: 500 }}>
                    {p.name}
                  </Link>
                  <span style={{ marginLeft: 'auto' }}>
                    <StageBadge stage={p.stage} />
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="dim tiny" style={{ marginTop: 8 }}>
            Tag filtering is currently available for projects in the portfolio view. Individual records also expose their tags in their detail views.
          </div>
        </div>
      </div>
    </div>
  );
}