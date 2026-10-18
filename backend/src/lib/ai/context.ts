import {
  CONTEXT_KEYS,
  NOT_PROVIDED,
  type ContextKey,
  type PromptContext
} from '../promptContext.js';

/**
 * Phase 9: turning the Phase 8 project context into the text that is actually
 * sent to the AI provider - but only the sections the user chose.
 *
 * This is not a second context system. It never reads the database: it takes
 * the `PromptContext` that `buildPromptContext()` (Phase 8) already produced
 * and formats a subset of it. One builder, two consumers (the Phase 8 draft
 * generator and the Phase 9 AI workspace).
 *
 * Two rules are enforced here:
 *
 *  1. Context control - a section is rendered only if the user selected its
 *     key, so the whole project never leaves the machine by default.
 *  2. No fabrication - a selected section with no records renders the same
 *     "Not provided in Project Hub." marker the Phase 8 drafts use. Missing
 *     information is stated as missing; it is never filled in with plausible
 *     text.
 */

export const AI_CONTEXT_LABELS: Record<ContextKey, string> = {
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

/** Per-section caps, mirroring the Phase 8 draft limits. */
const LIMITS: Partial<Record<ContextKey, number>> = {
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
};

export interface AiContextSection {
  key: ContextKey;
  label: string;
  present: boolean;
  content: string;
}

/** Narrow arbitrary input to valid context keys, de-duplicated, in canonical order. */
export function parseContextSections(value: unknown): ContextKey[] {
  if (!Array.isArray(value)) return [];
  const wanted = new Set(value.filter((k): k is string => typeof k === 'string'));
  return CONTEXT_KEYS.filter(k => wanted.has(k));
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max).trimEnd()}… [truncated]`;
}

function flat(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.replace(/\s*\n\s*/g, ' ').trim();
  return text.length > 0 ? text : null;
}

function listOrMarker(items: string[], limit: number): string {
  if (items.length === 0) return NOT_PROVIDED;
  const shown = items.slice(0, limit);
  const more = items.length - shown.length;
  if (more > 0) shown.push(`- … and ${more} more not shown.`);
  return shown.join('\n');
}

/** Render exactly one selected section. Pure function of the context. */
export function renderContextSection(context: PromptContext, key: ContextKey): string {
  switch (key) {
    case 'description':
      return context.project.description?.trim() ? context.project.description.trim() : NOT_PROVIDED;
    case 'problem':
      return context.project.problem?.trim() ? context.project.problem.trim() : NOT_PROVIDED;
    case 'requirements':
      return listOrMarker(
        context.requirements.map(r =>
          `- ${r.code} ${r.title} [${r.type}, ${r.priority}, ${r.status}]${
            r.description ? `: ${clip(flat(r.description) ?? '', 300)}` : ''
          }`
        ),
        LIMITS.requirements ?? 50
      );
    case 'features':
      return listOrMarker(
        context.features.map(f =>
          `- ${f.name} [${f.priority}, ${f.status}]${f.description ? `: ${clip(flat(f.description) ?? '', 300)}` : ''}`
        ),
        LIMITS.features ?? 50
      );
    case 'tasks':
      return listOrMarker(
        context.tasks.map(t => `- ${t.code} ${t.title} [${t.status}]`),
        LIMITS.tasks ?? 50
      );
    case 'issues':
      return listOrMarker(
        context.issues.map(i =>
          `- ${i.code} ${i.title} [${i.status}, severity ${i.severity}]${
            i.description ? `: ${clip(flat(i.description) ?? '', 300)}` : ''
          }`
        ),
        LIMITS.issues ?? 50
      );
    case 'decisions':
      return listOrMarker(
        context.decisions.map(d => `- ${d.code} ${d.title} [${d.status}]${d.decision ? `: ${clip(flat(d.decision) ?? '', 300)}` : ''}`),
        LIMITS.decisions ?? 30
      );
    case 'techStack':
      return listOrMarker(
        context.techStack.map(
          t => `- ${t.category}: ${t.technology}${t.version ? ` (${t.version})` : ''}${t.notes ? ` — ${clip(flat(t.notes) ?? '', 200)}` : ''}`
        ),
        LIMITS.techStack ?? 50
      );
    case 'milestones':
      return listOrMarker(
        context.milestones.map(m => {
          const date = m.targetDate ? m.targetDate.toISOString().slice(0, 10) : 'no target date';
          return `- ${m.name} [${m.status}, ${date}]${m.description ? `: ${clip(flat(m.description) ?? '', 200)}` : ''}`;
        }),
        LIMITS.milestones ?? 20
      );
    case 'deployments':
      return listOrMarker(
        context.deployments.map(d => {
          const version = d.version ? ` ${d.version}` : '';
          const url = d.url ? ` ${d.url}` : '';
          return `- ${d.date.toISOString().slice(0, 10)} ${d.environment}${version} [${d.status}]${url}`;
        }),
        LIMITS.deployments ?? 20
      );
    case 'notes':
      return listOrMarker(
        context.notes.map(n => {
          const title = flat(n.title) ?? 'Untitled note';
          const body = flat(n.content);
          return `- ${title}${body ? `: ${clip(body, 400)}` : ''}`;
        }),
        LIMITS.notes ?? 10
      );
    case 'research':
      return listOrMarker(
        context.research.map(r => `- ${r.title} [${r.type}]${r.summary ? `: ${clip(flat(r.summary) ?? '', 300)}` : ''}`),
        LIMITS.research ?? 20
      );
  }
}

/**
 * The identity block that always travels with a request. It contains only
 * identity facts (name, stage, repository) - the sections proper are opt-in.
 */
function projectHeader(context: PromptContext): string {
  const p = context.project;
  const lines = [`- Name: ${p.name}`, `- Stage: ${p.stage}`];
  if (p.repositoryUrl) lines.push(`- Repository: ${p.repositoryUrl}`);
  if (context.tags.length > 0) lines.push(`- Tags: ${context.tags.join(', ')}`);
  return lines.join('\n');
}

export interface RenderedAiContext {
  sections: AiContextSection[];
  /** The exact markdown that will be sent (empty when no sections were selected). */
  text: string;
}

/**
 * Render the selected sections of the context, in canonical order.
 *
 * The returned `text` is what the preview shows and what the request sends -
 * the same string by construction, so what the user reviewed is what the
 * provider receives.
 */
export function renderAiContext(context: PromptContext, keys: ContextKey[]): RenderedAiContext {
  const selected = parseContextSections(keys);
  const sections: AiContextSection[] = selected.map(key => ({
    key,
    label: AI_CONTEXT_LABELS[key],
    present: context.presence[key],
    content: renderContextSection(context, key)
  }));

  const blocks: string[] = ['## Project', projectHeader(context)];
  for (const section of sections) {
    blocks.push('', `## ${section.label}`, section.content);
  }

  return { sections, text: blocks.join('\n') };
}
