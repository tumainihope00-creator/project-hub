import { Router } from 'express';
import { z } from 'zod';
import { badRequest, notFound, ApiError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { logActivity } from '../lib/activity.js';
import { projectStats, STAGE_ORDER } from '../lib/projectStats.js';
import { setTags, tagsFor } from '../lib/tags.js';
import { intFromQuery } from '../lib/validation.js';
import { createProjectWithWorkspace, prepareProjectWorkspace } from '../lib/projectCreation.js';
import {
  projectDocumentStatus,
  readProjectDocument,
  writeProjectDocument
} from '../lib/projectDocument.js';
import { probeProjectsRoot, type PathProblem } from '../lib/paths.js';
import { STAGES } from '../resources.js';

const router = Router();

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function uniqueSlug(name: string, ignoreId?: number): Promise<string> {
  const base = slugify(name) || 'project';
  let slug = base;
  let n = 2;
  while (await prisma.project.findFirst({ where: { slug, ...(ignoreId ? { NOT: { id: ignoreId } } : {}) } })) {
    slug = `${base}-${n}`;
    n++;
  }
  return slug;
}

async function resolveProject(key: string) {
  const where = /^\d+$/.test(key) ? { id: Number(key) } : { slug: key };
  const p = await prisma.project.findUnique({ where });
  if (!p) throw notFound('Project not found');
  return p;
}

const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(20000).optional().nullable(),
  problem: z.string().trim().max(20000).optional().nullable(),
  motivation: z.string().trim().max(20000).optional().nullable(),
  targetUsers: z.string().trim().max(5000).optional().nullable(),
  expectedValue: z.string().trim().max(5000).optional().nullable(),
  assumptions: z.string().trim().max(20000).optional().nullable(),
  initialQuestions: z.string().trim().max(20000).optional().nullable(),
  inspiration: z.string().trim().max(5000).optional().nullable(),
  v1Scope: z.string().trim().max(20000).optional().nullable(),
  stage: z.enum(STAGES).optional().default('IDEA'),
  repositoryUrl: z.string().trim().max(1000).optional().nullable(),
  tags: z.array(z.string()).optional()
}).strict();

const projectUpdateSchema = projectCreateSchema.partial();

