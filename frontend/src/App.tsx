import { Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DocumentMonitorProvider } from './lib/useDocumentMonitor';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Portfolio } from './pages/Portfolio';
import { SearchPage } from './pages/SearchPage';
import { TagsPage } from './pages/TagsPage';
import { SettingsPage } from './pages/SettingsPage';
import { ProjectLayout } from './pages/ProjectLayout';
import { ProjectOverview } from './pages/ProjectOverview';
import { IdeaPage } from './pages/IdeaPage';
import { ProjectSettings } from './pages/ProjectSettings';
import { ActivityPage } from './pages/ActivityPage';
import { ArchitecturePage } from './pages/ArchitecturePage';
import { DevelopmentPage } from './pages/DevelopmentPage';
import { ProductionPage } from './pages/ProductionPage';
import { TestingPage } from './pages/TestingPage';
import { PromptsPage } from './pages/PromptsPage';
import { V1PromptGenerator } from './pages/V1PromptGenerator';
import { DocumentsPage } from './pages/DocumentsPage';
import { ResourcePage } from './pages/ResourcePage';
import { FeaturesPage } from './pages/FeaturesPage';

export default function App() {
  return (
    <AppProvider>
      {/* One document-monitor subscription for the whole application. Mounted
          here, above the routes, so navigating between pages does not open or
          close a stream and every page reads the same detected-change state. */}
      <DocumentMonitorProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="projects" element={<Portfolio />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="tags" element={<TagsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="projects/:slug" element={<ProjectLayout />}>
              <Route index element={<ProjectOverview />} />
              <Route path="idea" element={<IdeaPage />} />
              <Route path="research" element={<ResourcePage configKey="research" />} />
              <Route path="requirements" element={<ResourcePage configKey="requirements" />} />
              <Route path="features" element={<FeaturesPage />} />
              <Route path="tasks" element={<ResourcePage configKey="tasks" />} />
              <Route path="milestones" element={<ResourcePage configKey="milestones" />} />
              <Route path="architecture" element={<ArchitecturePage />} />
              <Route path="decisions" element={<ResourcePage configKey="decisions" />} />
              <Route path="development" element={<DevelopmentPage />} />
              <Route path="prompts" element={<PromptsPage />} />
              <Route path="prompt-generator" element={<V1PromptGenerator />} />
              <Route path="bugs" element={<ResourcePage configKey="issues" />} />
              <Route path="testing" element={<TestingPage />} />
              <Route path="deployments" element={<ResourcePage configKey="deployments" />} />
              <Route path="production" element={<ProductionPage />} />
              <Route path="documentation" element={<DocumentsPage />} />
              <Route path="notes" element={<ResourcePage configKey="notes" />} />
              <Route path="activity" element={<ActivityPage />} />
              <Route path="settings" element={<ProjectSettings />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </DocumentMonitorProvider>
    </AppProvider>
  );
}