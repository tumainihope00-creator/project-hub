import type { Request, Router } from 'express';
import { Router as createRouter } from 'express';
import { badRequest, notFound } from '../lib/errors.js';
import { logActivity } from '../lib/activity.js';
import { prisma } from '../lib/prisma.js';
import { intFromQuery } from '../lib/validation.js';
import type { Ctx, ResourceDef } from '../resources.js';
import { taggableKeyFor, setTags, tagsFor } from '../lib/tags.js';

function pad(n: number, width = 3): string {
  return String(n).padStart(width, '0');
}

async function nextCode(def: ResourceDef, projectId: number): Promise<string | undefined> {
  if (!def.codePrefix) return undefined;
  const rows = await (prisma as any)[def.model].findMany({
    where: { projectId },
    select: { code: true }
  });
  const prefix = def.codePrefix.toUpperCase();
  let max = 0;
  for (const r of rows) {
    const m = /(\d+)$/.exec(r.code ?? '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${pad(max + 1)}`;
}

async function nextNumber(def: ResourceDef, projectId: number): Promise<number | undefined> {
  if (!def.numbered) return undefined;
  const rows = await (prisma as any)[def.model].findMany({
    where: { projectId },
    select: { number: true }
  });
  const max = (rows as Array<{ number: number | null }>).reduce((m, r) => Math.max(m, r.number ?? 0), 0);
  return max + 1;
}

async function createVersion(row: { id: number; projectId: number; code: string }, input: any): Promise<void> {
  const existing = await prisma.promptVersion.count({ where: { promptId: row.id } });
  const version = await prisma.promptVersion.create({
    data: {
      promptId: row.id,
      version: existing + 1,
      text: input.text ?? '',
      response: input.response ?? null,
      changes: 'Initial version'
    }
  });
  await prisma.prompt.update({
    where: { id: row.id },
    data: { finalVersionId: version.id }
  });
}

async function createDocumentVersion(docId: number, title: string, content: string, reason?: string | null): Promise<void> {
  const existing = await prisma.projectDocumentVersion.count({ where: { documentId: docId } });
  await prisma.projectDocumentVersion.create({
    data: {
      documentId: docId,
      version: existing + 1,
      title,
      content: content ?? '',
      reason: reason ?? null
    }
  });
}

export function applyDerived(model: string, data: Record<string, any>): void {
  if (model === 'task' && data.status === 'COMPLETED') data.completedAt = new Date();
  if (model === 'issue' && ['RESOLVED', 'CLOSED', 'WONT_FIX'].includes(data.status) && !data.resolvedAt) {
    data.resolvedAt = new Date();
  }
}

export function resourceRouter(def: ResourceDef): Router {
  const router = createRouter({ mergeParams: true });
  const delegate = () => (prisma as any)[def.model];
  const taggableType = taggableKeyFor(def.model);

  const ctxOf = (req: Request): Ctx => ({ projectId: Number(req.params.projectId) });

  const attachTags = async (rows: any[]): Promise<any[]> => {
    if (!def.taggable || !taggableType || rows.length === 0) return rows;
    const ids = rows.map(r => r.id);
    const assigns = await prisma.tagAssignment.findMany({
      where: { taggableType, taggableId: { in: ids } },
      include: { tag: true }
    });
    const map = new Map<number, string[]>();
    for (const a of assigns) {
      if (!map.has(a.taggableId)) map.set(a.taggableId, []);
      map.get(a.taggableId)!.push(a.tag.name);
    }
    for (const r of rows) r.tags = map.get(r.id) ?? [];
    return rows;
  };

  const loadOne = async (req: Request) => {
    const id = Number(req.params.id);
    const row = await delegate().findFirst({
      where: { id, projectId: ctxOf(req).projectId },
      ...(def.include ? { include: def.include } : {})
    });
    if (!row) throw notFound(`${def.label} not found`);
    if (def.taggable && taggableType) {
      const tags = await tagsFor(taggableType, row.id);
      row.tags = tags.map(t => t.name);
    }
    return row;
  };

  // List
  router.get('/', async (req, res, next) => {
    try {
      const projectId = ctxOf(req).projectId;
      const page = intFromQuery(req.query.page, 1, 100000);
      const pageSize = intFromQuery(req.query.pageSize, 100, 500);
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const where: Record<string, any> = { projectId };

      // Generic equality filters (status, priority, type, result, environment...)
      for (const [key, value] of Object.entries(req.query)) {
        if (['q', 'page', 'pageSize', 'sort', 'order'].includes(key)) continue;
        if (typeof value === 'string' && value.length > 0) where[key] = value;
      }

      if (q && def.searchFields?.length) {
        where.OR = def.searchFields.map(field => ({
          [field]: { contains: q, mode: 'insensitive' }
        }));
      }

      const [rows, total] = await Promise.all([
        delegate().findMany({
          where,
          ...(def.include ? { include: def.include } : {}),
          orderBy: def.orderBy ?? { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize
        }),
        delegate().count({ where })
      ]);

      await attachTags(rows);
      res.json({ data: rows, meta: { total, page, pageSize } });
    } catch (e) {
      next(e);
    }
  });

  // Create
  router.post('/', async (req, res, next) => {
    try {
      const projectId = ctxOf(req).projectId;
      const parsed = def.createSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest('Invalid input', parsed.error.flatten());

      const input: Record<string, any> = { ...parsed.data };
      const tagNames = Array.isArray(req.body.tags) ? req.body.tags.filter((t: unknown) => typeof t === 'string') : [];
      const code = await nextCode(def, projectId);
      const number = await nextNumber(def, projectId);
      if (code !== undefined) input.code = code;
      if (number !== undefined) input.number = number;
      applyDerived(def.model, input);

      if (def.hooks?.beforeCreate) {
        const result = await def.hooks.beforeCreate(input, ctxOf(req));
        if (result !== undefined) Object.assign(input, result);
      }

      let row: any;
      if (def.path === 'documents') {
        row = await prisma.projectDocument.create({
          data: { projectId, type: input.type ?? 'OTHER', title: input.title, currentVersion: 1 }
        });
        await createDocumentVersion(row.id, input.title, input.content ?? '', input.reason);
        row = await prisma.projectDocument.findUnique({
          where: { id: row.id },
          include: def.include
        });
      } else if (def.path === 'prompts') {
        const { text: _text, response: _response, ...promptData } = input;
        row = await delegate().create({ data: { projectId, ...promptData } });
        await createVersion(row, input);
      } else {
        row = await delegate().create({ data: { projectId, ...input } });
      }

      if (def.hooks?.afterCreate) await def.hooks.afterCreate(row, input, ctxOf(req));
      if (def.hooks?.afterSave) await def.hooks.afterSave(row, input, ctxOf(req));
      if (def.taggable && tagNames.length && taggableKeyFor(def.model)) {
        await setTags(taggableKeyFor(def.model)!, row.id, tagNames);
      }
      if (def.taggable && taggableKeyFor(def.model)) {
        row.tags = (await tagsFor(taggableKeyFor(def.model)!, row.id)).map(t => t.name);
      }
      if (def.activity.create) {
        await logActivity({
          projectId,
          type: def.activity.create,
          description: `${def.label} created: ${def.describe ? def.describe(row) : def.label}`,
          relatedType: def.model,
          relatedId: row.id
        });
      }
      res.status(201).json({ data: row });
    } catch (e) {
      next(e);
    }
  });

  // Get one
  router.get('/:id', async (req, res, next) => {
    try {
      res.json({ data: await loadOne(req) });
    } catch (e) {
      next(e);
    }
  });

  // Update
  router.put('/:id', async (req, res, next) => {
    try {
      const current = await loadOne(req);
      const { tags: _tagInput, ...bodyForParse } = (req.body ?? {}) as Record<string, unknown>;
      const parsed = def.updateSchema.safeParse(bodyForParse);
      if (!parsed.success) throw badRequest('Invalid input', parsed.error.flatten());

      const input: Record<string, any> = { ...parsed.data };
      applyDerived(def.model, input);
      if (def.path === 'prompts') {
        delete input.text;
        delete input.response;
      }

      const tagNames = Array.isArray(req.body.tags) ? req.body.tags.filter((t: unknown) => typeof t === 'string') : [];

      if (def.hooks?.beforeUpdate) {
        const result = await def.hooks.beforeUpdate(current.id, input, current, ctxOf(req));
        if (result !== undefined) Object.assign(input, result);
      }

      let row: any;
      if (def.path === 'documents') {
        const meta: Record<string, any> = {};
        if (input.title !== undefined) meta.title = input.title;
        if (input.type !== undefined) meta.type = input.type;
        if (input.content !== undefined) {
          await createDocumentVersion(current.id, input.title ?? current.title, input.content, input.reason);
          meta.currentVersion = current.currentVersion + 1;
        }
        row = await prisma.projectDocument.update({ where: { id: current.id }, data: meta, include: def.include });
      } else {
        row = await delegate().update({ where: { id: current.id }, data: input });
      }

      if (def.hooks?.afterUpdate) await def.hooks.afterUpdate(row, input, ctxOf(req));
      if (def.hooks?.afterSave) await def.hooks.afterSave(row, input, ctxOf(req));
      if (def.taggable && taggableKeyFor(def.model) && Array.isArray(req.body.tags)) {
        await setTags(taggableKeyFor(def.model)!, row.id, tagNames);
      }
      if (def.taggable && taggableKeyFor(def.model)) {
        row.tags = (await tagsFor(taggableKeyFor(def.model)!, row.id)).map(t => t.name);
      }
      if (def.activity.update) {
        await logActivity({
          projectId: current.projectId,
          type: def.activity.update,
          description: `${def.label} updated: ${def.describe ? def.describe(row) : def.label}`,
          relatedType: def.model,
          relatedId: row.id
        });
      }
      res.json({ data: row });
    } catch (e) {
      next(e);
    }
  });

  // Delete
  router.delete('/:id', async (req, res, next) => {
    try {
      const current = await loadOne(req);
      await delegate().delete({ where: { id: current.id } });
      res.json({ data: { id: current.id, deleted: true } });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// Feature-specific: link/unlink requirements (many-to-many join model)
export function featureRequirementsRouter(): Router {
  const router = createRouter({ mergeParams: true });

  const resolveFeature = async (projectId: number, id: number) => {
    const feature = await prisma.feature.findFirst({ where: { id, projectId } });
    if (!feature) throw notFound('Feature not found');
    return feature;
  };

  router.get('/:id/requirements', async (req, res, next) => {
    try {
      const params = req.params as Record<string, string>;
      const id = Number(params.id);
      const projectId = Number(params.projectId);
      await resolveFeature(projectId, id);
      const links = await prisma.featureRequirement.findMany({
        where: { featureId: id },
        include: { requirement: true }
      });
      res.json({ data: links.map(l => l.requirement), meta: { total: links.length } });
    } catch (e) {
      next(e);
    }
  });

  router.post('/:id/requirements', async (req, res, next) => {
    try {
      const params = req.params as Record<string, string>;
      const id = Number(params.id);
      const projectId = Number(params.projectId);
      const feature = await resolveFeature(projectId, id);
      const requirementId = Number(req.body?.requirementId);
      if (!Number.isInteger(requirementId) || requirementId <= 0) throw badRequest('requirementId is required');
      const requirement = await prisma.requirement.findFirst({ where: { id: requirementId, projectId } });
      if (!requirement) throw notFound('Requirement not found');
      const link = await prisma.featureRequirement.upsert({
        where: { featureId_requirementId: { featureId: id, requirementId } },
        create: { featureId: id, requirementId },
        update: {}
      });
      await logActivity({
        projectId,
        type: 'FEATURE_UPDATED',
        description: `Requirement ${requirement.code} linked to feature "${feature.name}"`,
        relatedType: 'feature',
        relatedId: id
      });
      res.status(201).json({ data: link });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id/requirements/:requirementId', async (req, res, next) => {
    try {
      const params = req.params as Record<string, string>;
      const id = Number(params.id);
      const projectId = Number(params.projectId);
      const requirementId = Number(params.requirementId);
      await resolveFeature(projectId, id);
      const link = await prisma.featureRequirement.findUnique({
        where: { featureId_requirementId: { featureId: id, requirementId } }
      });
      if (!link) throw notFound('Link not found');
      await prisma.featureRequirement.delete({ where: { id: link.id } });
      res.json({ data: { deleted: true } });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// Document-specific: list version history
export function documentVersionRouter(): Router {
  const router = createRouter({ mergeParams: true });
  router.get('/:id/versions', async (req, res, next) => {
    try {
      const params = req.params as Record<string, string>;
      const id = Number(params.id);
      const projectId = Number(params.projectId);
      const doc = await prisma.projectDocument.findFirst({ where: { id, projectId } });
      if (!doc) throw notFound('Document not found');
      const versions = await prisma.projectDocumentVersion.findMany({
        where: { documentId: id },
        orderBy: { version: 'desc' }
      });
      res.json({ data: versions, meta: { total: versions.length } });
    } catch (e) {
      next(e);
    }
  });
  return router;
}

// Prompt-specific: list version history + add a version
export function promptVersionRouter(): Router {
  const router = createRouter({ mergeParams: true });
  router.get('/:id/versions', async (req, res, next) => {
    try {
      const params = req.params as Record<string, string>;
      const id = Number(params.id);
      const projectId = Number(params.projectId);
      const prompt = await prisma.prompt.findFirst({ where: { id, projectId } });
      if (!prompt) throw notFound('Prompt not found');
      const versions = await prisma.promptVersion.findMany({
        where: { promptId: id },
        orderBy: { version: 'desc' }
      });
      res.json({ data: versions, meta: { total: versions.length } });
    } catch (e) {
      next(e);
    }
  });
  router.post('/:id/versions', async (req, res, next) => {
    try {
      const params = req.params as Record<string, string>;
      const id = Number(params.id);
      const projectId = Number(params.projectId);
      const existing = await prisma.prompt.findFirst({ where: { id, projectId } });
      if (!existing) throw notFound('Prompt not found');

      const text = typeof req.body.text === 'string' ? req.body.text : null;
      if (!text) throw badRequest('Version text is required');
      const response = typeof req.body.response === 'string' ? req.body.response : null;
      const changes = typeof req.body.changes === 'string' ? req.body.changes : null;
      const reason = typeof req.body.reason === 'string' ? req.body.reason : null;

      const count = await prisma.promptVersion.count({ where: { promptId: id } });
      const version = await prisma.promptVersion.create({
        data: { promptId: id, version: count + 1, text, response, changes, reason }
      });
      await prisma.prompt.update({
        where: { id },
        data: {
          finalVersionId: version.id,
          ...(req.body.title ? { title: req.body.title } : {})
        }
      });
      await logActivity({
        projectId,
        type: 'PROMPT_VERSIONED',
        description: `Version v${version.version} added to prompt ${existing.code}`,
        relatedType: 'prompt',
        relatedId: id
      });
      res.status(201).json({ data: version });
    } catch (e) {
      next(e);
    }
  });
  return router;
}