// --------------------------------------------------------------------------
// List / portfolio
// --------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const stage = typeof req.query.stage === 'string' ? req.query.stage : '';
    const tag = typeof req.query.tag === 'string' ? req.query.tag : '';
    const archived = typeof req.query.archived === 'string' ? req.query.archived : 'active';

    const where: any = {};
    if (archived === 'active') where.isArchived = false;
    if (archived === 'only') where.isArchived = true;
    if (stage && STAGES.includes(stage as any)) where.stage = stage;
    if (q) {
      where.OR = [{ name: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }];
    }
    if (tag) {
      const tagRow = await prisma.tag.findUnique({ where: { name: tag.toLowerCase() } });
      if (!tagRow) return res.json({ data: [], meta: { total: 0 } });
      const ids = (await prisma.tagAssignment.findMany({ where: { tagId: tagRow.id }, select: { taggableId: true } })).map(r => r.taggableId);
      where.id = { in: ids };
    }

    const projects = await prisma.project.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: 1000
    });

    const ids = projects.map(p => p.id);
    const [taskRows, issueOpen, criticalIssues, deployRows, promptRows, aiRows, devRows, researchRows, lastAct, assigns] = await Promise.all([
      ids.length ? prisma.task.groupBy({ by: ['projectId', 'status'], where: { projectId: { in: ids } }, _count: true }) : [],
      ids.length ? prisma.issue.groupBy({ by: ['projectId'], where: { projectId: { in: ids }, status: { in: ['OPEN', 'INVESTIGATING', 'FIXING'] } }, _count: true }) : [],
      ids.length ? prisma.issue.groupBy({ by: ['projectId'], where: { projectId: { in: ids }, severity: 'CRITICAL', status: { in: ['OPEN', 'INVESTIGATING', 'FIXING'] } }, _count: true }) : [],
      ids.length ? prisma.deployment.groupBy({ by: ['projectId'], where: { projectId: { in: ids } }, _count: true }) : [],
      ids.length ? prisma.prompt.groupBy({ by: ['projectId'], where: { projectId: { in: ids } }, _count: true }) : [],
      ids.length ? prisma.aiSession.groupBy({ by: ['projectId'], where: { projectId: { in: ids } }, _count: true }) : [],
      ids.length ? prisma.developmentSession.groupBy({ by: ['projectId'], where: { projectId: { in: ids } }, _count: true }) : [],
      ids.length ? prisma.researchEntry.groupBy({ by: ['projectId'], where: { projectId: { in: ids } }, _count: true }) : [],
      ids.length ? prisma.activityEvent.findMany({ where: { projectId: { in: ids } }, orderBy: { createdAt: 'desc' }, take: 2000, select: { projectId: true, createdAt: true } }) : [],
      ids.length ? prisma.tagAssignment.findMany({ where: { taggableType: 'project', taggableId: { in: ids } }, include: { tag: true } }) : []
    ]);

    const taskMap = new Map<string, number>();
    for (const r of taskRows) taskMap.set(`${r.projectId}:${r.status}`, r._count);
    const countOf = (map: { projectId: number; _count: number }[], id: number) => map.find(m => m.projectId === id)?._count ?? 0;
    const lastActMap = new Map<number, Date>();
    for (const a of lastAct) if (!lastActMap.has(a.projectId)) lastActMap.set(a.projectId, a.createdAt);
    const tagMap = new Map<number, any[]>();
    for (const a of assigns) {
      if (!tagMap.has(a.taggableId)) tagMap.set(a.taggableId, []);
      tagMap.get(a.taggableId)!.push(a.tag);
    }

    const data = projects.map(p => {
      const done = taskMap.get(`${p.id}:COMPLETED`) ?? 0;
      const statusCounts = (['TODO', 'IN_PROGRESS', 'BLOCKED', 'TESTING', 'COMPLETED', 'CANCELLED'] as const).map(s => taskMap.get(`${p.id}:${s}`) ?? 0);
      const total = statusCounts.reduce((a, b) => a + b, 0);
      const progress = total > 0 ? Math.round((done / total) * 100) : (STAGE_ORDER.indexOf(p.stage) >= 0 ? Math.round((STAGE_ORDER.indexOf(p.stage) / (STAGE_ORDER.length - 1)) * 100) : 0);
      return {
        ...p,
        stats: {
          tasksTotal: total,
          tasksCompleted: done,
          tasksOpen: total - done - (taskMap.get(`${p.id}:CANCELLED`) ?? 0),
          issuesOpen: countOf(issueOpen, p.id),
          issuesCritical: countOf(criticalIssues, p.id),
          deployments: countOf(deployRows, p.id),
          prompts: countOf(promptRows, p.id),
          aiSessions: countOf(aiRows, p.id),
          developmentSessions: countOf(devRows, p.id),
          research: countOf(researchRows, p.id),
          progress
        },
        tags: tagMap.get(p.id) ?? [],
        lastActivityAt: lastActMap.get(p.id) ?? null
      };
    });

    res.json({ data, meta: { total: data.length } });
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// Create
// --------------------------------------------------------------------------

