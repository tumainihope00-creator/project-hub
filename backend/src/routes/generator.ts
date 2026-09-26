import { Router as createRouter } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { badRequest, dataMissing, notFound } from '../lib/errors.js';
import { logActivity } from '../lib/activity.js';
import { collectGenerationContext } from '../lib/generator/collect.js';
import {
  MissingInformationError,
  buildReadinessReport,
  generateV1Prompt
} from '../lib/generator/pipeline.js';
import {
  COMPLETABLE_PROJECT_FIELDS
} from '../lib/generator/readiness.js';
import { assessText } from '../lib/generator/readiness.js';
import {
  AI_ENVIRONMENTS,
  DEFAULT_OPTIONS,
  DEVELOPMENT_APPROACHES,
  TARGET_PLATFORMS,
  TECHNOLOGY_PREFERENCES
} from '../lib/generator/types.js';
import type { GeneratorOptions } from '../lib/generator/types.js';

const GENERATED_CATEGORY = 'V1 Build Prompt';

const optionsSchema = z
  .object({
    targetPlatform: z.enum([...TARGET_PLATFORMS]).optional(),
    technology: z.enum([...TECHNOLOGY_PREFERENCES]).optional(),
    customTech: z.string().trim().max(500).optional().nullable(),
    developmentApproach: z.enum([...DEVELOPMENT_APPROACHES]).optional(),
    aiEnvironment: z.enum([...AI_ENVIRONMENTS]).optional()
  })
  .strict();

const genOptionsFrom = (body: unknown): GeneratorOptions => {
  const parsed = optionsSchema.partial().safeParse(body ?? {});
  if (!parsed.success) {
    throw badRequest(
      'The generator options are not valid. Send only: targetPlatform, technology, customTech, developmentApproach, aiEnvironment.',
      parsed.error.flatten()
    );
  }
  return { ...DEFAULT_OPTIONS, ...parsed.data };
};

/** Rejects a wizard payload that tries to write a column the project does not have. */
const completableSchema = z
  .object(
    Object.fromEntries(
      COMPLETABLE_PROJECT_FIELDS.map(f => [f, z.string().trim().max(20000).optional().nullable()])
    )
  )
  .strict();

/** Minimum useful length per project column, so the wizard cannot save noise. */
const MIN_USEFUL: Record<string, number> = {
  description: 15,
  problem: 15,
  targetUsers: 8,
  expectedValue: 10,
  v1Scope: 15,
  motivation: 10,
  assumptions: 10,
  initialQuestions: 10,
  inspiration: 2,
  repositoryUrl: 4,
  name: 2
};

