import { ResourcePage } from './ResourcePage';
import { SubTabs } from '../components/SubTabs';

export function TestingPage() {
  return (
    <SubTabs
      tabs={[
        { key: 'tasks', label: 'Tasks in testing', render: () => <ResourcePage configKey="tasks" presetFilters={{ status: 'TESTING' }} intro="Work currently being verified before it can be called done." /> },
        { key: 'issues', label: 'Issues in testing', render: () => <ResourcePage configKey="issues" presetFilters={{ status: 'TESTING' }} intro="Fixes that are being verified." /> }
      ]}
    />
  );
}