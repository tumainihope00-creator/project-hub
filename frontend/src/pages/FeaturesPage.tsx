import { ResourcePage } from './ResourcePage';
import { FeatureRequirements } from '../components/FeatureRequirements';
import { useProject } from '../context/ProjectContext';

export function FeaturesPage() {
  const { project } = useProject();
  return (
    <ResourcePage
      configKey="features"
      renderDetailExtra={row => <FeatureRequirements projectId={project.id} featureId={Number(row.id)} />}
    />
  );
}
