import { prisma } from './prisma.js';
import { collectGenerationData } from './generator/collect.js';
import type { SourceFailure } from './generator/types.js';

/**
 * Phase 8: the reusable project context builder and the prompt draft generator.
 *
 * Two jobs, one file:
 *
 * 1. `buildPromptContext` — read the project's records into a single provider-
 *    agnostic structure (with presence flags) that any prompt tooling can consume.
 *    It reuses `lib/generator/collect.ts`, the V1 generator's collector, so both
 *    generators share one resilient read layer (a failed source degrades to an
 *    empty list plus a recorded failure instead of killing the request), and adds
 *    the sections only Phase 8 needs: issues, milestones, deployments and the
 *    project's reusable prompts.
 *
 * 2. `buildPromptDraft` / `buildPromptReadiness` — turn that context into a
 *    draft prompt for one of the supported purposes, plus a checklist of what the
 *    project has and has not recorded.
 *
 * This module never calls an AI provider, never stores anything and never
 * invents project facts: every line of a draft is copied from a record, and
 * every absent record is stated as `Not provided in Project Hub.` so a missing
 * section can never be mistaken for real content.
 */

/** The purposes the generic generator supports. */
export const PROMPT_PURPOSES = [
  'Research',
  'Architecture',
  'Feature implementation',
  'Debugging',
  'Refactoring',
  'Testing',
  'Documentation',
  'Deployment'
] as const;

export type PromptPurpose = (typeof PROMPT_PURPOSES)[number];

/** The sections of project data a draft can draw on, in checklist order. */
export const CONTEXT_KEYS = [
  'description',
  'problem',
  'requirements',
  'features',
  'tasks',
  'issues',
  'decisions',
  'techStack',
  'milestones',
  'deployments',
  'notes',
  'research'
] as const;

export type ContextKey = (typeof CONTEXT_KEYS)[number];

const CONTEXT_LABELS: Record<ContextKey, string> = {
  description: 'Project description',
  problem: 'Problem statement',
  requirements: 'Requirements',
  features: 'Features',
  tasks: 'Tasks',
  issues: 'Issues',
  decisions: 'Architecture decisions',
  techStack: 'Technology stack',
  milestones: 'Milestones',
  deployments: 'Deployment history',
  notes: 'Project notes',
  research: 'Research entries'
};

/**
 * What each purpose needs from the project before a draft is worth sending.
 * Only `required` items block the "ready" verdict; `recommended` items are
 * listed so the user can see what would strengthen the prompt, but they never
 * appear in `missingRequired`.
 */
const PURPOSE_NEEDS: Record<PromptPurpose, { required: ContextKey[]; recommended: ContextKey[] }> = {
  Research: {
    required: ['description', 'problem'],
    recommended: ['research', 'notes', 'requirements']
  },
  Architecture: {
    required: ['description', 'requirements'],
    recommended: ['decisions', 'techStack', 'features']
  },
  'Feature implementation': {
    required: ['description', 'requirements'],
    recommended: ['features', 'tasks', 'techStack']
  },
  Debugging: {
    required: ['description'],
    recommended: ['issues', 'tasks', 'notes']
  },
  Refactoring: {
    required: ['description'],
    recommended: ['techStack', 'decisions', 'tasks']
  },
  Testing: {
    required: ['description', 'requirements'],
    recommended: ['tasks', 'features']
  },
  Documentation: {
    required: ['description'],
    recommended: ['requirements', 'features', 'research', 'notes']
  },
  Deployment: {
    required: ['description'],
    recommended: ['deployments', 'decisions', 'techStack', 'milestones']
  }
};

/** The suggested prompt category a draft of this purpose is saved under. */
const PURPOSE_CATEGORY: Record<PromptPurpose, string> = {
  Research: 'Research',
  Architecture: 'Architecture',
  'Feature implementation': 'Coding',
  Debugging: 'Debugging',
  Refactoring: 'Refactoring',
  Testing: 'Testing',
  Documentation: 'Documentation',
  Deployment: 'Deployment'
};

