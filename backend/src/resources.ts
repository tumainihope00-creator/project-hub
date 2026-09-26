import { z } from 'zod';
import { isoDate, optInt, optStr, optText, reqStr } from './lib/validation.js';
import type { ActivityType, Prisma, PromptResult } from '@prisma/client';

// ---------------------------------------------------------------------------
// Enum value lists (must match Prisma schema)
// ---------------------------------------------------------------------------

export const STAGES = [
  'IDEA', 'RESEARCH', 'PLANNING', 'ARCHITECTURE', 'BUILDING', 'TESTING',
  'DEPLOYMENT', 'PRODUCTION', 'MAINTENANCE', 'PAUSED', 'COMPLETED', 'ARCHIVED', 'ABANDONED'
] as const;

export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'TESTING', 'COMPLETED', 'CANCELLED'] as const;
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const ISSUE_STATUSES = ['OPEN', 'INVESTIGATING', 'FIXING', 'TESTING', 'RESOLVED', 'CLOSED', 'WONT_FIX'] as const;
export const REQUIREMENT_TYPES = ['FUNCTIONAL', 'NON_FUNCTIONAL', 'CONSTRAINT'] as const;
export const REQUIREMENT_STATUSES = ['PROPOSED', 'APPROVED', 'IN_PROGRESS', 'IMPLEMENTED', 'DEFERRED', 'REJECTED'] as const;
export const FEATURE_STATUSES = ['PLANNED', 'BUILDING', 'TESTING', 'COMPLETED', 'DROPPED'] as const;
export const RESEARCH_TYPES = ['TECHNICAL', 'MARKET', 'USER', 'COMPETITOR', 'ACADEMIC', 'SECURITY', 'ARCHITECTURE', 'TECHNOLOGY', 'LEGAL', 'OTHER'] as const;
export const RQ_STATUSES = ['OPEN', 'INVESTIGATING', 'ANSWERED', 'REJECTED'] as const;
export const ADR_STATUSES = ['PROPOSED', 'ACCEPTED', 'SUPERSEDED', 'REJECTED'] as const;
export const MILESTONE_STATUSES = ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'DELAYED', 'CANCELLED'] as const;
export const PROMPT_RESULTS = [
  'GENERATED',
  'SUCCESSFUL',
  'PARTIALLY_SUCCESSFUL',
  'FAILED',
  'REJECTED',
  'NEEDS_MODIFICATION'
] as const;
export const DEPLOY_ENVS = ['LOCAL', 'DEVELOPMENT', 'STAGING', 'PRODUCTION'] as const;
export const DEPLOY_STATUSES = ['QUEUED', 'IN_PROGRESS', 'SUCCESSFUL', 'FAILED', 'ROLLED_BACK'] as const;
export const INCIDENT_STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED', 'MONITORING'] as const;
export const DOC_TYPES = ['README', 'SRS', 'API_DOCUMENTATION', 'USER_GUIDE', 'INSTALLATION_GUIDE', 'ARCHITECTURE_DOCUMENTATION', 'DEPLOYMENT_GUIDE', 'RESEARCH_REPORT', 'OTHER'] as const;
export const RELATION_TYPES = ['RELATED', 'DEPENDS_ON', 'INSPIRED_BY', 'FORKED_FROM', 'REPLACES', 'PART_OF'] as const;
export const TECH_CATEGORIES = ['FRONTEND', 'BACKEND', 'DATABASE', 'HOSTING', 'OTHER'] as const;
export const GIT_KINDS = ['REPOSITORY', 'COMMIT', 'BRANCH', 'PULL_REQUEST', 'RELEASE'] as const;
export const TAG_TYPES = ['project', 'task', 'issue', 'research', 'prompt', 'document', 'note'] as const;

// ---------------------------------------------------------------------------
// Resource definitions
// ---------------------------------------------------------------------------

