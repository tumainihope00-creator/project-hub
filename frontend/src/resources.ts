export type FieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'date'
  | 'number'
  | 'url'
  | 'tags'
  | 'relation'
  | 'boolean';

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  options?: string[];
  rows?: number;
  required?: boolean;
  placeholder?: string;
  help?: string;
  /** For relation fields: which project sub-resource to load options from */
  relation?: { resource: string; labelKey: string; valueKey?: string };
}

export interface ColumnDef {
  key: string;
  label: string;
  kind?: 'text' | 'badge' | 'date' | 'datetime' | 'number' | 'bool' | 'mono' | 'percent';
  width?: string;
}

export interface ResourceConfig {
  path: string;
  label: string;
  singular: string;
  taggable?: boolean;
  searchable?: boolean;
  fields: FieldDef[];
  columns: ColumnDef[];
  filters?: FieldDef[];
  titleKey: string;
  defaultSort?: string;
}

export const STAGES = ['IDEA', 'RESEARCH', 'PLANNING', 'ARCHITECTURE', 'BUILDING', 'TESTING', 'DEPLOYMENT', 'PRODUCTION', 'MAINTENANCE', 'PAUSED', 'COMPLETED', 'ARCHIVED', 'ABANDONED'];
export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'TESTING', 'COMPLETED', 'CANCELLED'];
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const ISSUE_STATUSES = ['OPEN', 'INVESTIGATING', 'FIXING', 'TESTING', 'RESOLVED', 'CLOSED', 'WONT_FIX'];
export const REQUIREMENT_TYPES = ['FUNCTIONAL', 'NON_FUNCTIONAL', 'CONSTRAINT'];
export const REQUIREMENT_STATUSES = ['PROPOSED', 'APPROVED', 'IN_PROGRESS', 'IMPLEMENTED', 'DEFERRED', 'REJECTED'];
export const FEATURE_STATUSES = ['PLANNED', 'BUILDING', 'TESTING', 'COMPLETED', 'DROPPED'];
export const RESEARCH_TYPES = ['TECHNICAL', 'MARKET', 'USER', 'COMPETITOR', 'ACADEMIC', 'SECURITY', 'ARCHITECTURE', 'TECHNOLOGY', 'LEGAL', 'OTHER'];
export const RQ_STATUSES = ['OPEN', 'INVESTIGATING', 'ANSWERED', 'REJECTED'];
export const ADR_STATUSES = ['PROPOSED', 'ACCEPTED', 'SUPERSEDED', 'REJECTED'];
export const MILESTONE_STATUSES = ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'DELAYED', 'CANCELLED'];
export const PROMPT_RESULTS = ['GENERATED', 'SUCCESSFUL', 'PARTIALLY_SUCCESSFUL', 'FAILED', 'REJECTED', 'NEEDS_MODIFICATION'];
export const DEPLOY_ENVS = ['LOCAL', 'DEVELOPMENT', 'STAGING', 'PRODUCTION'];
export const DEPLOY_STATUSES = ['QUEUED', 'IN_PROGRESS', 'SUCCESSFUL', 'FAILED', 'ROLLED_BACK'];
export const INCIDENT_STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED', 'MONITORING'];
export const DOC_TYPES = ['README', 'SRS', 'API_DOCUMENTATION', 'USER_GUIDE', 'INSTALLATION_GUIDE', 'ARCHITECTURE_DOCUMENTATION', 'DEPLOYMENT_GUIDE', 'RESEARCH_REPORT', 'OTHER'];
export const GIT_KINDS = ['REPOSITORY', 'COMMIT', 'BRANCH', 'PULL_REQUEST', 'RELEASE'];
export const TECH_CATEGORIES = ['FRONTEND', 'BACKEND', 'DATABASE', 'HOSTING', 'OTHER'];
export const PROMPT_CATEGORIES = [
  'Research',
  'Planning',
  'Architecture',
  'Coding',
  'Debugging',
  'Refactoring',
  'Database',
  'UI/UX',
  'Testing',
  'Deployment',
  'Documentation',
  'Security',
  'Troubleshooting',
  'General',
  'V1 Build Prompt'
];
export const PROMPT_STATUSES = ['DRAFT', 'READY', 'USED', 'ARCHIVED'];