/**
 * The instruction that opens every draft. It is guidance about how to treat the
 * context - ask instead of inventing - not a statement about the project, so it
 * is safe to include even for a project with no data at all.
 */
const PURPOSE_INSTRUCTIONS: Record<PromptPurpose, string> = {
  Research:
    'You are assisting with research for the project below. Ground every statement in the recorded project information; when the project has not recorded something you need, ask for it instead of assuming it.',
  Architecture:
    'You are acting as the software architect for the project below. Base your design on the recorded requirements, decisions and technology stack; list anything that must be decided before the design can be finalized.',
  'Feature implementation':
    'You are a senior developer implementing work for the project below. Use only the recorded requirements, features and tasks; when a detail you need is missing, request it rather than inventing it.',
  Debugging:
    'You are debugging the project below. Work from the recorded issues, tasks and notes; state which reproduction details you need when they are not recorded.',
  Refactoring:
    'You are refactoring parts of the project below. Stay within the recorded technology stack and architecture decisions, and call out anything that would change a recorded decision.',
  Testing:
    'You are designing tests for the project below. Derive coverage from the recorded requirements and features; ask for missing acceptance criteria instead of assuming them.',
  Documentation:
    'You are writing documentation for the project below. Use only the recorded project information and mark anything unrecorded as unknown rather than guessing it.',
  Deployment:
    'You are preparing or reviewing a deployment for the project below. Use the recorded deployment history, stack and decisions, and ask for missing environment details instead of assuming them.'
};

/** The line that stands in for any record the project does not have. */
export const NOT_PROVIDED = 'Not provided in Project Hub.';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface PromptContext {
  project: {
    id: number;
    name: string;
    slug: string;
    stage: string;
    description: string | null;
    problem: string | null;
    repositoryUrl: string | null;
  };
  tags: string[];
  requirements: { code: string; title: string; type: string; priority: string; status: string; description: string | null }[];
  features: { name: string; priority: string; status: string; description: string | null }[];
  tasks: { code: string; title: string; status: string; description: string | null }[];
  issues: { code: string; title: string; status: string; severity: string; description: string | null }[];
  decisions: { code: string; title: string; decision: string | null; status: string }[];
  techStack: { category: string; technology: string; version: string | null; notes: string | null }[];
  milestones: { name: string; status: string; targetDate: Date | null; description: string | null }[];
  deployments: { environment: string; status: string; version: string | null; date: Date; url: string | null }[];
  notes: { title: string | null; content: string }[];
  research: { title: string; type: string; summary: string | null }[];
  reusablePrompts: { code: string; title: string | null; category: string | null; purpose: string | null }[];
  /** Does each section have anything recorded? Drives the readiness checklist. */
  presence: Record<ContextKey, boolean>;
}

/** A collection that failed. Mirrors the V1 collector's degraded-read behaviour. */
async function readExtra<T>(
  failures: SourceFailure[],
  key: string,
  label: string,
  run: () => Promise<T[]>
): Promise<T[]> {
  try {
    return await run();
  } catch (e) {
    failures.push({
      source: key,
      reason: e instanceof Error && e.message ? e.message : String(e),
      operation: `read ${label}`,
      action: 'Retry. If it keeps failing, the database may be unavailable.'
    });
    return [];
  }
}

/**
 * Read everything the prompt tooling needs for one project.
 *
 * Throws only when the project itself does not exist (the collector's 404) -
 * missing project *data* is never an error here, it is a presence flag.
 */
