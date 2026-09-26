import { prisma } from '../prisma.js';
import { notFound } from '../errors.js';
import type {
  CollectedDecision,
  CollectedFeature,
  CollectedRequirement,
  CollectedTech,
  GenerationContext,
  SourceFailure
} from './types.js';

/**
 * Describes one collection query for the resilience wrapper below. `key` is the
 * readiness check the data feeds, so a failure can be attributed precisely.
 */
interface SourceSpec<T> {
  key: string;
  /** What we were trying to read — used in the user-facing error. */
  label: string;
  run: () => Promise<T[]>;
  /** Fallback used when the read fails, so the pipeline can still run. */
  empty: T[];
}

const describe = (e: unknown): string => {
  if (e instanceof Error && e.message) return e.message;
  return String(e);
};

/**
 * Run a collection query. A failure is recorded against the source instead of
 * being thrown, so the readiness check can report "! ERROR — Unable to retrieve
 * project requirements" rather than letting the whole generator die silently.
 */
async function readSource<T>(
  spec: SourceSpec<T>,
  failures: SourceFailure[]
): Promise<T[]> {
  try {
    return await spec.run();
  } catch (e) {
    failures.push({
      source: spec.key,
      reason: describe(e),
      operation: `read ${spec.label}`,
      action: 'Retry the readiness check. If it keeps failing, the database may be unavailable.'
    });
    return spec.empty;
  }
}

export interface CollectedGenerationData {
  context: GenerationContext;
  /** Empty when every source was read successfully. */
  failures: SourceFailure[];
}

/**
 * Collect the project data the generator cares about.
 * Only entities that actually exist in the Project Hub schema are used.
 * Text is returned as-is; normalization/filtering happens in the pipeline.
 *
 * Throws only when the project itself cannot be read — that is a real 404, not a
 * missing-information case.
 */
