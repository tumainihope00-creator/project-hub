import type { ResourceConfig } from './resources';
import { STAGES } from './resources';

export const PROJECT_CONFIG: ResourceConfig = {
  path: 'projects',
  label: 'Projects',
  singular: 'Project',
  taggable: true,
  searchable: true,
  titleKey: 'name',
  fields: [
    { name: 'name', label: 'Project name', type: 'text', required: true },
    { name: 'stage', label: 'Stage', type: 'select', options: STAGES },
    { name: 'description', label: 'Short description', type: 'textarea', rows: 2 },
    { name: 'problem', label: 'Problem it solves', type: 'textarea', rows: 3 },
    { name: 'motivation', label: 'Motivation — why I want to build it', type: 'textarea', rows: 3 },
    { name: 'targetUsers', label: 'Target users', type: 'textarea', rows: 2 },
    { name: 'expectedValue', label: 'Expected value / outcome', type: 'textarea', rows: 2 },
    { name: 'assumptions', label: 'Assumptions', type: 'textarea', rows: 2 },
    { name: 'initialQuestions', label: 'Initial questions', type: 'textarea', rows: 2 },
    { name: 'inspiration', label: 'Inspiration', type: 'text' },
    { name: 'repositoryUrl', label: 'Repository URL', type: 'url' },
    { name: 'tags', label: 'Tags', type: 'tags' }
  ],
  columns: []
};