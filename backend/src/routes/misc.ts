import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { tagUsage, addTags, removeTag } from '../lib/tags.js';
import { taggableType } from '../lib/validation.js';

const router = Router();

// --------------------------------------------------------------------------
// Dashboard
// --------------------------------------------------------------------------

router.get('/dashboard', async (_req, res, next) => {
  try {
    const [projects, tasks, issues, recentActivity] = await Promise.all([
      prisma.project.findMany({ orderBy: { updatedAt: 'desc' }, take: 10000 }),
      prisma.task.groupBy({ by: ['status'], _count: true }),
      prisma.issue.groupBy({ by: ['status'], where: { status: { in: ['OPEN', 'INVESTIGATING', 'FIXING'] } }, _count: true }),
      prisma.activityEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 15 })
    ]);

    const byStage: Record<string, number> = {};
    let active = 0;
    let archived = 0;
    for (const p of projects) {
      if (p.isArchived) archived++;
      else active++;
      byStage[p.stage] = (byStage[p.stage] ?? 0) + 1;
    }

    const tasksByStatus: Record<string, number> = {};
    for (const t of tasks) tasksByStatus[t.status] = t._count;
    const openIssues = issues.reduce((a, i) => a + i._count, 0);

    const recentActivityWithProjects = await Promise.all(recentActivity.map(async ev => {
      const p = await prisma.project.findUnique({ where: { id: ev.projectId }, select: { id: true, name: true, slug: true } });
      return { ...ev, project: p };
    }));

    res.json({
      data: {
        totals: { projects: projects.length, active, archived, tasks: Object.values(tasksByStatus).reduce((a, b) => a + b, 0), openIssues },
        byStage,
        tasksByStatus,
        recentActivity: recentActivityWithProjects
      }
    });
  } catch (e) {
    next(e);
  }
});

