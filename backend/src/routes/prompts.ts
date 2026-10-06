import { Router } from 'express';
import { badRequest, notFound } from '../lib/errors.js';
import { logActivity } from '../lib/activity.js';
import { prisma } from '../lib/prisma.js';
import { appendPromptVersion } from '../lib/promptLibrary.js';
import {
  PROMPT_PURPOSES,
  buildPromptContext,
  buildPromptDraft,
  buildPromptReadiness,
  isPromptPurpose
} from '../lib/promptContext.js';
import { PROMPT_STATUSES } from '../resources.js';
import { intFromQuery } from '../lib/validation.js';

/**
 * Phase 8 prompt routes.
 *
 * Two routers, because the endpoints live in two different places:
 *
 * - `projectPromptsRouter`  → /api/projects/:projectId/prompts/{generate,:id/copy,:id/archive}
 *   Mounted before the generic resource router so these named paths are never
 *   mistaken for a prompt id.
 * - `globalPromptsRouter`   → /api/prompts (search across projects) and
 *   /api/prompts/:id (one prompt with its history, for detail views).
 *
 * Nothing here talks to an AI provider. The generator assembles text from the
 * project's own records; using the result with an AI tool is the user's action,
 * outside Project Hub.
 */

const pad = (n: number): string => String(n).padStart(4, '0');

// ---------------------------------------------------------------------------
// Project-scoped actions
// ---------------------------------------------------------------------------

