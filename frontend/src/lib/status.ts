export const STATUS_COLORS: Record<string, string> = {
  // lifecycle stages
  IDEA: '#8b949e',
  RESEARCH: '#39c5cf',
  PLANNING: '#58a6ff',
  ARCHITECTURE: '#bc8cff',
  BUILDING: '#d29922',
  TESTING: '#db6d28',
  DEPLOYMENT: '#f778ba',
  PRODUCTION: '#3fb950',
  MAINTENANCE: '#3fb950',
  PAUSED: '#8b949e',
  COMPLETED: '#3fb950',
  ARCHIVED: '#6e7681',
  ABANDONED: '#6e7681',
  // tasks
  TODO: '#8b949e',
  IN_PROGRESS: '#58a6ff',
  BLOCKED: '#f85149',
  CANCELLED: '#6e7681',
  // priorities / severities
  LOW: '#8b949e',
  MEDIUM: '#d29922',
  HIGH: '#db6d28',
  CRITICAL: '#f85149',
  // issues / requirements / features / milestones
  OPEN: '#f85149',
  INVESTIGATING: '#d29922',
  FIXING: '#db6d28',
  RESOLVED: '#3fb950',
  CLOSED: '#6e7681',
  WONT_FIX: '#6e7681',
  MONITORING: '#39c5cf',
  PROPOSED: '#58a6ff',
  APPROVED: '#3fb950',
  IMPLEMENTED: '#3fb950',
  DEFERRED: '#8b949e',
  REJECTED: '#6e7681',
  PLANNED: '#8b949e',
  DROPPED: '#6e7681',
  DELAYED: '#db6d28',
  ACCEPTED: '#3fb950',
  SUPERSEDED: '#6e7681',
  ANSWERED: '#3fb950',
  // prompts
  SUCCESSFUL: '#3fb950',
  PARTIALLY_SUCCESSFUL: '#d29922',
  FAILED: '#f85149',
  NEEDS_MODIFICATION: '#db6d28',
  // deployments
  LOCAL: '#8b949e',
  DEVELOPMENT: '#58a6ff',
  STAGING: '#d29922',
  QUEUED: '#8b949e',
  SUCCESSFUL_DEPLOY: '#3fb950',
  ROLLED_BACK: '#db6d28',
  // git kinds
  REPOSITORY: '#8b949e',
  COMMIT: '#58a6ff',
  BRANCH: '#bc8cff',
  PULL_REQUEST: '#3fb950',
  RELEASE: '#f778ba',
  // tech categories
  FRONTEND: '#58a6ff',
  BACKEND: '#3fb950',
  DATABASE: '#d29922',
  HOSTING: '#bc8cff',
  OTHER: '#8b949e',
  // generic
  FUNCTIONAL: '#58a6ff',
  NON_FUNCTIONAL: '#bc8cff',
  CONSTRAINT: '#d29922',
  PRODUCTION_ENV: '#3fb950'
};

export function statusColor(value: string | null | undefined): string {
  if (!value) return '#6e7681';
  return STATUS_COLORS[value] ?? '#8b949e';
}

export function withAlpha(hex: string, alpha: string): string {
  return hex + alpha;
}