async function nextPromptCode(projectId: number): Promise<string> {
  const rows = await prisma.prompt.findMany({ where: { projectId }, select: { code: true } });
  let max = 0;
  for (const r of rows) {
    const m = /(\d+)$/.exec(r.code ?? '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `PROMPT-${String(max + 1).padStart(4, '0')}`;
}

/** Only forwards the option keys the schema knows about, so ?foo=1 is ignored. */
const optionsFromQuery = (query: unknown): unknown => {
  if (!query || typeof query !== 'object') return {};
  const src = query as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(optionsSchema.shape)) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
};

export interface GeneratorAdminPayload {
  promptId: number;
  promptCode: string;
  promptTitle: string;
  version: number;
  generationId: number;
}

export function generatorRouter(): ReturnType<typeof createRouter> {
  const router = createRouter({ mergeParams: true });
  const projectIdOf = (req: { params: Record<string, string> }) => Number(req.params.projectId);

  router.get('/context', async (req, res, next) => {
    try {
      const context = await collectGenerationContext(projectIdOf(req));
      res.json({ data: context });
    } catch (e) {
      next(e);
    }
  });

  /**
   * The Prompt Readiness Check. Evaluates every expected item independently and
   * reports what exists, what is missing, and why it matters. Never fails because
   * information is absent — that is the answer, not an error.
   */
  router.get('/readiness', async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      const options = genOptionsFrom(req.body?.options ?? optionsFromQuery(req.query));
      const { readiness, failures } = await buildReadinessReport(projectId, options);
      res.json({ data: readiness, meta: { sourceFailures: failures.length } });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Wizard save. Writes the answers straight to the existing project columns —
   * no new tables, no wizard-local storage — then returns a recalculated
   * readiness report so the checklist is always derived from the project.
   */
  router.post('/readiness/complete', async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      const existing = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true }
      });
      if (!existing) {
        throw notFound(
          `Project ${projectId} was not found, so the answers could not be saved.`,
          'save wizard answers to the project',
          'Reload Project Hub. If the project was deleted, its answers cannot be stored.'
        );
      }

      const parsed = completableSchema.safeParse(req.body?.values ?? {});
      if (!parsed.success) {
        throw badRequest(
          'The wizard sent fields this project does not have. Only existing project fields can be saved.',
          parsed.error.flatten()
        );
      }

      const values = parsed.data as Record<string, string | null | undefined>;
      const data: Record<string, string> = {};
      const rejected: Record<string, string> = {};

      for (const [field, raw] of Object.entries(values)) {
        if (raw === undefined || raw === null) continue;
        const trimmed = String(raw).trim();
        if (trimmed.length === 0) continue;
        const assessment = assessText(trimmed, { minTokens: 1 });
        if (assessment.quality === 'placeholder') {
          rejected[field] = `"${trimmed}" is a placeholder, not usable documentation.`;
          continue;
        }
        const min = MIN_USEFUL[field];
        if (min !== undefined && trimmed.length < min) {
          rejected[field] = `Too short to be useful — ${trimmed.length} character(s), at least ${min} expected.`;
          continue;
        }
        if (field === 'repositoryUrl' && !/^https?:\/\/\S+$/i.test(trimmed)) {
          rejected[field] = 'A repository must be a full http(s) URL.';
          continue;
        }
        data[field] = trimmed;
      }

      if (Object.keys(data).length === 0) {
        throw dataMissing(
          'None of the answers were usable, so nothing was saved to the project.',
          'validate wizard answers before writing them to the project',
          'Fill in each step with real information. Placeholder or near-empty values are rejected so the project stays trustworthy.',
          { rejected }
        );
      }

      if (existing.name !== data.name) {
        // Keep the slug stable — the project URL must not change underneath the user.
        delete data.name;
      }

      const updated = await prisma.project.update({
        where: { id: projectId },
        data,
        select: { id: true, name: true, updatedAt: true }
      });

      await logActivity({
        projectId,
        type: 'PROJECT_UPDATED',
        description: `Project "${updated.name}" — completed ${Object.keys(data).length} V1 readiness item(s): ${Object.keys(data).join(', ')}`,
        relatedType: 'project',
        relatedId: projectId,
        metadata: { fields: Object.keys(data), source: 'v1-prompt-readiness-wizard' }
      });

      const options = genOptionsFrom(req.body?.options);
      const { readiness } = await buildReadinessReport(projectId, options);

      res.json({
        data: {
          saved: Object.keys(data),
          rejected,
          project: updated,
          readiness
        }
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/generate', async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      const options = genOptionsFrom(req.body?.options);
      // "Proceed anyway" is explicit. Without it, missing required information
      // returns the full readiness report instead of a bare failure.
      const proceedAnyway = req.body?.proceedAnyway === true;
      const result = await generateV1Prompt(projectId, options, proceedAnyway);
      res.json({ data: result });
    } catch (e) {
      if (e instanceof MissingInformationError) {
        return res.status(409).json({
          error: {
            message: e.message,
            category: 'DATA_MISSING',
            operation: 'generate the V1 build prompt',
            possibleAction:
              'Fill in the missing information, or confirm "Proceed anyway" to generate using the data that does exist.',
            details: { readiness: e.readiness }
          }
        });
      }
      next(e);
    }
  });

  router.post('/save', async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        throw notFound(
          `Project ${projectId} was not found, so the prompt could not be saved.`,
          'save the generated prompt against the project',
          'Reload Project Hub. If the project was deleted, its prompts cannot be stored.'
        );
      }

      const text = typeof req.body?.promptText === 'string' ? req.body.promptText.trim() : '';
      if (!text) throw badRequest('promptText is required');

      const options = genOptionsFrom(req.body?.options);
      const changes = typeof req.body?.changes === 'string' && req.body.changes.trim() ? req.body.changes.trim() : null;
      const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : null;
      const updateSidebar = req.body?.updateProjectScope === true;
      const readiness =
        typeof req.body?.readiness === 'number' && Number.isFinite(req.body.readiness)
          ? Math.min(100, Math.max(0, req.body.readiness))
          : null;
      const itemsJson =
        typeof req.body?.items === 'string' && req.body.items.trim() ? req.body.items : null;
      const analysisJson =
        typeof req.body?.analysis === 'string' && req.body.analysis.trim() ? req.body.analysis : null;
      const snapshotJson =
        typeof req.body?.sourceSnapshot === 'string' && req.body.sourceSnapshot.trim()
          ? req.body.sourceSnapshot
          : null;

      const code = await nextPromptCode(projectId);
      const title = req.body?.title && typeof req.body.title === 'string' && req.body.title.trim()
        ? req.body.title.trim()
        : 'V1 Build Prompt';

      // Subsequent saves append a new version to the latest generated prompt for
      // this project, so the history reads v1 → v2 → v3 (the system picks the
      // version number, never overwriting an existing one). A fresh prompt series
      // is only started when there is no prior generated prompt.
      const previous = await prisma.promptGeneration.findFirst({
        where: { projectId, promptType: 'V1_BUILD_PROMPT' },
        orderBy: { createdAt: 'desc' },
        select: { promptId: true }
      });

      let prompt = previous
        ? await prisma.prompt.findUnique({ where: { id: previous.promptId } })
        : null;
      if (!prompt) {
        prompt = await prisma.prompt.create({
          data: {
            projectId,
            code,
            title,
            purpose: 'Generated by the V1 Prompt Generator from the project data collected in Project Hub.',
            category: GENERATED_CATEGORY,
            stage: project.stage,
            tool: options.aiEnvironment,
            result: 'GENERATED',
            resultNote: 'Generated prompt — not yet evaluated against an AI run.'
          }
        });
      }

      const count = await prisma.promptVersion.count({ where: { promptId: prompt.id } });
      const version = await prisma.promptVersion.create({
        data: {
          promptId: prompt.id,
          version: count + 1,
          text,
          changes: changes ?? (count === 0 ? 'Initial generation' : null),
          reason: reason ?? null
        }
      });

      await prisma.prompt.update({
        where: { id: prompt.id },
        data: { finalVersionId: version.id }
      });

      const generation = await prisma.promptGeneration.create({
        data: {
          projectId,
          promptId: prompt.id,
          promptType: 'V1_BUILD_PROMPT',
          version: version.version,
          versionId: version.id,
          config: JSON.stringify(options),
          readiness,
          items: itemsJson,
          analysis: analysisJson,
          sourceSnapshot: snapshotJson
        }
      });

      let updatedProjectV1Scope = false;
      if (updateSidebar && req.body?.v1Scope && typeof req.body.v1Scope === 'string' && req.body.v1Scope.trim()) {
        const current = await prisma.project.findUnique({ where: { id: projectId }, select: { v1Scope: true } });
        if (!current?.v1Scope || current.v1Scope.trim() === '') {
          await prisma.project.update({
            where: { id: projectId },
            data: { v1Scope: req.body.v1Scope.trim() }
          });
          updatedProjectV1Scope = true;
        }
      }

      await logActivity({
        projectId,
        type: 'PROMPT_GENERATED',
        description: `V1 build prompt generated and saved as ${code}`,
        relatedType: 'prompt',
        relatedId: prompt.id,
        metadata: { version: version.version, readiness }
      });

      res.status(201).json({
        data: {
          generation,
          versionNumber: version.version,
          prompt: { id: prompt.id, code, title, category: GENERATED_CATEGORY },
          promptVersion: version
        },
        meta: { updatedProjectV1Scope }
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/versions', async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      const rows = await prisma.promptGeneration.findMany({
        where: { projectId, promptType: 'V1_BUILD_PROMPT' },
        orderBy: { createdAt: 'desc' },
        include: {
          prompt: { select: { id: true, code: true, title: true, category: true, updatedAt: true } },
          project: { select: { v1Scope: true } }
        }
      });
      res.json({ data: rows, meta: { total: rows.length } });
    } catch (e) {
      next(e);
    }
  });

  return router;
}