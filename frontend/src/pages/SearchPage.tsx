import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { EmptyState, Loading } from '../components/ui';
import { humanize } from '../resources';

interface SearchItem {
  id: number;
  type: string;
  title: string;
  subtitle?: string | null;
  project?: { id: number; name: string; slug: string };
  url: string;
  stage?: string;
}

type SearchGroups = Record<string, SearchItem[]>;

const GROUP_LABELS: Record<string, string> = {
  projects: 'Projects',
  requirements: 'Requirements',
  features: 'Features',
  tasks: 'Tasks',
  issues: 'Issues',
  research: 'Research',
  prompts: 'Prompts',
  decisions: 'Decisions',
  developmentSessions: 'Development sessions',
  documents: 'Documents',
  notes: 'Notes',
  deployments: 'Deployments'
};

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const { data, loading } = useApi<SearchGroups>(q ? `/search?q=${encodeURIComponent(q)}` : null);

  const groups = data ? Object.entries(data).filter(([, items]) => items && items.length > 0) : [];
  const total = groups.reduce((acc, [, items]) => acc + items.length, 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Search</h1>
          <div className="sub">
            {q ? (
              <>
                {total} result{total === 1 ? '' : 's'} for “{q}”
              </>
            ) : (
              'Type in the top search bar.'
            )}
          </div>
        </div>
      </div>

      {!q ? (
        <EmptyState title="Search everything" hint="Projects, tasks, prompts, research, issues, decisions, documents and more." />
      ) : loading ? (
        <Loading />
      ) : total === 0 ? (
        <EmptyState title="No results" hint="Try a different term." />
      ) : (
        groups.map(([group, items]) => (
          <div key={group}>
            <h2 className="section">
              {GROUP_LABELS[group] ?? humanize(group)} <span className="dim">({items.length})</span>
            </h2>
            {items.map(item => (
              <Link to={item.url} key={`${group}-${item.id}`} className="search-result" style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
                <div className="meta">
                  <span>{humanize(item.type)}</span>
                  {item.project ? <span>· {item.project.name}</span> : null}
                  {item.stage ? <span>· {humanize(item.stage)}</span> : null}
                </div>
                <div className="title">{item.title}</div>
                {item.subtitle ? <div className="snippet">{item.subtitle}</div> : null}
              </Link>
            ))}
          </div>
        ))
      )}
    </div>
  );
}