export function projectPromptsRouter(): Router {
  const router = Router({ mergeParams: true });

  /**
   * Readiness + draft for a purpose. Always 200: missing project information is
   * reported in `readiness`, never as an error, so the UI can show the checklist
   * alongside the draft that "Proceed anyway" would save.
   */
  router.post('/generate', async (req, res, next) => {
    try {
      const projectId = Number((req.params as Record<string, string>).projectId);
      const purpose = req.body?.purpose;
      if (!isPromptPurpose(purpose)) {
        throw badRequest(`purpose must be one of: ${PROMPT_PURPOSES.join(', ')}`, {
          allowed: PROMPT_PURPOSES
        });
      }

      const { context, failures } = await buildPromptContext(projectId);
      const readiness = buildPromptReadiness(context, purpose);
      const draft = buildPromptDraft(context, purpose);

      res.json({ data: { readiness, draft }, meta: { failures } });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Duplicate a prompt, optionally into another project.
   *
   * The copy gets a fresh code and a fresh version history (v1 records where it
   * came from) but otherwise faithful content. Two adjustments: status resets to
   * DRAFT because the copy has not been run yet, and task/feature/issue links
   * are kept only when the copy stays in the same project - those ids point at
   * records of the source project and would be dangling references elsewhere.
   */
  router.post('/:id/copy', async (req, res, next) => {
    try {
      const { projectId: projectIdParam, id: idParam } = req.params as Record<string, string>;
      const projectId = Number(projectIdParam);
      const id = Number(idParam);

      const source = await prisma.prompt.findFirst({ where: { id, projectId } });
      if (!source) throw notFound('Prompt not found');

      const requested = req.body?.targetProjectId;
      let targetProjectId = source.projectId;
      if (requested !== undefined && requested !== null) {
        if (!Number.isInteger(requested) || requested <= 0) {
          throw badRequest('targetProjectId must be a positive integer');
        }
        const target = await prisma.project.findUnique({ where: { id: requested } });
        if (!target) throw notFound(`Project ${requested} was not found`);
        targetProjectId = requested;
      }
      const staysHome = targetProjectId === source.projectId;

      const codes = await prisma.prompt.findMany({
        where: { projectId: targetProjectId },
        select: { code: true }
      });
      let max = 0;
      for (const c of codes) {
        const m = /(\d+)$/.exec(c.code ?? '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
      const code = `PROMPT-${pad(max + 1)}`;

      const created = await prisma.$transaction(async tx => {
        const row = await tx.prompt.create({
          data: {
            projectId: targetProjectId,
            code,
            title: source.title,
            purpose: source.purpose,
            category: source.category,
            stage: source.stage,
            tool: source.tool,
            model: source.model,
            date: new Date(),
            taskId: staysHome ? source.taskId : null,
            featureId: staysHome ? source.featureId : null,
            issueId: staysHome ? source.issueId : null,
            result: source.result,
            resultNote: source.resultNote,
            // The copy has not been used yet - DRAFT, not the source's status.
            status: 'DRAFT',
            isReusable: source.isReusable,
            content: source.content
          },
          include: { project: { select: { id: true, name: true, slug: true } } }
        });
        await appendPromptVersion(tx, row, {
          text: source.content,
          response: null,
          changes: `Copied from ${source.code}`
        });
        await logActivity(
          {
            projectId: targetProjectId,
            type: 'PROMPT_RECORDED',
            description: staysHome
              ? `Prompt duplicated: ${source.code} copied as ${code}`
              : `Prompt ${source.code} copied into this project as ${code}`,
            relatedType: 'prompt',
            relatedId: row.id
          },
          tx
        );
        return row;
      });

      res.status(201).json({ data: created });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Archive a prompt: status changes, the row stays. Archived prompts leave the
   * default lists but remain readable (and restorable) - nothing is deleted.
   */
  router.post('/:id/archive', async (req, res, next) => {
    try {
      const { projectId: projectIdParam, id: idParam } = req.params as Record<string, string>;
      const projectId = Number(projectIdParam);
      const id = Number(idParam);

      const prompt = await prisma.prompt.findFirst({ where: { id, projectId } });
      if (!prompt) throw notFound('Prompt not found');

      if (prompt.status !== 'ARCHIVED') {
        await prisma.prompt.update({ where: { id: prompt.id }, data: { status: 'ARCHIVED' } });
        await logActivity({
          projectId,
          type: 'PROMPT_RECORDED',
          description: `Prompt archived: ${prompt.code}${prompt.title ? ` ${prompt.title}` : ''}`,
          relatedType: 'prompt',
          relatedId: prompt.id
        });
      }

      const row = await prisma.prompt.findUnique({
        where: { id: prompt.id },
        include: { project: { select: { id: true, name: true, slug: true } } }
      });
      res.json({ data: row });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Global search / detail
// ---------------------------------------------------------------------------

export function globalPromptsRouter(): Router {
  const router = Router();

  /**
   * Search prompts across projects: title, purpose, category, current content,
   * code and tags. Archived prompts are excluded unless asked for, mirroring the
   * project-scoped list.
   */
  router.get('/', async (req, res, next) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const where: Record<string, unknown> = {};

      if (req.query.projectId !== undefined) {
        const projectId = Number(req.query.projectId);
        if (!Number.isInteger(projectId) || projectId <= 0) throw badRequest('projectId must be a positive integer');
        where.projectId = projectId;
      }

      if (req.query.reusable === 'true') where.isReusable = true;
      else if (req.query.reusable === 'false') where.isReusable = false;

      if (req.query.status !== undefined) {
        const status = String(req.query.status);
        if (!(PROMPT_STATUSES as readonly string[]).includes(status)) {
          throw badRequest(`status must be one of: ${PROMPT_STATUSES.join(', ')}`);
        }
        where.status = status;
      } else if (req.query.includeArchived !== 'true') {
        where.status = { not: 'ARCHIVED' };
      }

      if (q) {
        const contains = { contains: q, mode: 'insensitive' as const };
        const tagged = await prisma.tagAssignment.findMany({
          where: { taggableType: 'prompt', tag: { name: contains } },
          select: { taggableId: true }
        });
        const conditions: Record<string, unknown>[] = [
          { title: contains },
          { purpose: contains },
          { category: contains },
          { content: contains },
          { code: contains },
          { id: { in: tagged.map(t => t.taggableId) } }
        ];
        where.OR = conditions;
      }

      const limit = intFromQuery(req.query.limit, 50, 200);
      const [rows, total] = await Promise.all([
        prisma.prompt.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          take: limit,
          include: {
            project: { select: { id: true, name: true, slug: true } },
            _count: { select: { versions: true } }
          }
        }),
        prisma.prompt.count({ where })
      ]);

      res.json({ data: rows, meta: { total, limit } });
    } catch (e) {
      next(e);
    }
  });

  /** One prompt anywhere, with its project, history and tags. */
  router.get('/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const prompt = await prisma.prompt.findFirst({
        where: { id },
        include: {
          project: { select: { id: true, name: true, slug: true, stage: true } },
          versions: { orderBy: { version: 'desc' } }
        }
      });
      if (!prompt) throw notFound('Prompt not found');

      const assignments = await prisma.tagAssignment.findMany({
        where: { taggableType: 'prompt', taggableId: prompt.id },
        include: { tag: true }
      });

      res.json({ data: { ...prompt, tags: assignments.map(a => a.tag.name) } });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