export const RESOURCES: Record<string, ResourceConfig> = {
  research: {
    path: 'research',
    label: 'Research',
    singular: 'Research entry',
    taggable: true,
    searchable: true,
    titleKey: 'title',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'type', label: 'Type', type: 'select', options: RESEARCH_TYPES },
      { name: 'question', label: 'Question', type: 'textarea', rows: 2 },
      { name: 'source', label: 'Source', type: 'text' },
      { name: 'url', label: 'URL', type: 'url' },
      { name: 'summary', label: 'Summary', type: 'textarea', rows: 3 },
      { name: 'findings', label: 'Findings', type: 'textarea', rows: 4 },
      { name: 'relevance', label: 'Relevance', type: 'text' },
      { name: 'date', label: 'Date', type: 'date' },
      { name: 'tags', label: 'Tags', type: 'tags' }
    ],
    columns: [
      { key: 'title', label: 'Title' },
      { key: 'type', label: 'Type', kind: 'badge', width: '120px' },
      { key: 'source', label: 'Source', width: '160px' },
      { key: 'date', label: 'Date', kind: 'date', width: '110px' }
    ],
    filters: [{ name: 'type', label: 'Type', type: 'select', options: RESEARCH_TYPES }]
  },
  'research-questions': {
    path: 'research-questions',
    label: 'Research Questions',
    singular: 'Research question',
    searchable: true,
    titleKey: 'question',
    fields: [
      { name: 'question', label: 'Question', type: 'textarea', rows: 2, required: true },
      { name: 'status', label: 'Status', type: 'select', options: RQ_STATUSES },
      { name: 'category', label: 'Category', type: 'text' },
      { name: 'answer', label: 'Answer / Conclusion', type: 'textarea', rows: 4 }
    ],
    columns: [
      { key: 'question', label: 'Question' },
      { key: 'status', label: 'Status', kind: 'badge', width: '130px' },
      { key: 'category', label: 'Category', width: '120px' }
    ],
    filters: [{ name: 'status', label: 'Status', type: 'select', options: RQ_STATUSES }]
  },
  requirements: {
    path: 'requirements',
    label: 'Requirements',
    singular: 'Requirement',
    searchable: true,
    titleKey: 'title',
    fields: [
      { name: 'code', label: 'Code', type: 'text', placeholder: 'auto (e.g. REQ-001)' },
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'type', label: 'Type', type: 'select', options: REQUIREMENT_TYPES },
      { name: 'priority', label: 'Priority', type: 'select', options: PRIORITIES },
      { name: 'status', label: 'Status', type: 'select', options: REQUIREMENT_STATUSES },
      { name: 'description', label: 'Description', type: 'textarea', rows: 4 }
    ],
    columns: [
      { key: 'code', label: 'Code', kind: 'mono', width: '100px' },
      { key: 'title', label: 'Title' },
      { key: 'type', label: 'Type', kind: 'badge', width: '130px' },
      { key: 'priority', label: 'Priority', kind: 'badge', width: '100px' },
      { key: 'status', label: 'Status', kind: 'badge', width: '120px' }
    ],
    filters: [
      { name: 'type', label: 'Type', type: 'select', options: REQUIREMENT_TYPES },
      { name: 'status', label: 'Status', type: 'select', options: REQUIREMENT_STATUSES }
    ]
  },
  features: {
    path: 'features',
    label: 'Features',
    singular: 'Feature',
    searchable: true,
    titleKey: 'name',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'priority', label: 'Priority', type: 'select', options: PRIORITIES },
      { name: 'status', label: 'Status', type: 'select', options: FEATURE_STATUSES },
      { name: 'description', label: 'Description', type: 'textarea', rows: 4 }
    ],
    columns: [
      { key: 'name', label: 'Feature' },
      { key: 'status', label: 'Status', kind: 'badge', width: '120px' },
      { key: 'priority', label: 'Priority', kind: 'badge', width: '100px' }
    ],
    filters: [{ name: 'status', label: 'Status', type: 'select', options: FEATURE_STATUSES }]
  },
  milestones: {
    path: 'milestones',
    label: 'Milestones',
    singular: 'Milestone',
    titleKey: 'name',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'targetDate', label: 'Target date', type: 'date' },
      { name: 'status', label: 'Status', type: 'select', options: MILESTONE_STATUSES },
      { name: 'description', label: 'Description', type: 'textarea', rows: 3 }
    ],
    columns: [
      { key: 'name', label: 'Milestone' },
      { key: 'targetDate', label: 'Target', kind: 'date', width: '110px' },
      { key: 'status', label: 'Status', kind: 'badge', width: '120px' }
    ],
    filters: [{ name: 'status', label: 'Status', type: 'select', options: MILESTONE_STATUSES }]
  },
  tasks: {
    path: 'tasks',
    label: 'Tasks',
    singular: 'Task',
    taggable: true,
    searchable: true,
    titleKey: 'title',
    fields: [
      { name: 'code', label: 'Code', type: 'text', placeholder: 'auto (TASK-001)' },
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'status', label: 'Status', type: 'select', options: TASK_STATUSES },
      { name: 'priority', label: 'Priority', type: 'select', options: PRIORITIES },
      { name: 'dueDate', label: 'Due date', type: 'date' },
      { name: 'featureId', label: 'Feature', type: 'relation', relation: { resource: 'features', labelKey: 'name' } },
      { name: 'requirementId', label: 'Requirement', type: 'relation', relation: { resource: 'requirements', labelKey: 'title' } },
      { name: 'milestoneId', label: 'Milestone', type: 'relation', relation: { resource: 'milestones', labelKey: 'name' } },
      { name: 'devSessionId', label: 'Dev session', type: 'relation', relation: { resource: 'development-sessions', labelKey: 'number' } },
      { name: 'description', label: 'Description', type: 'textarea', rows: 4 },
      { name: 'tags', label: 'Tags', type: 'tags' }
    ],
    columns: [
      { key: 'code', label: 'Code', kind: 'mono', width: '95px' },
      { key: 'title', label: 'Task' },
      { key: 'status', label: 'Status', kind: 'badge', width: '115px' },
      { key: 'priority', label: 'Priority', kind: 'badge', width: '95px' },
      { key: 'dueDate', label: 'Due', kind: 'date', width: '105px' }
    ],
    filters: [
      { name: 'status', label: 'Status', type: 'select', options: TASK_STATUSES },
      { name: 'priority', label: 'Priority', type: 'select', options: PRIORITIES }
    ]
  },
  issues: {
    path: 'issues',
    label: 'Bugs & Issues',
    singular: 'Issue',
    taggable: true,
    searchable: true,
    titleKey: 'title',
    fields: [
      { name: 'code', label: 'Code', type: 'text', placeholder: 'auto (ISSUE-001)' },
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'severity', label: 'Severity', type: 'select', options: SEVERITIES },
      { name: 'priority', label: 'Priority', type: 'select', options: PRIORITIES },
      { name: 'status', label: 'Status', type: 'select', options: ISSUE_STATUSES },
      { name: 'environment', label: 'Environment', type: 'text' },
      { name: 'description', label: 'Description', type: 'textarea', rows: 3 },
      { name: 'stepsToReproduce', label: 'Steps to reproduce', type: 'textarea', rows: 3 },
      { name: 'expectedBehavior', label: 'Expected behaviour', type: 'textarea', rows: 2 },
      { name: 'actualBehavior', label: 'Actual behaviour', type: 'textarea', rows: 2 },
      { name: 'possibleCause', label: 'Possible cause', type: 'textarea', rows: 2 },
      { name: 'solution', label: 'Solution', type: 'textarea', rows: 3 },
      { name: 'tags', label: 'Tags', type: 'tags' }
    ],
    columns: [
      { key: 'code', label: 'Code', kind: 'mono', width: '95px' },
      { key: 'title', label: 'Issue' },
      { key: 'severity', label: 'Severity', kind: 'badge', width: '100px' },
      { key: 'status', label: 'Status', kind: 'badge', width: '120px' }
    ],
    filters: [
      { name: 'status', label: 'Status', type: 'select', options: ISSUE_STATUSES },
      { name: 'severity', label: 'Severity', type: 'select', options: SEVERITIES }
    ]
  },
  'development-sessions': {
    path: 'development-sessions',
    label: 'Development Sessions',
    singular: 'Development session',
    searchable: true,
    titleKey: 'goal',
    fields: [
      { name: 'date', label: 'Date', type: 'date' },
      { name: 'durationMinutes', label: 'Duration (minutes)', type: 'number' },
      { name: 'goal', label: 'Goal', type: 'textarea', rows: 2, required: true },
      { name: 'workedOn', label: 'What I worked on', type: 'textarea', rows: 3 },
      { name: 'completed', label: 'What I completed', type: 'textarea', rows: 3 },
      { name: 'problems', label: 'Problems encountered', type: 'textarea', rows: 3 },
      { name: 'learned', label: 'What I learned', type: 'textarea', rows: 3 },
      { name: 'nextStep', label: 'Next step', type: 'textarea', rows: 2 }
    ],
    columns: [
      { key: 'number', label: '#', kind: 'mono', width: '60px' },
      { key: 'date', label: 'Date', kind: 'date', width: '110px' },
      { key: 'goal', label: 'Goal' },
      { key: 'durationMinutes', label: 'Min', kind: 'number', width: '70px' }
    ]
  },
  'ai-sessions': {
    path: 'ai-sessions',
    label: 'AI Sessions',
    singular: 'AI session',
    searchable: true,
    titleKey: 'purpose',
    fields: [
      { name: 'tool', label: 'AI tool', type: 'text', required: true, placeholder: 'Claude Code, ChatGPT, Codex...' },
      { name: 'model', label: 'Model', type: 'text' },
      { name: 'date', label: 'Date', type: 'date' },
      { name: 'durationMinutes', label: 'Duration (minutes)', type: 'number' },
      { name: 'purpose', label: 'Purpose', type: 'textarea', rows: 2, required: true },
      { name: 'promptText', label: 'Prompt', type: 'textarea', rows: 5 },
      { name: 'responseText', label: 'AI response', type: 'textarea', rows: 5 },
      { name: 'usedFromAI', label: 'What I used', type: 'textarea', rows: 3 },
      { name: 'rejectedFromAI', label: 'What I rejected', type: 'textarea', rows: 3 },
      { name: 'changesMade', label: 'Changes made', type: 'textarea', rows: 3 },
      { name: 'result', label: 'Result', type: 'select', options: PROMPT_RESULTS }
    ],
    columns: [
      { key: 'number', label: '#', kind: 'mono', width: '60px' },
      { key: 'tool', label: 'Tool', width: '140px' },
      { key: 'purpose', label: 'Purpose' },
      { key: 'result', label: 'Result', kind: 'badge', width: '150px' },
      { key: 'date', label: 'Date', kind: 'date', width: '105px' }
    ],
    filters: [{ name: 'result', label: 'Result', type: 'select', options: PROMPT_RESULTS }]
  },
  prompts: {
    path: 'prompts',
    label: 'AI Prompts',
    singular: 'Prompt',
    taggable: true,
    searchable: true,
    titleKey: 'title',
    fields: [
      { name: 'code', label: 'Code', type: 'text', placeholder: 'auto (PROMPT-001)' },
      { name: 'title', label: 'Title', type: 'text' },
      { name: 'status', label: 'Status', type: 'select', options: PROMPT_STATUSES },
      { name: 'isReusable', label: 'Reusable template', type: 'boolean', options: ['true', 'false'] },
      { name: 'category', label: 'Category', type: 'select', options: PROMPT_CATEGORIES },
      { name: 'stage', label: 'Stage', type: 'select', options: STAGES },
      { name: 'tool', label: 'AI tool', type: 'text' },
      { name: 'model', label: 'Model', type: 'text' },
      { name: 'date', label: 'Date', type: 'date' },
      { name: 'taskId', label: 'Related task', type: 'relation', relation: { resource: 'tasks', labelKey: 'title' } },
      { name: 'featureId', label: 'Related feature', type: 'relation', relation: { resource: 'features', labelKey: 'name' } },
      { name: 'issueId', label: 'Related issue', type: 'relation', relation: { resource: 'issues', labelKey: 'title' } },
      { name: 'result', label: 'Result', type: 'select', options: PROMPT_RESULTS },
      { name: 'resultNote', label: 'Why it failed / what fixed it', type: 'textarea', rows: 3 },
      { name: 'purpose', label: 'Purpose', type: 'textarea', rows: 2 },
      { name: 'text', label: 'Prompt text', type: 'textarea', rows: 7, required: true },
      { name: 'response', label: 'AI response', type: 'textarea', rows: 6 },
      { name: 'tags', label: 'Tags', type: 'tags' }
    ],
    columns: [
      { key: 'code', label: 'Code', kind: 'mono', width: '110px' },
      { key: 'title', label: 'Prompt' },
      { key: 'status', label: 'Status', kind: 'badge', width: '105px' },
      { key: 'category', label: 'Category', width: '120px' },
      { key: 'isReusable', label: 'Template', kind: 'bool', width: '85px' },
      { key: 'tool', label: 'Tool', width: '120px' },
      { key: 'result', label: 'Result', kind: 'badge', width: '150px' },
      { key: 'date', label: 'Date', kind: 'date', width: '105px' }
    ],
    filters: [
      { name: 'status', label: 'Status', type: 'select', options: PROMPT_STATUSES },
      { name: 'result', label: 'Result', type: 'select', options: PROMPT_RESULTS },
      { name: 'category', label: 'Category', type: 'select', options: PROMPT_CATEGORIES },
      { name: 'isReusable', label: 'Reusable', type: 'select', options: ['true', 'false'] }
    ]
  },
  documents: {
    path: 'documents',
    label: 'Documentation',
    singular: 'Document',
    taggable: true,
    searchable: true,
    titleKey: 'title',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'type', label: 'Type', type: 'select', options: DOC_TYPES },
      { name: 'content', label: 'Content (Markdown)', type: 'textarea', rows: 14 },
      { name: 'reason', label: 'Change reason', type: 'text', placeholder: 'optional, for new versions' },
      { name: 'tags', label: 'Tags', type: 'tags' }
    ],
    columns: [
      { key: 'title', label: 'Document' },
      { key: 'type', label: 'Type', kind: 'badge', width: '180px' },
      { key: 'currentVersion', label: 'Ver', kind: 'number', width: '60px' },
      { key: 'updatedAt', label: 'Updated', kind: 'datetime', width: '140px' }
    ],
    filters: [{ name: 'type', label: 'Type', type: 'select', options: DOC_TYPES }]
  },
  notes: {
    path: 'notes',
    label: 'Notes',
    singular: 'Note',
    taggable: true,
    searchable: true,
    titleKey: 'title',
    fields: [
      { name: 'title', label: 'Title', type: 'text' },
      { name: 'content', label: 'Content', type: 'textarea', rows: 8 },
      { name: 'tags', label: 'Tags', type: 'tags' }
    ],
    columns: [
      { key: 'title', label: 'Note' },
      { key: 'updatedAt', label: 'Updated', kind: 'datetime', width: '140px' }
    ]
  },
  deployments: {
    path: 'deployments',
    label: 'Deployments',
    singular: 'Deployment',
    searchable: true,
    titleKey: 'version',
    fields: [
      { name: 'environment', label: 'Environment', type: 'select', options: DEPLOY_ENVS },
      { name: 'version', label: 'Version', type: 'text' },
      { name: 'platform', label: 'Platform', type: 'text', placeholder: 'Vercel, Fly.io, VPS...' },
      { name: 'url', label: 'URL', type: 'url' },
      { name: 'status', label: 'Status', type: 'select', options: DEPLOY_STATUSES },
      { name: 'date', label: 'Date', type: 'date' },
      { name: 'commitHash', label: 'Commit hash', type: 'text' },
      { name: 'commitMessage', label: 'Commit message', type: 'text' },
      { name: 'branch', label: 'Branch', type: 'text' },
      { name: 'pullRequest', label: 'Pull request', type: 'text' },
      { name: 'tag', label: 'Tag / release', type: 'text' },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 3 }
    ],
    columns: [
      { key: 'environment', label: 'Env', kind: 'badge', width: '120px' },
      { key: 'version', label: 'Version', kind: 'mono', width: '100px' },
      { key: 'platform', label: 'Platform', width: '120px' },
      { key: 'status', label: 'Status', kind: 'badge', width: '120px' },
      { key: 'date', label: 'Date', kind: 'date', width: '110px' }
    ],
    filters: [
      { name: 'environment', label: 'Environment', type: 'select', options: DEPLOY_ENVS },
      { name: 'status', label: 'Status', type: 'select', options: DEPLOY_STATUSES }
    ]
  },
  incidents: {
    path: 'incidents',
    label: 'Production Incidents',
    singular: 'Incident',
    searchable: true,
    titleKey: 'title',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'severity', label: 'Severity', type: 'select', options: SEVERITIES },
      { name: 'status', label: 'Status', type: 'select', options: INCIDENT_STATUSES },
      { name: 'startedAt', label: 'Started at', type: 'date' },
      { name: 'description', label: 'Description', type: 'textarea', rows: 4 },
      { name: 'resolution', label: 'Resolution', type: 'textarea', rows: 4 }
    ],
    columns: [
      { key: 'title', label: 'Incident' },
      { key: 'severity', label: 'Severity', kind: 'badge', width: '100px' },
      { key: 'status', label: 'Status', kind: 'badge', width: '120px' },
      { key: 'startedAt', label: 'Started', kind: 'date', width: '110px' }
    ],
    filters: [{ name: 'status', label: 'Status', type: 'select', options: INCIDENT_STATUSES }]
  },
  'git-references': {
    path: 'git-references',
    label: 'Git References',
    singular: 'Git reference',
    searchable: true,
    titleKey: 'commitHash',
    fields: [
      { name: 'kind', label: 'Kind', type: 'select', options: GIT_KINDS },
      { name: 'repositoryUrl', label: 'Repository URL', type: 'url' },
      { name: 'branch', label: 'Branch', type: 'text' },
      { name: 'commitHash', label: 'Commit hash', type: 'text' },
      { name: 'commitMessage', label: 'Commit message', type: 'text' },
      { name: 'pullRequest', label: 'Pull request', type: 'text' },
      { name: 'release', label: 'Release / tag', type: 'text' },
      { name: 'date', label: 'Date', type: 'date' },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 2 }
    ],
    columns: [
      { key: 'kind', label: 'Kind', kind: 'badge', width: '120px' },
      { key: 'commitHash', label: 'Commit', kind: 'mono', width: '110px' },
      { key: 'branch', label: 'Branch', width: '120px' },
      { key: 'release', label: 'Release', width: '110px' },
      { key: 'date', label: 'Date', kind: 'date', width: '105px' }
    ]
  },
  decisions: {
    path: 'decisions',
    label: 'Architecture Decisions',
    singular: 'ADR',
    searchable: true,
    titleKey: 'title',
    fields: [
      { name: 'code', label: 'Code', type: 'text', placeholder: 'auto (ADR-001)' },
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'status', label: 'Status', type: 'select', options: ADR_STATUSES },
      { name: 'decision', label: 'Decision', type: 'textarea', rows: 3 },
      { name: 'context', label: 'Context', type: 'textarea', rows: 3 },
      { name: 'alternatives', label: 'Alternatives (JSON array or list)', type: 'textarea', rows: 3 },
      { name: 'reasoning', label: 'Decision reasoning', type: 'textarea', rows: 4 },
      { name: 'consequences', label: 'Consequences', type: 'textarea', rows: 3 },
      { name: 'supersededById', label: 'Superseded by (ADR)', type: 'relation', relation: { resource: 'decisions', labelKey: 'title' } }
    ],
    columns: [
      { key: 'code', label: 'Code', kind: 'mono', width: '95px' },
      { key: 'title', label: 'Decision' },
      { key: 'status', label: 'Status', kind: 'badge', width: '120px' },
      { key: 'updatedAt', label: 'Updated', kind: 'datetime', width: '140px' }
    ],
    filters: [{ name: 'status', label: 'Status', type: 'select', options: ADR_STATUSES }]
  },
  'tech-stack': {
    path: 'tech-stack',
    label: 'Technology Stack',
    singular: 'Technology',
    titleKey: 'technology',
    fields: [
      { name: 'category', label: 'Category', type: 'select', options: TECH_CATEGORIES },
      { name: 'technology', label: 'Technology', type: 'text', required: true },
      { name: 'version', label: 'Version', type: 'text' },
      { name: 'notes', label: 'Notes', type: 'text' }
    ],
    columns: [
      { key: 'category', label: 'Category', kind: 'badge', width: '120px' },
      { key: 'technology', label: 'Technology' },
      { key: 'version', label: 'Version', kind: 'mono', width: '100px' }
    ]
  },
  'database-tables': {
    path: 'database-tables',
    label: 'Database Design',
    singular: 'Table',
    titleKey: 'name',
    fields: [
      { name: 'name', label: 'Table name', type: 'text', required: true },
      { name: 'purpose', label: 'Purpose', type: 'textarea', rows: 2 },
      { name: 'columns', label: 'Columns (JSON array)', type: 'textarea', rows: 6, placeholder: '[{"name":"id","type":"int","key":"PK"}]' }
    ],
    columns: [
      { key: 'name', label: 'Table', kind: 'mono' },
      { key: 'purpose', label: 'Purpose' }
    ]
  },
  'api-endpoints': {
    path: 'api-endpoints',
    label: 'API Endpoints',
    singular: 'Endpoint',
    searchable: true,
    titleKey: 'path',
    fields: [
      { name: 'method', label: 'Method', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { name: 'path', label: 'Path', type: 'text', required: true, placeholder: '/api/projects' },
      { name: 'description', label: 'Description', type: 'textarea', rows: 2 },
      { name: 'requestBody', label: 'Request body', type: 'textarea', rows: 3 },
      { name: 'response', label: 'Response', type: 'textarea', rows: 3 },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 2 }
    ],
    columns: [
      { key: 'method', label: 'Method', kind: 'mono', width: '90px' },
      { key: 'path', label: 'Path', kind: 'mono' },
      { key: 'description', label: 'Description' }
    ]
  },
  attachments: {
    path: 'attachments',
    label: 'Attachments',
    singular: 'Attachment',
    titleKey: 'filename',
    fields: [
      { name: 'filename', label: 'Filename', type: 'text', required: true },
      { name: 'recordType', label: 'Linked record type', type: 'text', placeholder: 'research, task, issue...' },
      { name: 'recordId', label: 'Linked record ID', type: 'number' },
      { name: 'mimeType', label: 'MIME type', type: 'text' },
      { name: 'sizeBytes', label: 'Size (bytes)', type: 'number' },
      { name: 'storagePath', label: 'Storage path', type: 'text', placeholder: 'future: S3 / local path' }
    ],
    columns: [
      { key: 'filename', label: 'File' },
      { key: 'recordType', label: 'Linked to', width: '140px' },
      { key: 'mimeType', label: 'Type', width: '160px' },
      { key: 'uploadedAt', label: 'Uploaded', kind: 'datetime', width: '140px' }
    ]
  }
};

export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  return value
    .toLowerCase()
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}