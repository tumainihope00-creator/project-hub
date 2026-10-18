import { Router } from 'express';
import { z } from 'zod';
import { badRequest, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { CONTEXT_KEYS, buildPromptContext, type ContextKey } from '../lib/promptContext.js';
import { renderAiContext } from '../lib/ai/context.js';
import { sendAiPrompt } from '../lib/ai/aiService.js';
import { AiSettingsError, getAiSettings, getAiStatus, saveAiSettings } from '../lib/ai/config.js';
import { listAiProviders } from '../lib/ai/registry.js';
import { getAiInteraction, listAiInteractions, saveAiInteraction } from '../lib/ai/interactions.js';

/**
 * Phase 9: the AI API.
 *
 * Two routers, following the existing Express conventions:
 *
 *   /api/ai/status | providers | settings | generate | interactions/:id
 *   /api/projects/:projectId/ai/context | interactions
 *
 * Security posture of these endpoints (see the phase spec, §27):
 *
 *  - Project and prompt ids are validated against the database; a prompt must
 *    belong to the project it is used with.
 *  - Request bodies are strict zod schemas - unknown fields are rejected, so a
 *    client cannot smuggle provider configuration (especially a base URL) into
 *    the backend. The endpoint URL comes from server configuration only.
 *  - The API key is never in any response: settings and status report
 *    `apiKeyConfigured` / `apiKeySource`, and generate returns the response
 *    text, never request headers.
 *  - Project context is rendered server-side from the Phase 8 context builder
 *    for the sections the client explicitly asked for - the client cannot
 *    request arbitrary files, paths or URLs as "context".
 *  - Nothing here executes commands, writes project files, changes stage or
 *    touches PROJECT.md/STATUS.md. The only write is the explicit interaction
 *    row the user chose to save.
 */

const sectionsEnum = z.enum(CONTEXT_KEYS);

const generateSchema = z
  .object({
    projectId: z.number().int().positive(),
    promptId: z.number().int().positive().optional().nullable(),
    prompt: z.string().trim().min(1, 'A prompt is required.').max(100000),
    sections: z.array(sectionsEnum).max(CONTEXT_KEYS.length).default([]),
    model: z.string().trim().min(1).max(100).optional().nullable()
  })
  .strict();

const usageSchema = z
  .object({
    inputTokens: z
      .number()
      .int()
      .nonnegative()
      .nullish()
      .transform(v => v ?? null),
    outputTokens: z
      .number()
      .int()
      .nonnegative()
      .nullish()
      .transform(v => v ?? null),
    totalTokens: z
      .number()
      .int()
      .nonnegative()
      .nullish()
      .transform(v => v ?? null)
  })
  .strict();

const saveInteractionSchema = z
  .object({
    promptId: z.number().int().positive().optional().nullable(),
    title: z.string().trim().max(200).optional().nullable(),
    provider: z.string().trim().min(1).max(50),
    model: z.string().trim().min(1).max(100),
    promptText: z.string().min(1).max(100000),
    contextSections: z.array(sectionsEnum).max(CONTEXT_KEYS.length).default([]),
    contextText: z.string().max(500000).default(''),
    responseText: z.string().min(1).max(1000000),
    usage: usageSchema.optional().nullable(),
    durationMs: z.number().int().nonnegative().max(86_400_000).optional().nullable()
  })
  .strict();

const settingsSchema = z
  .object({
    provider: z.string().trim().min(1).max(50).optional(),
    model: z.string().trim().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().optional(),
    // Write-only: present to replace or clear the stored key, never returned.
    apiKey: z.string().max(500).nullable().optional()
  })
  .strict();

function projectIdOf(params: unknown): number {
  const raw = Number((params as Record<string, string>).projectId);
  if (!Number.isInteger(raw) || raw <= 0) throw badRequest('projectId must be a positive integer.');
  return raw;
}

/** `?sections=description,requirements` - undefined means "preview everything". */
function sectionsFromQuery(raw: unknown): ContextKey[] {
  if (raw === undefined) return [...CONTEXT_KEYS];
  const parts = String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (!(CONTEXT_KEYS as readonly string[]).includes(part)) {
      throw badRequest(`Unknown context section "${part}".`, { allowed: CONTEXT_KEYS });
    }
  }
  return parts as ContextKey[];
}