export async function collectGenerationData(projectId: number): Promise<CollectedGenerationData> {
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw notFound(
      `Project id "${projectId}" is not valid.`,
      'open the V1 Prompt Generator for a project',
      'Open the project from Project Hub and try again.'
    );
  }

  const p = await prisma.project.findUnique({ where: { id: projectId } });
  if (!p) {
    throw notFound(
      `Project ${projectId} was not found. It may have been deleted, or the link points at a project that no longer exists.`,
      'load this project',
      'Reload Project Hub and pick the project from the sidebar. If it has been deleted, its prompts cannot be rebuilt.'
    );
  }

  const failures: SourceFailure[] = [];

  const [
    research,
    researchQuestions,
    requirements,
    features,
    tasks,
    decisions,
    techStack,
    databaseTables,
    apiEndpoints,
    notes,
    devSessions,
    aiSessions,
    prompts,
    gitReferences,
    tagAssignments
  ] = await Promise.all([
    readSource<GenerationContext['research'][number]>(
      {
        key: 'researchEntries',
        label: 'research entries',
        run: () => prisma.researchEntry.findMany({ where: { projectId }, orderBy: { date: 'desc' } }),
        empty: []
      },
      failures
    ),
    readSource<GenerationContext['researchQuestions'][number]>(
      {
        key: 'researchQuestions',
        label: 'research questions',
        run: () => prisma.researchQuestion.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
        empty: []
      },
      failures
    ),
    readSource<CollectedRequirement>(
      {
        key: 'requirements',
        label: 'project requirements',
        run: () => prisma.requirement.findMany({ where: { projectId }, orderBy: { code: 'asc' } }),
        empty: []
      },
      failures
    ),
    readSource<CollectedFeature>(
      {
        key: 'features',
        label: 'project features',
        run: () => prisma.feature.findMany({ where: { projectId }, orderBy: { name: 'asc' } }),
        empty: []
      },
      failures
    ),
    readSource<GenerationContext['tasks'][number]>(
      {
        key: 'tasks',
        label: 'project tasks',
        run: () => prisma.task.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 200 }),
        empty: []
      },
      failures
    ),
    readSource<CollectedDecision>(
      {
        key: 'decisions',
        label: 'architecture decisions',
        run: () => prisma.architectureDecision.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
        empty: []
      },
      failures
    ),
    readSource<CollectedTech>(
      {
        key: 'techStack',
        label: 'the technology stack',
        run: () => prisma.techStackItem.findMany({ where: { projectId }, orderBy: { category: 'asc' } }),
        empty: []
      },
      failures
    ),
    readSource<GenerationContext['databaseTables'][number]>(
      {
        key: 'databaseTables',
        label: 'database tables',
        run: () => prisma.databaseTable.findMany({ where: { projectId }, orderBy: { name: 'asc' } }),
        empty: []
      },
      failures
    ),
    readSource<GenerationContext['apiEndpoints'][number]>(
      {
        key: 'apiEndpoints',
        label: 'API endpoints',
        run: () => prisma.apiEndpoint.findMany({ where: { projectId }, orderBy: { path: 'asc' } }),
        empty: []
      },
      failures
    ),
    readSource<GenerationContext['notes'][number]>(
      {
        key: 'notes',
        label: 'project notes',
        run: () => prisma.note.findMany({ where: { projectId }, orderBy: { updatedAt: 'desc' } }),
        empty: []
      },
      failures
    ),
    readSource<GenerationContext['devSessions'][number]>(
      {
        key: 'developmentSessions',
        label: 'development sessions',
        run: () => prisma.developmentSession.findMany({ where: { projectId }, orderBy: { date: 'desc' } }),
        empty: []
      },
      failures
    ),
    readSource<GenerationContext['aiSessions'][number]>(
      {
        key: 'aiSessions',
        label: 'AI sessions',
        run: () => prisma.aiSession.findMany({ where: { projectId }, orderBy: { date: 'desc' } }),
        empty: []
      },
      failures
    ),
    readSource<GenerationContext['prompts'][number]>(
      {
        key: 'prompts',
        label: 'AI prompts',
        run: () => prisma.prompt.findMany({ where: { projectId }, orderBy: { date: 'desc' } }),
        empty: []
      },
      failures
    ),
    readSource<GenerationContext['gitReferences'][number]>(
      {
        key: 'gitReferences',
        label: 'git references',
        run: () => prisma.gitReference.findMany({ where: { projectId }, orderBy: { date: 'desc' } }),
        empty: []
      },
      failures
    ),
    readSource<{ tag: { name: string } }>(
      {
        key: 'tags',
        label: 'project tags',
        run: () =>
          prisma.tagAssignment.findMany({
            where: { taggableType: 'project', taggableId: projectId },
            include: { tag: true }
          }) as unknown as Promise<{ tag: { name: string } }[]>,
        empty: []
      },
      failures
    )
  ]);

  const project: GenerationContext['project'] = {
    name: p.name,
    slug: p.slug,
    stage: p.stage,
    description: p.description,
    problem: p.problem,
    motivation: p.motivation,
    targetUsers: p.targetUsers,
    expectedValue: p.expectedValue,
    assumptions: p.assumptions,
    initialQuestions: p.initialQuestions,
    inspiration: p.inspiration,
    v1Scope: p.v1Scope,
    originalIdea: p.originalIdea,
    repositoryUrl: p.repositoryUrl
  };

  const context: GenerationContext = {
    project,
    tags: tagAssignments.map(a => a.tag.name),
    research: research.map(r => ({
      id: r.id,
      title: r.title,
      type: r.type,
      findings: r.findings,
      summary: r.summary,
      relevance: r.relevance
    })),
    researchQuestions: researchQuestions.map(q => ({
      id: q.id,
      question: q.question,
      answer: q.answer,
      status: q.status
    })),
    requirements: requirements.map((r): CollectedRequirement => ({
      id: r.id,
      code: r.code,
      title: r.title,
      type: r.type,
      priority: r.priority,
      status: r.status,
      description: r.description
    })),
    features: features.map((f): CollectedFeature => ({
      id: f.id,
      name: f.name,
      priority: f.priority,
      status: f.status,
      description: f.description
    })),
    tasks: tasks.map(t => ({
      id: t.id,
      code: t.code,
      title: t.title,
      status: t.status,
      description: t.description
    })),
    decisions: decisions.map((d): CollectedDecision => ({
      id: d.id,
      code: d.code,
      title: d.title,
      decision: d.decision,
      context: d.context,
      reasoning: d.reasoning,
      consequences: d.consequences,
      status: d.status
    })),
    techStack: techStack.map((t): CollectedTech => ({
      id: t.id,
      category: t.category,
      technology: t.technology,
      version: t.version,
      notes: t.notes
    })),
    databaseTables: databaseTables.map(t => ({ id: t.id, name: t.name, purpose: t.purpose })),
    apiEndpoints: apiEndpoints.map(a => ({ id: a.id, method: a.method, path: a.path, description: a.description })),
    notes: notes.map(n => ({ id: n.id, title: n.title, content: n.content })),
    devSessions: devSessions.map(s => ({
      id: s.id,
      number: s.number,
      goal: s.goal,
      completed: s.completed,
      nextStep: s.nextStep
    })),
    aiSessions: aiSessions.map(s => ({
      id: s.id,
      number: s.number,
      tool: s.tool,
      purpose: s.purpose,
      result: s.result
    })),
    prompts: prompts.map(pr => ({
      id: pr.id,
      code: pr.code,
      title: pr.title,
      category: pr.category
    })),
    gitReferences: gitReferences.map(g => ({
      id: g.id,
      kind: g.kind,
      commitMessage: g.commitMessage,
      branch: g.branch,
      repositoryUrl: g.repositoryUrl
    })),
    counts: {
      research: research.length,
      researchQuestions: researchQuestions.length,
      requirements: requirements.length,
      features: features.length,
      tasks: tasks.length,
      decisions: decisions.length,
      techStack: techStack.length,
      databaseTables: databaseTables.length,
      apiEndpoints: apiEndpoints.length,
      notes: notes.length,
      developmentSessions: devSessions.length,
      aiSessions: aiSessions.length,
      prompts: prompts.length,
      gitReferences: gitReferences.length
    } as GenerationContext['counts']
  };

  return { context, failures };
}

/**
 * Backwards-compatible wrapper: the context alone, for callers that do not care
 * about source diagnostics.
 */
export async function collectGenerationContext(projectId: number): Promise<GenerationContext> {
  return (await collectGenerationData(projectId)).context;
}

/** The original-idea snapshot, parsed defensively. */
export function originalIdeaOf(project: GenerationContext['project']): Record<string, unknown> {
  if (!project.originalIdea) return {};
  try {
    const parsed = JSON.parse(project.originalIdea);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