// Next-action candidates across all projects (factual only)
router.get('/dashboard/next-actions', async (_req, res, next) => {
  try {
    const [projects, blocked, overdue, critical] = await Promise.all([
      prisma.project.findMany({ where: { isArchived: false }, orderBy: { updatedAt: 'desc' } }),
      prisma.task.groupBy({ by: ['projectId'], where: { status: 'BLOCKED' }, _count: true }),
      prisma.task.groupBy({ by: ['projectId'], where: { dueDate: { lt: new Date() }, status: { in: ['TODO', 'IN_PROGRESS', 'BLOCKED', 'TESTING'] } }, _count: true }),
      prisma.issue.groupBy({ by: ['projectId'], where: { severity: 'CRITICAL', status: { in: ['OPEN', 'INVESTIGATING', 'FIXING'] } }, _count: true })
    ]);
    const pmap = new Map(projects.map(p => [p.id, p]));
    const actions: Array<{ projectId: number; projectName: string; text: string }> = [];
    for (const b of blocked) {
      const p = pmap.get(b.projectId);
      if (p) actions.push({ projectId: p.id, projectName: p.name, text: `${b._count} blocked task${b._count > 1 ? 's' : ''}` });
    }
    for (const o of overdue) {
      const p = pmap.get(o.projectId);
      if (p) actions.push({ projectId: p.id, projectName: p.name, text: `${o._count} task${o._count > 1 ? 's are' : ' is'} overdue` });
    }
    for (const c of critical) {
      const p = pmap.get(c.projectId);
      if (p) actions.push({ projectId: p.id, projectName: p.name, text: `${c._count} open critical issue${c._count > 1 ? 's' : ''}` });
    }
    res.json({ data: actions });
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// Global search
// --------------------------------------------------------------------------

router.get('/search', async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) return res.json({ data: {} });
    const contains = { contains: q, mode: 'insensitive' as const };
    const limit = 25;

    const [projects, tasks, issues, research, prompts, documents, decisions, devSessions, notes, requirements, features, deployments] = await Promise.all([
      prisma.project.findMany({ where: { OR: [{ name: contains }, { description: contains }, { problem: contains }, { motivation: contains }], isArchived: false }, take: limit, select: { id: true, slug: true, name: true, stage: true, isArchived: true, description: true, updatedAt: true } }),
      prisma.task.findMany({ where: { OR: [{ title: contains }, { description: contains }, { code: contains }] }, take: limit, include: { project: { select: { id: true, name: true, slug: true } } } }),
      prisma.issue.findMany({ where: { OR: [{ title: contains }, { description: contains }, { code: contains }] }, take: limit, include: { project: { select: { id: true, name: true, slug: true } } } }),
      prisma.researchEntry.findMany({ where: { OR: [{ title: contains }, { summary: contains }, { findings: contains }] }, take: limit, include: { project: { select: { id: true, name: true, slug: true } } } }),
      prisma.prompt.findMany({ where: { OR: [{ title: contains }, { purpose: contains }, { resultNote: contains }, { versions: { some: { text: { contains: q, mode: 'insensitive' } } } }] }, take: limit, include: { project: { select: { id: true, name: true, slug: true } } } }),
      prisma.projectDocument.findMany({ where: { OR: [{ title: contains }, { versions: { some: { content: { contains: q, mode: 'insensitive' } } } }] }, take: limit, include: { project: { select: { id: true, name: true, slug: true } } } }),
      prisma.architectureDecision.findMany({ where: { OR: [{ title: contains }, { decision: contains }, { context: contains }] }, take: limit, include: { project: { select: { id: true, name: true, slug: true } } } }),
      prisma.developmentSession.findMany({ where: { OR: [{ goal: contains }, { workedOn: contains }, { learned: contains }] }, take: limit, include: { project: { select: { id: true, name: true, slug: true } } } }),
      prisma.note.findMany({ where: { OR: [{ title: contains }, { content: contains }] }, take: limit, include: { project: { select: { id: true, name: true, slug: true } } } }),
      prisma.requirement.findMany({ where: { OR: [{ title: contains }, { description: contains }, { code: contains }] }, take: limit, include: { project: { select: { id: true, name: true, slug: true } } } }),
      prisma.feature.findMany({ where: { OR: [{ name: contains }, { description: contains }] }, take: limit, include: { project: { select: { id: true, name: true, slug: true } } } }),
      prisma.deployment.findMany({ where: { OR: [{ version: contains }, { platform: contains }, { url: contains }, { notes: contains }] }, take: limit, include: { project: { select: { id: true, name: true, slug: true } } } })
    ]);

    const allIds: number[] = [];
    const collect = (rows: any[], type: string) => rows.map((r: any) => {
      const root = r.project ?? r;
      if (!allIds.includes(root.id)) allIds.push(root.id);
      return { id: r.id, type, title: pickTitle(type, r), project: root, url: buildUrl(type, root.slug, r.id) };
    });

    res.json({
      data: {
        projects: projects.map(p => ({ id: p.id, type: 'project', title: p.name, subtitle: p.description, project: { id: p.id, name: p.name, slug: p.slug }, url: `/projects/${p.slug}`, stage: p.stage })),
        tasks: collect(tasks, 'task'),
        issues: collect(issues, 'issue'),
        research: collect(research, 'research'),
        prompts: collect(prompts, 'prompt'),
        documents: collect(documents, 'document'),
        decisions: collect(decisions, 'decision'),
        developmentSessions: collect(devSessions, 'development-session'),
        notes: collect(notes, 'note'),
        requirements: collect(requirements, 'requirement'),
        features: collect(features, 'feature'),
        deployments: collect(deployments, 'deployment')
      }
    });
  } catch (e) {
    next(e);
  }
});

function pickTitle(type: string, r: any): string {
  switch (type) {
    case 'prompt': return `${r.code ?? 'PROMPT'} ${r.title ?? r.purpose ?? ''}`.trim();
    case 'task': return `${r.code} ${r.title}`.trim();
    case 'issue': return `${r.code} ${r.title}`.trim();
    case 'research': return r.title;
    case 'document': return r.title;
    case 'decision': return `${r.code} ${r.title}`.trim();
    case 'development-session': return `Dev Session #${r.number}`;
    case 'note': return r.title ?? 'Note';
    case 'requirement': return `${r.code} ${r.title}`.trim();
    case 'feature': return r.name;
    case 'deployment': return `${r.environment} ${r.version ?? ''}`.trim();
    default: return 'Item';
  }
}