export interface ResourceDef {
  /** URL path segment under /api/projects/:projectId */
  path: string;
  label: string;
  /** Prisma client delegate name (lowercased model name) */
  model: string;
  /** Prefix used for generated human codes, e.g. "TASK" -> TASK-001 */
  codePrefix?: string;
  /** numeric session numbering (max+1) per project */
  numbered?: boolean;
  taggable?: boolean;
  orderBy?: Record<string, any>;
  searchFields?: string[];
  include?: Record<string, any>;
  createSchema: z.ZodTypeAny;
  updateSchema: z.ZodTypeAny;
  activity: { create?: ActivityType; update?: ActivityType };
  /** extra side effects after insert/update, receives prisma-ready data + context */
  hooks?: {
    beforeCreate?: (input: any, ctx: Ctx) => Promise<any>;
    afterCreate?: (row: any, input: any, ctx: Ctx) => Promise<void>;
    beforeUpdate?: (id: number, input: any, current: any, ctx: Ctx) => Promise<any>;
    afterUpdate?: (row: any, input: any, ctx: Ctx) => Promise<void>;
    afterSave?: (row: any, input: any, ctx: Ctx) => Promise<void>;
  };
  /** Describe a row for activity logging */
  describe?: (row: any) => string;
}

export interface Ctx {
  projectId: number;
  /**
   * Set when the caller is inside a transaction (the document importer is).
   * Hooks must use this client when they write, so their rows join the
   * transaction instead of escaping it. Left undefined by ordinary requests,
   * which keep using the shared Prisma client.
   */
  client?: Prisma.TransactionClient;
}

const enumZ = (values: readonly string[]) => z.enum(values as [string, ...string[]]);

function bindFields<T extends Record<string, any>>(fields: T): z.ZodObject<T> {
  return z.object(fields) as unknown as z.ZodObject<T>;
}

// Per-resource create schemas -------------------------------------------------

const researchCreate = bindFields({
  title: reqStr,
  question: optText,
  type: enumZ(RESEARCH_TYPES).default('OTHER'),
  source: optStr,
  url: optStr,
  summary: optText,
  findings: optText,
  relevance: optText,
  date: isoDate
});

const researchQuestionCreate = bindFields({
  question: reqStr,
  answer: optText,
  status: enumZ(RQ_STATUSES).default('OPEN'),
  category: optStr
});

const requirementCreate = bindFields({
  code: optStr,
  title: reqStr,
  description: optText,
  type: enumZ(REQUIREMENT_TYPES).default('FUNCTIONAL'),
  priority: enumZ(PRIORITIES).default('MEDIUM'),
  status: enumZ(REQUIREMENT_STATUSES).default('PROPOSED')
});

const featureCreate = bindFields({
  name: reqStr,
  description: optText,
  priority: enumZ(PRIORITIES).default('MEDIUM'),
  status: enumZ(FEATURE_STATUSES).default('PLANNED')
});

const milestoneCreate = bindFields({
  name: reqStr,
  description: optText,
  targetDate: isoDate,
  status: enumZ(MILESTONE_STATUSES).default('PLANNED')
});

const taskCreate = bindFields({
  code: optStr,
  title: reqStr,
  description: optText,
  status: enumZ(TASK_STATUSES).default('TODO'),
  priority: enumZ(PRIORITIES).default('MEDIUM'),
  dueDate: isoDate,
  milestoneId: optInt,
  featureId: optInt,
  requirementId: optInt,
  devSessionId: optInt
});