router.post('/', async (req, res, next) => {
  try {
    const parsed = projectCreateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid input', parsed.error.flatten());
    const input = { ...parsed.data };
    const { tags, ...data } = input as any;
    const slug = await uniqueSlug(data.name);
    const originalIdea = JSON.stringify({
      name: data.name,
      description: data.description ?? null,
      problem: data.problem ?? null,
      motivation: data.motivation ?? null,
      targetUsers: data.targetUsers ?? null,
      expectedValue: data.expectedValue ?? null,
      assumptions: data.assumptions ?? null,
      initialQuestions: data.initialQuestions ?? null,
      inspiration: data.inspiration ?? null,
      capturedAt: new Date().toISOString()
    });

    // Phase 3: the folder is created first, then the record. If the record fails
    // the folder is removed again, and only if this call created it and it is
    // still empty. See lib/projectCreation.ts for why the order is that way.
    const { project } = await createProjectWithWorkspace(
      { name: data.name },
      ({ folderName, folderPath }) =>
        prisma.project.create({
          data: {
            ...data,
            // A new project always starts at IDEA. Creating a folder is not
            // development activity, and lifecycle detection is a later phase.
            stage: 'IDEA',
            slug,
            originalIdea,
            isArchived: false,
            folderName,
            folderPath
          }
        })
    );
    if (Array.isArray(tags) && tags.length) {
      await setTags('project', project.id, tags);
    }

    // Phase 4: PROJECT.md is written last, after the record and its tags exist,
    // so the document is built from the project as the user just defined it.
    //
    // A failure here is NOT rolled back. The folder and the record are both real
    // and correct at this point; deleting either of them because a single file
    // could not be written would destroy work that succeeded. The project is
    // returned as created, with the document reported honestly, and the user can
    // generate it from the project page.
    let documentStatus: Awaited<ReturnType<typeof projectDocumentStatus>> | null = null;
    let documentWarning: { code: string; message: string; possibleAction: string } | undefined;
    try {
      const written = await writeProjectDocument(project, { overwrite: false });
      documentStatus = written.status;
    } catch (err) {
      const e = err as ApiError;
      documentWarning = {
        code: String((e.details as any)?.code ?? 'PROJECT_DOCUMENT_NOT_CREATED'),
        message: e.message,
        possibleAction:
          e.possibleAction ??
          'The project and its folder were created. Generate PROJECT.md from the project page when you are ready.'
      };
    }

    await logActivity({
      projectId: project.id,
      type: 'PROJECT_CREATED',
      description: `Project "${project.name}" created (${project.stage})`,
      relatedType: 'project',
      relatedId: project.id
    });
    res.status(201).json({ data: { ...project, projectDocument: documentStatus }, ...(documentWarning ? { warning: documentWarning } : {}) });
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// Workspace preview / status (Phase 3)
// --------------------------------------------------------------------------

/**
 * Resolve a project name to the folder it would use, without creating anything.
 *
 * Exists so the creation UI can show "a workspace will be created at ..." before
 * the user commits, and so they can see the folder name when it had to differ
 * from their project name. This performs the same validation and the same
 * collision check as real creation, so what it promises is what will happen.
 */
router.post('/preview-workspace', async (req, res, next) => {
  try {
    const parsed = z.object({ name: z.string() }).strict().safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid input', parsed.error.flatten());
    const preview = await prepareProjectWorkspace(parsed.data.name);
    res.json({
      data: {
        ...preview,
        willCreate: true
      }
    });
  } catch (e) {
    next(e);
  }
});

/**
 * `probeProjectsRoot` produces problems written for the Settings page, where a
 * "Create folder" button exists for the Projects Root itself. A project
 * workspace has no such control - Phase 3 deliberately does not create folders
 * on demand - so the advice is rewritten for the context the user is in.
 */
function workspaceProblems(problems: PathProblem[]): PathProblem[] {
  return problems.map(p => ({
    ...p,
    possibleAction:
      p.code === 'PATH_NOT_FOUND'
        ? 'This folder was deleted outside Project Hub. Recreate it at this exact path if you still need the workspace - nothing in the project record was lost.'
        : p.code === 'PATH_NOT_DIRECTORY'
          ? 'A file is sitting where this project folder should be. Project Hub will not replace it; move it aside yourself.'
          : p.possibleAction
  }));
}

/**
 * Report whether a project's workspace folder is still on disk.
 *
 * A browser page cannot open a local folder in the operating system's file
 * manager - there is no standard API for it, and the File System Access API is
 * permission-gated and not universally available. Rather than ship a button
 * that silently does nothing, the details page uses this to tell the truth about
 * the workspace and lets the user copy the path.
 */
router.get('/:key/workspace', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.key);
    if (!project.folderPath) {
      return res.json({ data: { hasWorkspace: false, folderPath: null, folderName: null, exists: null, isDirectory: null } });
    }
    const probe = await probeProjectsRoot(project.folderPath, { testWrite: false });
    res.json({
      data: {
        hasWorkspace: true,
        folderPath: project.folderPath,
        folderName: project.folderName,
        exists: probe.exists,
        isDirectory: probe.isDirectory,
        readable: probe.readable,
        problems: workspaceProblems(probe.problems),
        checkedAt: probe.checkedAt
      }
    });
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// PROJECT.md (Phase 4)
//
// One direction only: the database writes the document. No endpoint here parses
// PROJECT.md, and none of them accepts a path, a filename, or any other
// filesystem input from the client. The file is always
// <Projects Root>/<project folder>/PROJECT.md, derived from the project record.
// --------------------------------------------------------------------------

/**
 * Is this project's PROJECT.md present, and can one be created?
 *
 * Answers a question the details page asks on every load, so it must not fail
 * when the answer is simply "no". A project with no workspace, or one whose
 * workspace is gone, reports `available: false` with the reason, instead of
 * turning into an error the page has to special-case.
 */
router.get('/:key/project-document', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.key);
    const status = await projectDocumentStatus(project);
    res.json({ data: status });
  } catch (e) {
    next(e);
  }
});