function buildUrl(type: string, slug: string, _id: number): string {
  switch (type) {
    case 'task': return `/projects/${slug}/tasks`;
    case 'issue': return `/projects/${slug}/issues`;
    case 'research': return `/projects/${slug}/research`;
    case 'prompt': return `/projects/${slug}/prompts`;
    case 'document': return `/projects/${slug}/documents`;
    case 'decision': return `/projects/${slug}/decisions`;
    case 'development-session': return `/projects/${slug}/development`;
    case 'note': return `/projects/${slug}/notes`;
    case 'requirement': return `/projects/${slug}/requirements`;
    case 'feature': return `/projects/${slug}/features`;
    case 'deployment': return `/projects/${slug}/deployments`;
    default: return `/projects/${slug}`;
  }
}

// --------------------------------------------------------------------------
// Tags
// --------------------------------------------------------------------------

router.get('/tags', async (_req, res, next) => {
  try {
    res.json({ data: await tagUsage() });
  } catch (e) {
    next(e);
  }
});

router.post('/tags', async (req, res, next) => {
  try {
    const parsed = z.object({ name: z.string().trim().min(1).max(50), color: z.string().optional().nullable() }).safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid tag name');
    const name = parsed.data.name.toLowerCase().replace(/\s+/g, '-');
    const tag = await prisma.tag.upsert({
      where: { name },
      create: { name, color: parsed.data.color ?? undefined },
      update: { color: parsed.data.color ?? undefined }
    });
    res.status(201).json({ data: tag });
  } catch (e) {
    next(e);
  }
});

router.put('/tags/:id', async (req, res, next) => {
  try {
    const parsed = z.object({ name: z.string().trim().min(1).max(50).optional(), color: z.string().optional().nullable() }).safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid input');
    const data: any = {};
    if (parsed.data.name) data.name = parsed.data.name.toLowerCase().replace(/\s+/g, '-');
    if (parsed.data.color !== undefined) data.color = parsed.data.color;
    const tag = await prisma.tag.update({ where: { id: Number(req.params.id) }, data });
    res.json({ data: tag });
  } catch (e) {
    next(e);
  }
});

router.delete('/tags/:id', async (req, res, next) => {
  try {
    await prisma.tagAssignment.deleteMany({ where: { tagId: Number(req.params.id) } });
    const tag = await prisma.tag.delete({ where: { id: Number(req.params.id) } });
    res.json({ data: { id: tag.id, deleted: true } });
  } catch (e) {
    next(e);
  }
});

// Tag assignments for scoped resources
router.get('/tags/:taggableType/:id', async (req, res, next) => {
  try {
    const type = req.params.taggableType;
    if (!taggableType.safeParse(type).success) throw badRequest('Invalid taggable type');
    const rows = await prisma.tagAssignment.findMany({
      where: { taggableType: type, taggableId: Number(req.params.id) },
      include: { tag: true }
    });
    res.json({ data: rows.map(r => r.tag) });
  } catch (e) {
    next(e);
  }
});

router.post('/tags/:taggableType/:id', async (req, res, next) => {
  try {
    const type = req.params.taggableType;
    if (!taggableType.safeParse(type).success) throw badRequest('Invalid taggable type');
    const parsed = z.object({ names: z.array(z.string()) }).safeParse(req.body);
    if (!parsed.success) throw badRequest('names[] required');
    await addTags(type as any, Number(req.params.id), parsed.data.names);
    const rows = await prisma.tagAssignment.findMany({ where: { taggableType: type, taggableId: Number(req.params.id) }, include: { tag: true } });
    res.json({ data: rows.map(r => r.tag) });
  } catch (e) {
    next(e);
  }
});

router.delete('/tags/:taggableType/:id/:tagId', async (req, res, next) => {
  try {
    const type = req.params.taggableType;
    if (!taggableType.safeParse(type).success) throw badRequest('Invalid taggable type');
    await removeTag(type as any, Number(req.params.id), Number(req.params.tagId));
    res.json({ data: { removed: true } });
  } catch (e) {
    next(e);
  }
});

export default router;