const issueCreate = bindFields({
  code: optStr,
  title: reqStr,
  description: optText,
  severity: enumZ(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  priority: enumZ(PRIORITIES).default('MEDIUM'),
  status: enumZ(ISSUE_STATUSES).default('OPEN'),
  stepsToReproduce: optText,
  expectedBehavior: optText,
  actualBehavior: optText,
  environment: optText,
  possibleCause: optText,
  solution: optText
});

const developmentSessionCreate = bindFields({
  date: isoDate,
  durationMinutes: optInt,
  goal: optText,
  workedOn: optText,
  completed: optText,
  problems: optText,
  learned: optText,
  nextStep: optText
});

const aiSessionCreate = bindFields({
  tool: reqStr,
  model: optStr,
  date: isoDate,
  durationMinutes: optInt,
  purpose: optText,
  promptText: optText,
  responseText: optText,
  usedFromAI: optText,
  rejectedFromAI: optText,
  changesMade: optText,
  result: enumZ(PROMPT_RESULTS).default('SUCCESSFUL')
});

const promptCreate = bindFields({
  code: optStr,
  title: optStr,
  purpose: optText,
  category: optStr,
  stage: enumZ(STAGES).optional().nullable(),
  tool: optStr,
  model: optStr,
  date: isoDate,
  taskId: optInt,
  featureId: optInt,
  issueId: optInt,
  result: enumZ(PROMPT_RESULTS).default('PARTIALLY_SUCCESSFUL'),
  resultNote: optText,
  text: reqStr,
  response: optText
});

const documentCreate = bindFields({
  type: enumZ(DOC_TYPES).default('OTHER'),
  title: reqStr,
  content: optText,
  reason: optStr
});

const noteCreate = bindFields({
  title: optStr,
  content: optText
});

const deploymentCreate = bindFields({
  environment: enumZ(DEPLOY_ENVS).default('DEVELOPMENT'),
  version: optStr,
  platform: optStr,
  url: optStr,
  commitHash: optStr,
  commitMessage: optStr,
  branch: optStr,
  pullRequest: optStr,
  tag: optStr,
  date: isoDate,
  status: enumZ(DEPLOY_STATUSES).default('QUEUED'),
  notes: optText
});

const incidentCreate = bindFields({
  title: reqStr,
  description: optText,
  severity: enumZ(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('HIGH'),
  status: enumZ(INCIDENT_STATUSES).default('OPEN'),
  startedAt: isoDate,
  resolution: optText
});

const gitReferenceCreate = bindFields({
  kind: enumZ(GIT_KINDS).default('COMMIT'),
  repositoryUrl: optStr,
  branch: optStr,
  commitHash: optStr,
  commitMessage: optStr,
  pullRequest: optStr,
  release: optStr,
  date: isoDate,
  notes: optText
});

const decisionCreate = bindFields({
  code: optStr,
  title: reqStr,
  decision: optText,
  context: optText,
  alternatives: optText,
  reasoning: optText,
  consequences: optText,
  status: enumZ(ADR_STATUSES).default('PROPOSED'),
  supersededById: optInt
});

const techStackCreate = bindFields({
  category: enumZ(TECH_CATEGORIES).default('OTHER'),
  technology: reqStr,
  version: optStr,
  notes: optStr
});

const databaseTableCreate = bindFields({
  name: reqStr,
  purpose: optText,
  columns: optText
});

const apiEndpointCreate = bindFields({
  method: reqStr,
  path: reqStr,
  description: optText,
  requestBody: optText,
  response: optText,
  notes: optText
});

const attachmentCreate = bindFields({
  recordType: reqStr,
  recordId: optInt,
  filename: reqStr,
  mimeType: optStr,
  sizeBytes: optInt,
  storagePath: optStr
});

const partial = (schema: z.ZodObject<any>) => schema.partial().strict();

// Resources --------------------------------------------------------------

export const RESOURCES: ResourceDef[] = [
  {
    path: 'research',
    label: 'Research',
    model: 'researchEntry',
    taggable: true,
    orderBy: { date: 'desc' },
    searchFields: ['title', 'summary', 'findings', 'url'],
    createSchema: researchCreate,
    updateSchema: partial(researchCreate),
    activity: { create: 'RESEARCH_ADDED', update: 'RESEARCH_UPDATED' },
    describe: r => r.title
  },
  {
    path: 'research-questions',
    label: 'Research Question',
    model: 'researchQuestion',
    orderBy: { createdAt: 'desc' },
    searchFields: ['question', 'answer'],
    createSchema: researchQuestionCreate,
    updateSchema: partial(researchQuestionCreate),
    activity: { create: 'RESEARCH_QUESTION_ADDED', update: 'RESEARCH_QUESTION_UPDATED' },
    describe: r => r.question
  },
  {
    path: 'requirements',
    label: 'Requirement',
    model: 'requirement',
    codePrefix: 'REQ',
    orderBy: { code: 'asc' },
    searchFields: ['title', 'description', 'code'],
    createSchema: requirementCreate,
    updateSchema: partial(requirementCreate),
    activity: { create: 'REQUIREMENT_CREATED', update: 'REQUIREMENT_UPDATED' },
    describe: r => `${r.code} ${r.title}`
  },
  {
    path: 'features',
    label: 'Feature',
    model: 'feature',
    orderBy: { name: 'asc' },
    searchFields: ['name', 'description'],
    createSchema: featureCreate,
    updateSchema: partial(featureCreate),
    activity: { create: 'FEATURE_CREATED', update: 'FEATURE_UPDATED' },
    describe: r => r.name
  },
  {
    path: 'milestones',
    label: 'Milestone',
    model: 'milestone',
    orderBy: { targetDate: 'asc' },
    createSchema: milestoneCreate,
    updateSchema: partial(milestoneCreate),
    activity: { create: 'MILESTONE_CREATED', update: 'MILESTONE_CREATED' },
    describe: r => r.name
  },
  {
    path: 'tasks',
    label: 'Task',
    model: 'task',
    codePrefix: 'TASK',
    taggable: true,
    orderBy: { createdAt: 'desc' },
    searchFields: ['title', 'description', 'code'],
    include: {
      milestone: { select: { id: true, name: true } },
      feature: { select: { id: true, name: true, status: true } },
      requirement: { select: { id: true, code: true, title: true } }
    },
    createSchema: taskCreate,
    updateSchema: partial(taskCreate),
    activity: { create: 'TASK_CREATED', update: 'TASK_UPDATED' },
    hooks: {
      afterUpdate: async (row, input, ctx) => {
        if (input.status === 'COMPLETED' && row.status === 'COMPLETED') {
          await import('./lib/activity.js').then(m =>
            m.logActivity(
              {
                projectId: row.projectId,
                type: 'TASK_COMPLETED',
                description: `Task ${row.code || row.id} completed: ${row.title}`,
                relatedType: 'task',
                relatedId: row.id
              },
              ctx.client
            )
          );
        }
      },
      afterCreate: async (row, input, ctx) => {
        if (input.status === 'COMPLETED') {
          await import('./lib/activity.js').then(m =>
            m.logActivity(
              {
                projectId: row.projectId,
                type: 'TASK_COMPLETED',
                description: `Task ${row.code || row.id} completed on creation: ${row.title}`,
                relatedType: 'task',
                relatedId: row.id
              },
              ctx.client
            )
          );
        }
      }
    },
    describe: r => `${r.code} ${r.title}`
  },
  {
    path: 'issues',
    label: 'Issue',
    model: 'issue',
    codePrefix: 'ISSUE',
    taggable: true,
    orderBy: { createdAt: 'desc' },
    searchFields: ['title', 'description', 'code', 'solution'],
    createSchema: issueCreate,
    updateSchema: partial(issueCreate),
    activity: { create: 'ISSUE_CREATED', update: 'ISSUE_UPDATED' },
    hooks: {
      afterUpdate: async (row, _input) => {
        if (['RESOLVED', 'CLOSED', 'WONT_FIX'].includes(row.status)) {
          await import('./lib/activity.js').then(m =>
            m.logActivity({
              projectId: row.projectId,
              type: 'ISSUE_RESOLVED',
              description: `Issue ${row.code || row.id} ${row.status === 'WONT_FIX' ? 'rejected' : 'resolved'}: ${row.title}`,
              relatedType: 'issue',
              relatedId: row.id
            })
          );
        }
      }
    },
    describe: r => `${r.code} ${r.title}`
  },
  {
    path: 'development-sessions',
    label: 'Development Session',
    model: 'developmentSession',
    numbered: true,
    orderBy: { date: 'desc' },
    createSchema: developmentSessionCreate,
    updateSchema: partial(developmentSessionCreate),
    activity: { create: 'DEVELOPMENT_SESSION_RECORDED', update: 'DEVELOPMENT_SESSION_RECORDED' },
    describe: r => `Session #${r.number}`
  },
  {
    path: 'ai-sessions',
    label: 'AI Session',
    model: 'aiSession',
    numbered: true,
    orderBy: { date: 'desc' },
    createSchema: aiSessionCreate,
    updateSchema: partial(aiSessionCreate),
    activity: { create: 'AI_SESSION_RECORDED', update: 'AI_SESSION_RECORDED' },
    describe: r => `Session #${r.number} (${r.tool})`
  },
  {
    path: 'prompts',
    label: 'Prompt',
    model: 'prompt',
    codePrefix: 'PROMPT',
    taggable: true,
    orderBy: { date: 'desc' },
    searchFields: ['title', 'purpose', 'resultNote'],
    include: {
      versions: { orderBy: { version: 'asc' } },
      task: { select: { id: true, code: true, title: true } },
      feature: { select: { id: true, name: true } },
      issue: { select: { id: true, code: true, title: true } }
    },
    createSchema: promptCreate,
    updateSchema: partial(promptCreate),
    activity: { create: 'PROMPT_RECORDED', update: 'PROMPT_RECORDED' },
    hooks: {
      afterCreate: async (row, _input, ctx) => {
        await import('./lib/activity.js').then(m =>
          m.logActivity(
            {
              projectId: row.projectId,
              type: 'PROMPT_VERSIONED',
              description: `Initial version v1 recorded for prompt ${row.code}`,
              relatedType: 'prompt',
              relatedId: row.id
            },
            ctx.client
          )
        );
      }
    },
    describe: r => `${r.code} ${r.title ?? r.purpose ?? ''}`.trim()
  },
  {
    path: 'documents',
    label: 'Document',
    model: 'projectDocument',
    taggable: true,
    orderBy: { updatedAt: 'desc' },
    searchFields: ['title'],
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    createSchema: documentCreate,
    updateSchema: partial(documentCreate),
    activity: { create: 'DOCUMENT_CREATED', update: 'DOCUMENT_UPDATED' },
    describe: r => r.title
  },
  {
    path: 'notes',
    label: 'Note',
    model: 'note',
    taggable: true,
    orderBy: { updatedAt: 'desc' },
    searchFields: ['title', 'content'],
    createSchema: noteCreate,
    updateSchema: partial(noteCreate),
    activity: { create: 'NOTE_CREATED', update: 'NOTE_UPDATED' },
    describe: r => r.title ?? 'note'
  },
  {
    path: 'deployments',
    label: 'Deployment',
    model: 'deployment',
    orderBy: { date: 'desc' },
    searchFields: ['version', 'platform', 'url', 'notes', 'commitHash'],
    createSchema: deploymentCreate,
    updateSchema: partial(deploymentCreate),
    activity: { create: 'DEPLOYMENT_CREATED', update: 'DEPLOYMENT_UPDATED' },
    describe: r => `${r.environment} ${r.version ?? ''}`.trim()
  },
  {
    path: 'incidents',
    label: 'Production Incident',
    model: 'productionIncident',
    orderBy: { startedAt: 'desc' },
    searchFields: ['title', 'description', 'resolution'],
    createSchema: incidentCreate,
    updateSchema: partial(incidentCreate),
    activity: { create: 'PRODUCTION_INCIDENT_CREATED', update: 'PRODUCTION_INCIDENT_RESOLVED' },
    hooks: {
      afterUpdate: async (row, _input, ctx) => {
        if (row.status === 'RESOLVED' || row.status === 'CLOSED') {
          await import('./lib/activity.js').then(m =>
            m.logActivity(
              {
                projectId: row.projectId,
                type: 'PRODUCTION_INCIDENT_RESOLVED',
                description: `Production incident resolved: ${row.title}`,
                relatedType: 'productionIncident',
                relatedId: row.id
              },
              ctx.client
            )
          );
        }
      }
    },
    describe: r => r.title
  },
  {
    path: 'git-references',
    label: 'Git Reference',
    model: 'gitReference',
    orderBy: { date: 'desc' },
    searchFields: ['commitHash', 'commitMessage', 'branch', 'release', 'notes'],
    createSchema: gitReferenceCreate,
    updateSchema: partial(gitReferenceCreate),
    activity: { create: 'GIT_REFERENCE_ADDED', update: 'GIT_REFERENCE_ADDED' },
    describe: r => `${r.kind} ${r.commitHash ?? r.branch ?? r.release ?? ''}`.trim()
  },
  {
    path: 'decisions',
    label: 'Architecture Decision',
    model: 'architectureDecision',
    codePrefix: 'ADR',
    orderBy: { createdAt: 'desc' },
    searchFields: ['title', 'decision', 'context', 'reasoning'],
    createSchema: decisionCreate,
    updateSchema: partial(decisionCreate),
    activity: { create: 'ADR_CREATED', update: 'ADR_UPDATED' },
    hooks: {
      afterSave: async (row, input, ctx) => {
        if (input.supersededById) {
          // Prefer the caller's transaction client so a supersede cannot leave
          // a half-applied change behind when the surrounding write rolls back.
          const client = ctx.client ?? (await import('./lib/prisma.js')).prisma;
          const { logActivity } = await import('./lib/activity.js');
          await client.architectureDecision.update({
            where: { id: Number(input.supersededById) },
            data: { status: 'SUPERSEDED' }
          });
          await logActivity(
            {
              projectId: row.projectId,
              type: 'ADR_UPDATED',
              description: `${row.code} marked ADR ${String(input.supersededById)} as superseded`,
              relatedType: 'architectureDecision',
              relatedId: row.id
            },
            ctx.client
          );
        }
      }
    },
    describe: r => `${r.code} ${r.title}`
  },
  {
    path: 'tech-stack',
    label: 'Technology Stack',
    model: 'techStackItem',
    orderBy: { category: 'asc' },
    createSchema: techStackCreate,
    updateSchema: partial(techStackCreate),
    activity: { create: 'PROJECT_UPDATED', update: 'PROJECT_UPDATED' },
    describe: r => `${r.category} ${r.technology}`
  },
  {
    path: 'database-tables',
    label: 'Database Table',
    model: 'databaseTable',
    createSchema: databaseTableCreate,
    updateSchema: partial(databaseTableCreate),
    activity: { create: 'PROJECT_UPDATED', update: 'PROJECT_UPDATED' },
    describe: r => r.name
  },
  {
    path: 'api-endpoints',
    label: 'API Endpoint',
    model: 'apiEndpoint',
    orderBy: { path: 'asc' },
    searchFields: ['path', 'description'],
    createSchema: apiEndpointCreate,
    updateSchema: partial(apiEndpointCreate),
    activity: { create: 'PROJECT_UPDATED', update: 'PROJECT_UPDATED' },
    describe: r => `${r.method} ${r.path}`
  },
  {
    path: 'attachments',
    label: 'Attachment',
    model: 'attachment',
    orderBy: { uploadedAt: 'desc' },
    createSchema: attachmentCreate,
    updateSchema: partial(attachmentCreate),
    activity: { create: 'PROJECT_UPDATED', update: 'PROJECT_UPDATED' },
    describe: r => r.filename
  }
];

export function findResource(path: string): ResourceDef | undefined {
  return RESOURCES.find(r => r.path === path);
}

export function promptResultValue(value: PromptResult): string {
  return value;
}