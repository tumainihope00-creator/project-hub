import { ResourcePage } from './ResourcePage';
import { SubTabs } from '../components/SubTabs';

export function DevelopmentPage() {
  return (
    <SubTabs
      tabs={[
        { key: 'dev', label: 'Development Sessions', render: () => <ResourcePage configKey="development-sessions" intro="A journal of focused development sessions — what you set out to do and what actually happened." /> },
        { key: 'ai', label: 'AI Sessions', render: () => <ResourcePage configKey="ai-sessions" intro="Every AI-assisted session, the prompt used, and what you kept or rejected." /> }
      ]}
    />
  );
}