/**
 * The document itself, for the read-only viewer.
 *
 * Only ever called for a project that has one; the content comes from disk, not
 * from the database, so a user editing the file in their editor sees their edits.
 * That is the point - and it is also why nothing in this response is ever
 * written back.
 */
router.get('/:key/project-document/content', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.key);
    const document = await readProjectDocument(project);
    res.json({ data: document });
  } catch (e) {
    next(e);
  }
});

/**
 * Generate PROJECT.md for a project that does not have one yet.
 *
 * This is the explicit action for existing projects - the ones Phase 3 left
 * alone, and any project whose document was removed or never created. It never
 * runs on its own for a project that already has a file: `writeProjectDocument`
 * refuses to overwrite, so calling this twice is a no-op followed by a clear
 * conflict rather than silent data loss.
 */
router.post('/:key/project-document', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.key);
    const result = await writeProjectDocument(project, { overwrite: false });
    res.status(201).json({ data: result.status, bytes: result.bytes, replaced: false });
  } catch (e) {
    next(e);
  }
});

/**
 * Regenerate: replace PROJECT.md with the version built from the database.
 *
 * Separate from generate on purpose. This is the only endpoint that discards
 * whatever is in the file, and it discards any manual edits along with it, so it
 * requires an explicit `confirm: true`. A missing confirmation is a 400 that
 * changes nothing on disk - the client is expected to ask the user first, and
 * the server does not trust that the client asked.
 */
router.post('/:key/project-document/regenerate', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.key);
    const parsed = z.object({ confirm: z.literal(true) }).strict().safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'Regenerating PROJECT.md replaces the file and discards any manual edits to it, so it needs an explicit confirmation.',
        { requires: 'confirm: true', received: (req.body ?? {}) }
      );
    }
    const status = await projectDocumentStatus(project);
    if (status.available && status.exists === false) {
      // Regenerating something that is not there is just creating it, and it
      // would be surprising to report a replacement that replaced nothing.
      const created = await writeProjectDocument(project, { overwrite: false });
      return res.status(201).json({ data: created.status, bytes: created.bytes, replaced: false });
    }
    const result = await writeProjectDocument(project, { overwrite: true });
    res.json({ data: result.status, bytes: result.bytes, replaced: true });
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// Get / update / delete
// --------------------------------------------------------------------------

router.get('/:key', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.key);
    const [tags, stats] = await Promise.all([tagsFor('project', project.id), projectStats(project.id)]);
    res.json({ data: { ...project, tags, stats } });
  } catch (e) {
    next(e);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.id);
    const parsed = projectUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid input', parsed.error.flatten());
    const input = { ...parsed.data } as any;
    const { tags, ...data } = input;
    if (data.name && data.name !== project.name) {
      data.slug = await uniqueSlug(data.name, project.id);
    }
    const updated = await prisma.project.update({ where: { id: project.id }, data });
    if (Array.isArray(tags)) await setTags('project', project.id, tags);
    await logActivity({
      projectId: project.id,
      type: 'PROJECT_UPDATED',
      description: `Project "${updated.name}" updated`,
      relatedType: 'project',
      relatedId: project.id
    });
    const updatedTags = await tagsFor('project', project.id);
    res.json({ data: { ...updated, tags: updatedTags } });
  } catch (e) {
    next(e);
  }
});

