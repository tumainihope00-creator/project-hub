import { useApi } from '../lib/useApi';
import { useProject } from '../context/ProjectContext';
import { ResourcePage } from './ResourcePage';
import { SubTabs } from '../components/SubTabs';
import { EmptyState, Loading, TimeAgo } from '../components/ui';
import type { ResourceRow } from '../api/types';

interface DeploymentRow extends ResourceRow {
  environment?: string;
  version?: string | null;
  platform?: string | null;
  url?: string | null;
  status?: string;
  date?: string;
}

function ProductionHealth() {
  const { project } = useProject();
  const { data, loading } = useApi<{ stats: { deployments: number; incidentsOpen: number; lastDeploymentAt: string | null }; lastDeployment: DeploymentRow | null; currentStage: string }>(
    `/projects/${project.id}/health`
  );
  if (loading) return <Loading />;
  if (!data) return <EmptyState title="No health data" />;
  return (
    <div className="grid c3">
      <div className="stat">
        <div className="label">Current stage</div>
        <div className="value sm">{data.currentStage}</div>
      </div>
      <div className="stat">
        <div className="label">Total deployments</div>
        <div className="value">{data.stats.deployments}</div>
      </div>
      <div className="stat">
        <div className="label">Open incidents</div>
        <div className="value" style={{ color: data.stats.incidentsOpen ? 'var(--red)' : undefined }}>
          {data.stats.incidentsOpen}
        </div>
      </div>
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="label" style={{ marginBottom: 8 }}>
          Last successful deployment
        </div>
        {data.lastDeployment ? (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="mono">{data.lastDeployment.version ?? '—'}</span>
            <span>{data.lastDeployment.platform ?? '—'}</span>
            <span className="dim tiny">
              <TimeAgo value={data.lastDeployment.date ?? null} />
            </span>
            {data.lastDeployment.url ? (
              <a href={data.lastDeployment.url} target="_blank" rel="noreferrer" className="btn sm">
                Open ↗
              </a>
            ) : null}
          </div>
        ) : (
          <div className="dim">No successful deployment recorded yet.</div>
        )}
      </div>
    </div>
  );
}

export function ProductionPage() {
  return (
    <SubTabs
      tabs={[
        { key: 'health', label: 'Health', render: () => <ProductionHealth /> },
        {
          key: 'incidents',
          label: 'Incidents',
          render: () => <ResourcePage configKey="incidents" intro="What went wrong in production, and how it was resolved." />
        },
        {
          key: 'deploys',
          label: 'Production deploys',
          render: () => <ResourcePage configKey="deployments" presetFilters={{ environment: 'PRODUCTION' }} intro="Deployments that reached production." />
        }
      ]}
    />
  );
}