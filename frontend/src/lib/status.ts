/**
 * Status colours are theme tokens, never raw hex.
 *
 * `statusColor()` returns a `var(--st-…)` reference so inline styles follow the
 * active theme automatically; `statusSoft()` returns the matching tinted pill
 * background. Both fall back to the neutral `gray` token for unknown values, so
 * a new enum value the day it lands in the database still renders legibly.
 */
export type StatusToken =
  | 'gray'
  | 'slate'
  | 'blue'
  | 'cyan'
  | 'purple'
  | 'yellow'
  | 'orange'
  | 'pink'
  | 'red'
  | 'green';

const STATUS_TOKENS: Record<string, StatusToken> = {
  // lifecycle stages
  IDEA: 'gray',
  RESEARCH: 'cyan',
  PLANNING: 'blue',
  ARCHITECTURE: 'purple',
  BUILDING: 'yellow',
  TESTING: 'orange',
  DEPLOYMENT: 'pink',
  PRODUCTION: 'green',
  MAINTENANCE: 'green',
  PAUSED: 'gray',
  COMPLETED: 'green',
  ARCHIVED: 'slate',
  ABANDONED: 'slate',
  // tasks
  TODO: 'gray',
  IN_PROGRESS: 'blue',
  BLOCKED: 'red',
  CANCELLED: 'slate',
  // priorities / severities
  LOW: 'gray',
  MEDIUM: 'yellow',
  HIGH: 'orange',
  CRITICAL: 'red',
  // issues / requirements / features / milestones
  OPEN: 'red',
  INVESTIGATING: 'yellow',
  FIXING: 'orange',
  RESOLVED: 'green',
  CLOSED: 'slate',
  WONT_FIX: 'slate',
  MONITORING: 'cyan',
  PROPOSED: 'blue',
  APPROVED: 'green',
  IMPLEMENTED: 'green',
  DEFERRED: 'gray',
  REJECTED: 'slate',
  PLANNED: 'gray',
  DROPPED: 'slate',
  DELAYED: 'orange',
  ACCEPTED: 'green',
  SUPERSEDED: 'slate',
  ANSWERED: 'green',
  // prompts
  GENERATED: 'gray',
  SUCCESSFUL: 'green',
  PARTIALLY_SUCCESSFUL: 'yellow',
  FAILED: 'red',
  NEEDS_MODIFICATION: 'orange',
  // deployments
  LOCAL: 'gray',
  DEVELOPMENT: 'blue',
  STAGING: 'yellow',
  QUEUED: 'gray',
  SUCCESSFUL_DEPLOY: 'green',
  ROLLED_BACK: 'orange',
  // git kinds
  REPOSITORY: 'gray',
  COMMIT: 'blue',
  BRANCH: 'purple',
  PULL_REQUEST: 'green',
  RELEASE: 'pink',
  // tech categories
  FRONTEND: 'blue',
  BACKEND: 'green',
  DATABASE: 'yellow',
  HOSTING: 'purple',
  OTHER: 'gray',
  // generic
  FUNCTIONAL: 'blue',
  NON_FUNCTIONAL: 'purple',
  CONSTRAINT: 'yellow',
  PRODUCTION_ENV: 'green'
};

export function statusToken(value: string | null | undefined): StatusToken {
  if (!value) return 'gray';
  return STATUS_TOKENS[value] ?? 'gray';
}

/** `var(--st-blue)` — safe for `color`, `background`, `borderColor`. */
export function statusColor(value: string | null | undefined): string {
  return `var(--st-${statusToken(value)})`;
}

/** `var(--st-blue-soft)` — tinted pill/chip background for the same status. */
export function statusSoft(value: string | null | undefined): string {
  return `var(--st-${statusToken(value)}-soft)`;
}