// Soft archive (default). Hard delete only with ?hard=true, kept explicit.
router.delete('/:id', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.id);
    if (req.query.hard === 'true') {
      await prisma.project.delete({ where: { id: project.id } });
      return res.json({ data: { id: project.id, deleted: true, hard: true } });
    }
    if (!project.isArchived) {
      await prisma.project.update({ where: { id: project.id }, data: { isArchived: true, archivedAt: new Date() } });
      await logActivity({
        projectId: project.id,
        type: 'PROJECT_ARCHIVED',
        description: `Project "${project.name}" archived`,
        relatedType: 'project',
        relatedId: project.id
      });
    }
    res.json({ data: { id: project.id, deleted: false, archived: true, hard: false } });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/archive', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.id);
    const updated = await prisma.project.update({
      where: { id: project.id },
      data: { isArchived: true, archivedAt: new Date() }
    });
    await logActivity({ projectId: project.id, type: 'PROJECT_ARCHIVED', description: `Project "${project.name}" archived`, relatedType: 'project', relatedId: project.id });
    res.json({ data: updated });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/activate', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.id);
    const updated = await prisma.project.update({
      where: { id: project.id },
      data: { isArchived: false, archivedAt: null }
    });
    await logActivity({ projectId: project.id, type: 'PROJECT_ACTIVATED', description: `Project "${project.name}" reactivated`, relatedType: 'project', relatedId: project.id });
    res.json({ data: updated });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/stage', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.id);
    const parsed = z.object({ stage: z.enum(STAGES), note: z.string().optional() }).safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid stage');
    const { stage, note } = parsed.data;
    const updated = await prisma.project.update({ where: { id: project.id }, data: { stage } });
    await logActivity({
      projectId: project.id,
      type: 'STAGE_CHANGED',
      description: `Stage changed: ${project.stage} → ${stage}${note ? ` (${note})` : ''}`,
      metadata: { fromStage: project.stage, toStage: stage, note: note ?? null },
      relatedType: 'project',
      relatedId: project.id
    });
    res.json({ data: updated });
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// Overview / snapshot / health
// --------------------------------------------------------------------------

router.get('/:key/overview', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.key);
    const stats = await projectStats(project.id);
    const recentActivity = await prisma.activityEvent.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: 'desc' },
      take: 12
    });
    const tags = await tagsFor('project', project.id);
    const nextActions = buildNextActions(project, stats);
    res.json({ data: { project, tags, stats, recentActivity, nextActions } });
  } catch (e) {
    next(e);
  }
});

router.get('/:key/snapshot', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.key);
    const stats = await projectStats(project.id);
    res.json({ data: { project, stats } });
  } catch (e) {
    next(e);
  }
});

router.get('/:key/health', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.key);
    const stats = await projectStats(project.id);
    const lastDeployment = await prisma.deployment.findFirst({
      where: { projectId: project.id, status: 'SUCCESSFUL' },
      orderBy: { date: 'desc' }
    });
    res.json({ data: { stats, lastDeployment, currentStage: project.stage } });
  } catch (e) {
    next(e);
  }
});

function buildNextActions(project: any, stats: any): string[] {
  const actions: string[] = [];
  if (stats.tasksBlocked > 0) actions.push(`Unblock ${stats.tasksBlocked} blocked task${stats.tasksBlocked > 1 ? 's' : ''}`);
  if (stats.tasksOverdue > 0) actions.push(`${stats.tasksOverdue} task${stats.tasksOverdue > 1 ? 's are' : ' is'} overdue`);
  if (stats.issuesCritical > 0) actions.push(`Resolve ${stats.issuesCritical} open critical issue${stats.issuesCritical > 1 ? 's' : ''}`);
  if (project.stage === 'TESTING' && stats.tasksOpen > 0) actions.push(`${stats.tasksOpen} task${stats.tasksOpen > 1 ? 's' : ''} not yet completed before release`);
  if (project.stage === 'PRODUCTION' && !stats.lastDeploymentAt) actions.push('Production stage reached but no deployment has been recorded');
  if (project.stage === 'PRODUCTION' && stats.lastDeploymentAt) {
    const days = Math.floor((Date.now() - new Date(stats.lastDeploymentAt).getTime()) / 86400000);
    if (days >= 30) actions.push(`Last deployment was ${days} days ago — verify production status`);
  }
  return actions;
}