// ---------------------------------------------------------------------------
// Application-wide AI endpoints
// ---------------------------------------------------------------------------

export function aiRouter(): Router {
  const router = Router();

  /** Provider status for the UI: configured or not, never the key itself. */
  router.get('/status', async (_req, res, next) => {
    try {
      res.json({ data: await getAiStatus() });
    } catch (e) {
      next(e);
    }
  });

  /** Registered providers and their suggested models (no secrets). */
  router.get('/providers', (_req, res) => {
    res.json({ data: listAiProviders() });
  });

  router.get('/settings', async (_req, res, next) => {
    try {
      res.json({ data: await getAiSettings() });
    } catch (e) {
      next(e);
    }
  });

  /** Replace selected settings. apiKey is write-only and never echoed back. */
  router.put('/settings', async (req, res, next) => {
    try {
      const parsed = settingsSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw badRequest('Invalid input', parsed.error.flatten());
      if (Object.keys(parsed.data).length === 0) throw badRequest('No settings were provided.');
      try {
        res.json({ data: await saveAiSettings(parsed.data) });
      } catch (err) {
        if (err instanceof AiSettingsError) throw badRequest(err.message);
        throw err;
      }
    } catch (e) {
      next(e);
    }
  });

  /**
   * Send the reviewed prompt. Writes nothing: the interaction is persisted
   * only when the user explicitly saves it afterwards, so a failed request or
   * an abandoned attempt never creates a permanent record.
   */
  router.post('/generate', async (req, res, next) => {
    try {
      const parsed = generateSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw badRequest('Invalid input', parsed.error.flatten());

      const { contextFailures, ...data } = await sendAiPrompt(parsed.data);
      res.json({ data, meta: { failures: contextFailures } });
    } catch (e) {
      next(e);
    }
  });

  /** One saved interaction, full detail (prompt, context, response, usage). */
  router.get('/interactions/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) throw badRequest('Interaction id must be a positive integer.');
      res.json({ data: await getAiInteraction(id) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Project-scoped AI endpoints
// ---------------------------------------------------------------------------

export function projectAiRouter(): Router {
  const router = Router({ mergeParams: true });

  /**
   * Context preview: what would be sent for the selected sections. Built by
   * the Phase 8 context builder - absent records come back marked
   * "Not provided in Project Hub.", never invented.
   */
  router.get('/context', async (req, res, next) => {
    try {
      const projectId = projectIdOf(req.params);
      const keys = sectionsFromQuery(req.query.sections);
      const { context, failures } = await buildPromptContext(projectId);
      const rendered = renderAiContext(context, keys);
      res.json({
        data: {
          project: {
            id: context.project.id,
            name: context.project.name,
            slug: context.project.slug,
            stage: context.project.stage
          },
          presence: context.presence,
          sections: rendered.sections,
          text: rendered.text
        },
        meta: { failures }
      });
    } catch (e) {
      next(e);
    }
  });

  /** AI history for this project, newest first. */
  router.get('/interactions', async (req, res, next) => {
    try {
      const projectId = projectIdOf(req.params);
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
      if (!project) throw notFound('Project not found', 'list AI interactions for a project');
      const rows = await listAiInteractions(projectId);
      res.json({ data: rows, meta: { total: rows.length } });
    } catch (e) {
      next(e);
    }
  });

  /** Save the interaction the user explicitly chose to keep. 201 + the row. */
  router.post('/interactions', async (req, res, next) => {
    try {
      const projectId = projectIdOf(req.params);
      const parsed = saveInteractionSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw badRequest('Invalid input', parsed.error.flatten());
      const row = await saveAiInteraction(projectId, parsed.data);
      res.status(201).json({ data: row });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
