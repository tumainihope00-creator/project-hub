import { ResourcePage } from './ResourcePage';
import { SubTabs } from '../components/SubTabs';

export function ArchitecturePage() {
  return (
    <SubTabs
      tabs={[
        { key: 'tech', label: 'Technology Stack', render: () => <ResourcePage configKey="tech-stack" intro="The chosen technologies and why the stack looks the way it does." /> },
        { key: 'db', label: 'Database Design', render: () => <ResourcePage configKey="database-tables" intro="Tables and data structures of this project." /> },
        { key: 'api', label: 'API Endpoints', render: () => <ResourcePage configKey="api-endpoints" intro="The HTTP surface of the project." /> }
      ]}
    />
  );
}