// --------------------------------------------------------------------------
// Timeline / heatmap
// --------------------------------------------------------------------------

router.get('/:key/timeline', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.key);
    const events = await prisma.activityEvent.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: 'asc' },
      take: 5000
    });
    const byDay = new Map<string, any[]>();
    for (const ev of events) {
      const day = ev.createdAt.toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(ev);
    }
    const grouped = [...byDay.entries()].map(([date, items]) => ({ date, items })).sort((a, b) => b.date.localeCompare(a.date));
    res.json({ data: grouped, meta: { total: events.length } });
  } catch (e) {
    next(e);
  }
});

router.get('/:key/ai-timeline', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.key);
    const [prompts, aiSessions] = await Promise.all([
      prisma.prompt.findMany({ where: { projectId: project.id }, orderBy: { date: 'asc' }, include: { versions: { orderBy: { version: 'asc' } }, task: { select: { code: true, title: true } } } }),
      prisma.aiSession.findMany({ where: { projectId: project.id }, orderBy: { date: 'asc' } })
    ]);
    res.json({ data: { prompts, aiSessions } });
  } catch (e) {
    next(e);
  }
});

router.get('/:key/activity', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.key);
    const page = intFromQuery(req.query.page, 1, 100000);
    const pageSize = intFromQuery(req.query.pageSize, 50, 200);
    const [rows, total] = await Promise.all([
      prisma.activityEvent.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.activityEvent.count({ where: { projectId: project.id } })
    ]);
    res.json({ data: rows, meta: { total, page, pageSize } });
  } catch (e) {
    next(e);
  }
});