export async function buildPromptContext(
  projectId: number
): Promise<{ context: PromptContext; failures: SourceFailure[] }> {
  const { context: base, failures } = await collectGenerationData(projectId);

  const [issues, milestones, deployments, reusablePrompts] = await Promise.all([
    readExtra(failures, 'issues', 'issues', () =>
      prisma.issue.findMany({
        where: { projectId },
        orderBy: { updatedAt: 'desc' },
        take: 100
      })
    ),
    readExtra(failures, 'milestones', 'milestones', () =>
      prisma.milestone.findMany({ where: { projectId }, orderBy: { targetDate: 'asc' } })
    ),
    readExtra(failures, 'deployments', 'deployments', () =>
      prisma.deployment.findMany({ where: { projectId }, orderBy: { date: 'desc' }, take: 100 })
    ),
    readExtra(failures, 'reusablePrompts', 'reusable prompts', () =>
      // Archived prompts are kept for history but stay out of active lists,
      // which is what this section of the context feeds.
      prisma.prompt.findMany({
        where: { projectId, isReusable: true, status: { not: 'ARCHIVED' } },
        orderBy: { title: 'asc' },
        select: { code: true, title: true, category: true, purpose: true }
      })
    )
  ]);

  const nonEmpty = (s: string | null | undefined): boolean => !!s && s.trim().length > 0;

  const context: PromptContext = {
    project: {
      id: projectId,
      name: base.project.name,
      slug: base.project.slug,
      stage: base.project.stage,
      description: base.project.description,
      problem: base.project.problem,
      repositoryUrl: base.project.repositoryUrl
    },
    tags: base.tags,
    requirements: base.requirements.map(r => ({
      code: r.code,
      title: r.title,
      type: r.type,
      priority: r.priority,
      status: r.status,
      description: r.description
    })),
    features: base.features.map(f => ({
      name: f.name,
      priority: f.priority,
      status: f.status,
      description: f.description
    })),
    tasks: base.tasks.map(t => ({
      code: t.code,
      title: t.title,
      status: t.status,
      description: t.description
    })),
    issues: issues.map(i => ({
      code: i.code,
      title: i.title,
      status: i.status,
      severity: i.severity,
      description: i.description
    })),
    decisions: base.decisions.map(d => ({
      code: d.code,
      title: d.title,
      decision: d.decision,
      status: d.status
    })),
    techStack: base.techStack.map(t => ({
      category: t.category,
      technology: t.technology,
      version: t.version,
      notes: t.notes
    })),
    milestones: milestones.map(m => ({
      name: m.name,
      status: m.status,
      targetDate: m.targetDate,
      description: m.description
    })),
    deployments: deployments.map(d => ({
      environment: d.environment,
      status: d.status,
      version: d.version,
      date: d.date,
      url: d.url
    })),
    notes: base.notes.map(n => ({ title: n.title, content: n.content })),
    research: base.research.map(r => ({
      title: r.title,
      type: r.type,
      summary: r.summary
    })),
    reusablePrompts,
    presence: {
      description: nonEmpty(base.project.description),
      problem: nonEmpty(base.project.problem),
      requirements: base.requirements.length > 0,
      features: base.features.length > 0,
      tasks: base.tasks.length > 0,
      issues: issues.length > 0,
      decisions: base.decisions.length > 0,
      techStack: base.techStack.length > 0,
      milestones: milestones.length > 0,
      deployments: deployments.length > 0,
      notes: base.notes.some(n => nonEmpty(n.content) || nonEmpty(n.title)),
      research: base.research.length > 0
    }
  };

  return { context, failures };
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export interface PromptReadinessItem {
  key: ContextKey;
  label: string;
  required: boolean;
  present: boolean;
}

export interface PromptReadinessReport {
  purpose: PromptPurpose;
  /** True when every required item is present. */
  ready: boolean;
  /** Every expected item, required ones first, each with its verdict. */
  items: PromptReadinessItem[];
  /** Required items with nothing recorded. Empty when ready. */
  missingRequired: ContextKey[];
  /** Recommended (non-blocking) items with nothing recorded. */
  missingRecommended: ContextKey[];
}

/**
 * Evaluate one purpose against the project's records. Pure function of the
 * context, so the checklist the API returns and the sections the draft renders
 * can never disagree about what exists.
 */
export function buildPromptReadiness(context: PromptContext, purpose: PromptPurpose): PromptReadinessReport {
  const needs = PURPOSE_NEEDS[purpose];
  const itemFor = (key: ContextKey, required: boolean): PromptReadinessItem => ({
    key,
    label: CONTEXT_LABELS[key],
    required,
    present: context.presence[key]
  });

  const items = [
    ...needs.required.map(k => itemFor(k, true)),
    ...needs.recommended.map(k => itemFor(k, false))
  ];
  const missingRequired = items.filter(i => i.required && !i.present).map(i => i.key);
  const missingRecommended = items.filter(i => !i.required && !i.present).map(i => i.key);

  return {
    purpose,
    ready: missingRequired.length === 0,
    items,
    missingRequired,
    missingRecommended
  };
}

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export interface PromptDraft {
  title: string;
  category: string;
  purpose: PromptPurpose;
  content: string;
}

/** Collapse a multi-line value into one line so it fits a bullet. */
function flat(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.replace(/\s*\n\s*/g, ' ').trim();
  return text.length > 0 ? text : null;
}

/** Cap a long value without pretending it was shorter than it is. */
function clipped(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max).trimEnd()}… [truncated]`;
}

function bullet(value: string | null | undefined): string {
  return `- ${flat(value) ?? NOT_PROVIDED}`;
}

/** Render a list section: one bullet per record, or the marker when empty. */
function listSection(items: string[], more: number): string {
  if (items.length === 0) return NOT_PROVIDED;
  const lines = [...items];
  if (more > 0) lines.push(`- … and ${more} more not shown.`);
  return lines.join('\n');
}

const DRAFT_LIMITS = {
  requirements: 100,
  features: 50,
  tasks: 50,
  issues: 50,
  decisions: 30,
  techStack: 50,
  milestones: 20,
  deployments: 20,
  notes: 10,
  research: 20
} as const;

/**
 * Build the draft prompt for a purpose.
 *
 * Every section is either copied from the records or explicitly marked
 * `Not provided in Project Hub.` - there is no code path that fills a gap with
 * plausible-sounding text, which is what "no fabrication" means here. The draft
 * is returned, not saved: saving (with whatever readiness gaps the user chose
 * to proceed with) is an ordinary prompt create on top of it.
 */
export function buildPromptDraft(context: PromptContext, purpose: PromptPurpose): PromptDraft {
  const p = context.project;
  const take = <T>(items: T[], limit: number): { shown: T[]; more: number } => ({
    shown: items.slice(0, limit),
    more: Math.max(0, items.length - limit)
  });

  const requirements = take(
    context.requirements.map(r =>
      `- ${r.code} ${r.title} [${r.type}, ${r.priority}, ${r.status}]${r.description ? `: ${clipped(flat(r.description)!, 300)}` : ''}`
    ),
    DRAFT_LIMITS.requirements
  );
  const features = take(
    context.features.map(f =>
      `- ${f.name} [${f.priority}, ${f.status}]${f.description ? `: ${clipped(flat(f.description)!, 300)}` : ''}`
    ),
    DRAFT_LIMITS.features
  );
  const tasks = take(
    context.tasks.map(t => `- ${t.code} ${t.title} [${t.status}]`),
    DRAFT_LIMITS.tasks
  );
  const issues = take(
    context.issues.map(i =>
      `- ${i.code} ${i.title} [${i.status}, severity ${i.severity}]${i.description ? `: ${clipped(flat(i.description)!, 300)}` : ''}`
    ),
    DRAFT_LIMITS.issues
  );
  const decisions = take(
    context.decisions.map(d => `- ${d.code} ${d.title} [${d.status}]${d.decision ? `: ${clipped(flat(d.decision)!, 300)}` : ''}`),
    DRAFT_LIMITS.decisions
  );
  const techStack = take(
    context.techStack.map(t => `- ${t.category}: ${t.technology}${t.version ? ` (${t.version})` : ''}${t.notes ? ` — ${clipped(flat(t.notes)!, 200)}` : ''}`),
    DRAFT_LIMITS.techStack
  );
  const milestones = take(
    context.milestones.map(m => {
      const date = m.targetDate ? m.targetDate.toISOString().slice(0, 10) : 'no target date';
      return `- ${m.name} [${m.status}, ${date}]${m.description ? `: ${clipped(flat(m.description)!, 200)}` : ''}`;
    }),
    DRAFT_LIMITS.milestones
  );
  const deployments = take(
    context.deployments.map(d => {
      const version = d.version ? ` ${d.version}` : '';
      const url = d.url ? ` ${d.url}` : '';
      return `- ${d.date.toISOString().slice(0, 10)} ${d.environment}${version} [${d.status}]${url}`;
    }),
    DRAFT_LIMITS.deployments
  );
  const notes = take(
    context.notes.map(n => {
      const title = flat(n.title) ?? 'Untitled note';
      const body = flat(n.content);
      return `- ${title}${body ? `: ${clipped(body, 400)}` : ''}`;
    }),
    DRAFT_LIMITS.notes
  );
  const research = take(
    context.research.map(r => `- ${r.title} [${r.type}]${r.summary ? `: ${clipped(flat(r.summary)!, 300)}` : ''}`),
    DRAFT_LIMITS.research
  );
  const reusable = take(
    context.reusablePrompts.map(rp => `- ${rp.code} ${rp.title ?? '(untitled)'}${rp.category ? ` [${rp.category}]` : ''}`),
    20
  );

  const sections: string[] = [
    PURPOSE_INSTRUCTIONS[purpose],
    '',
    '## Project',
    bullet(`Name: ${p.name}`),
    bullet(`Stage: ${p.stage}`),
    bullet(p.description ? `Description: ${flat(p.description)}` : null),
    bullet(p.problem ? `Problem: ${flat(p.problem)}` : null),
    bullet(p.repositoryUrl ? `Repository: ${p.repositoryUrl}` : null),
    context.tags.length > 0 ? `Tags: ${context.tags.join(', ')}` : bullet(null),
    '',
    '## Requirements',
    listSection(requirements.shown, requirements.more),
    '',
    '## Features',
    listSection(features.shown, features.more),
    '',
    '## Tasks',
    listSection(tasks.shown, tasks.more),
    '',
    '## Known issues',
    listSection(issues.shown, issues.more),
    '',
    '## Architecture decisions',
    listSection(decisions.shown, decisions.more),
    '',
    '## Technology stack',
    listSection(techStack.shown, techStack.more),
    '',
    '## Milestones',
    listSection(milestones.shown, milestones.more),
    '',
    '## Deployment history',
    listSection(deployments.shown, deployments.more),
    '',
    '## Research',
    listSection(research.shown, research.more),
    '',
    '## Project notes',
    listSection(notes.shown, notes.more),
    '',
    '## Reusable prompts in this project',
    listSection(reusable.shown, reusable.more),
    '',
    '## About this draft',
    `- Purpose: ${purpose} · Suggested category: ${PURPOSE_CATEGORY[purpose]}`,
    '- Drafted by Project Hub from the records above; no AI service was called.',
    `- Sections showing "${NOT_PROVIDED}" have no recorded data - ask for them instead of guessing.`
  ];

  return {
    title: `${purpose} — ${p.name}`,
    category: PURPOSE_CATEGORY[purpose],
    purpose,
    content: sections.join('\n')
  };
}

/** The suggested category for a purpose (used when saving a draft). */
export function promptCategoryFor(purpose: PromptPurpose): string {
  return PURPOSE_CATEGORY[purpose];
}

/** Narrow an arbitrary string to a supported purpose. */
export function isPromptPurpose(value: unknown): value is PromptPurpose {
  return typeof value === 'string' && (PROMPT_PURPOSES as readonly string[]).includes(value);
}