router.get('/:key/heatmap', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.key);
    const since = new Date();
    since.setDate(since.getDate() - 70);
    const rows = await prisma.activityEvent.findMany({
      where: { projectId: project.id, createdAt: { gte: since } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' }
    });
    const counts = new Map<string, number>();
    for (const r of rows) {
      const d = r.createdAt.toISOString().slice(0, 10);
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    res.json({ data: { start: since.toISOString().slice(0, 10), days: [...counts.entries()].map(([date, count]) => ({ date, count })) } });
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// Relationships
// --------------------------------------------------------------------------

router.get('/:key/relationships', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.key);
    const [outgoing, incoming] = await Promise.all([
      prisma.projectRelationship.findMany({ where: { fromProjectId: project.id }, include: { toProject: { select: { id: true, name: true, slug: true, stage: true } } } }),
      prisma.projectRelationship.findMany({ where: { toProjectId: project.id }, include: { fromProject: { select: { id: true, name: true, slug: true, stage: true } } } })
    ]);
    res.json({ data: { outgoing, incoming } });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/relationships', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.id);
    const parsed = z.object({ relatedProjectId: z.number().int(), type: z.enum(['RELATED', 'DEPENDS_ON', 'INSPIRED_BY', 'FORKED_FROM', 'REPLACES', 'PART_OF']).default('RELATED'), notes: z.string().optional().nullable() }).safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid input', parsed.error.flatten());
    const { relatedProjectId, type, notes } = parsed.data;
    if (relatedProjectId === project.id) throw badRequest('A project cannot be related to itself');
    const target = await prisma.project.findUnique({ where: { id: relatedProjectId } });
    if (!target) throw notFound('Related project not found');
    const rel = await prisma.projectRelationship.upsert({
      where: { fromProjectId_toProjectId_type: { fromProjectId: project.id, toProjectId: relatedProjectId, type } },
      create: { fromProjectId: project.id, toProjectId: relatedProjectId, type, notes },
      update: { notes }
    });
    await logActivity({
      projectId: project.id,
      type: 'RELATIONSHIP_CREATED',
      description: `Related "${project.name}" → "${target.name}" (${type})`,
      relatedType: 'projectRelationship',
      relatedId: rel.id
    });
    res.status(201).json({ data: rel });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id/relationships/:relId', async (req, res, next) => {
  try {
    await resolveProject(req.params.id);
    const rel = await prisma.projectRelationship.findFirst({ where: { id: Number(req.params.relId), fromProjectId: Number(req.params.id) } });
    if (!rel) throw notFound('Relationship not found');
    await prisma.projectRelationship.delete({ where: { id: rel.id } });
    res.json({ data: { id: rel.id, deleted: true } });
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// Export
// --------------------------------------------------------------------------

router.get('/:key/export', async (req, res, next) => {
  try {
    const project = await resolveProject(req.params.key);
    const id = project.id;
    const [tasks, issues, features, requirements, milestones, research, researchQuestions, decisions, techStack, tables, endpoints, sessions, aiSessions, prompts, documents, notes, deployments, incidents, gitRefs, activity, relationships, tags, attachments] = await Promise.all([
      prisma.task.findMany({ where: { projectId: id }, orderBy: { id: 'asc' } }),
      prisma.issue.findMany({ where: { projectId: id }, orderBy: { id: 'asc' } }),
      prisma.feature.findMany({ where: { projectId: id }, orderBy: { id: 'asc' } }),
      prisma.requirement.findMany({ where: { projectId: id }, orderBy: { id: 'asc' } }),
      prisma.milestone.findMany({ where: { projectId: id }, orderBy: { id: 'asc' } }),
      prisma.researchEntry.findMany({ where: { projectId: id }, orderBy: { id: 'asc' } }),
      prisma.researchQuestion.findMany({ where: { projectId: id }, orderBy: { id: 'asc' } }),
      prisma.architectureDecision.findMany({ where: { projectId: id }, orderBy: { id: 'asc' } }),
      prisma.techStackItem.findMany({ where: { projectId: id } }),
      prisma.databaseTable.findMany({ where: { projectId: id } }),
      prisma.apiEndpoint.findMany({ where: { projectId: id } }),
      prisma.developmentSession.findMany({ where: { projectId: id } }),
      prisma.aiSession.findMany({ where: { projectId: id } }),
      prisma.prompt.findMany({ where: { projectId: id }, include: { versions: { orderBy: { version: 'asc' } } } }),
      prisma.projectDocument.findMany({ where: { projectId: id }, include: { versions: { orderBy: { version: 'asc' } } } }),
      prisma.note.findMany({ where: { projectId: id } }),
      prisma.deployment.findMany({ where: { projectId: id } }),
      prisma.productionIncident.findMany({ where: { projectId: id } }),
      prisma.gitReference.findMany({ where: { projectId: id } }),
      prisma.activityEvent.findMany({ where: { projectId: id }, orderBy: { createdAt: 'asc' } }),
      prisma.projectRelationship.findMany({ where: { OR: [{ fromProjectId: id }, { toProjectId: id }] } }),
      prisma.tagAssignment.findMany({ where: { taggableType: 'project', taggableId: id }, include: { tag: true } }),
      prisma.attachment.findMany({ where: { projectId: id } })
    ]);

    const tagQuery: Array<{ taggableType: string; taggableId: number }> = [
    ...tasks.map((t: any) => ({ taggableType: 'task', taggableId: t.id })),
    ...issues.map((t: any) => ({ taggableType: 'issue', taggableId: t.id })),
    ...research.map((t: any) => ({ taggableType: 'research', taggableId: t.id })),
    ...prompts.map((t: any) => ({ taggableType: 'prompt', taggableId: t.id })),
    ...documents.map((t: any) => ({ taggableType: 'document', taggableId: t.id })),
    ...notes.map((t: any) => ({ taggableType: 'note', taggableId: t.id }))
  ];

  const allTagged = await prisma.tagAssignment.findMany({
      where: tagQuery.length
        ? { OR: tagQuery }
        : {},
      include: { tag: true }
    });

    const payload = {
      project: { ...project, tags: tags.map(t => t.tag.name) },
      exportedAt: new Date().toISOString(),
      tasks, issues, features, requirements, milestones,
      research, researchQuestions, decisions, techStack, tables, endpoints,
      developmentSessions: sessions, aiSessions, prompts, documents, notes,
      deployments, incidents, gitReferences: gitRefs, activity, relationships,
      tagAssignments: allTagged.map(t => ({ type: t.taggableType, id: t.taggableId, tag: t.tag.name })),
      attachments
    };

    if (req.query.format === 'json' || !req.query.format) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${project.slug}-export.json"`);
      return res.send(JSON.stringify(payload, null, 2));
    }
    res.json({ data: payload });
  } catch (e) {
    next(e);
  }
});

export default router;