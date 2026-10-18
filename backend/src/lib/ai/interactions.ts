import { prisma } from '../prisma.js';
import { badRequest, notFound } from '../errors.js';
import { isKnownProvider } from './registry.js';
import { AI_CONTEXT_LABELS } from './context.js';
import type { AiUsage } from './types.js';

/**
 * Phase 9: persistence for saved AI interactions.
 *
 * One row per saved interaction (see the AiInteraction model). Rules:
 *
 *  - Saving is an explicit user action. `POST /api/ai/generate` never writes a
 *    row, so a failed or abandoned request leaves no permanent record and a
 *    retry cannot duplicate one.
 *  - Only successful responses are saved (status SUCCEEDED). Failures live in
 *    the response of the failed request itself; the user retries, and the
 *    successful attempt becomes the record.
 *  - The snapshot columns (promptText, contextText, contextSections) keep what
 *    was actually sent, so later edits to the prompt or new project records
 *    cannot rewrite history.
 *  - The provider is stored as a registry id; the model as the name the
 *    provider used. No URL, no key, no headers - ever.
 *  - A prompt may hold any number of interactions; nothing overwrites a
 *    previous response.
 */

export interface SaveAiInteractionInput {
  promptId?: number | null;
  title?: string | null;
  provider: string;
  model: string;
  promptText: string;
  contextSections: string[];
  contextText: string;
  responseText: string;
  usage?: AiUsage | null;
  durationMs?: number | null;
}

export interface AiInteractionRow {
  id: number;
  projectId: number;
  promptId: number | null;
  title: string | null;
  provider: string;
  model: string;
  status: string;
  promptText: string;
  contextSections: string[];
  contextText: string;
  responseText: string;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  createdAt: Date;
}

/** First line of the prompt, clipped - a stable fallback title. */
function deriveTitle(promptText: string): string {
  const firstLine = promptText.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) ?? 'AI interaction';
  return firstLine.length > 90 ? `${firstLine.slice(0, 90).trimEnd()}…` : firstLine;
}

/**
 * Persist one interaction. Validates the project, the optional prompt link and
 * the provider id against the registry so no junk or foreign provider name can
 * enter the history table.
 */
export async function saveAiInteraction(
  projectId: number,
  input: SaveAiInteractionInput
): Promise<AiInteractionRow> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) throw notFound('Project not found', 'save an AI interaction for a project');

  if (!isKnownProvider(input.provider)) {
    // A saved row must reference a provider this build actually knows; this is
    // also what keeps arbitrary strings out of the history table.
    throw badRequest(`AI provider "${input.provider}" is not registered in this build.`, { provider: input.provider });
  }

  if (input.promptId !== undefined && input.promptId !== null) {
    const prompt = await prisma.prompt.findFirst({
      where: { id: input.promptId, projectId },
      select: { id: true }
    });
    if (!prompt) throw notFound('Prompt not found in this project.', 'link the interaction to a prompt');
  }

  const title = input.title?.trim() || deriveTitle(input.promptText);

  const row = await prisma.aiInteraction.create({
    data: {
      projectId,
      promptId: input.promptId ?? null,
      title,
      provider: input.provider,
      model: input.model,
      status: 'SUCCEEDED',
      promptText: input.promptText,
      contextSections: input.contextSections,
      contextText: input.contextText,
      responseText: input.responseText,
      inputTokens: input.usage?.inputTokens ?? null,
      outputTokens: input.usage?.outputTokens ?? null,
      totalTokens: input.usage?.totalTokens ?? null,
      durationMs: input.durationMs ?? null
    }
  });
  return row;
}

/** Summary rows for the history list, newest first. Response text included:
 *  interactions are small and the detail view should never need a refetch. */
export async function listAiInteractions(projectId: number, limit = 100): Promise<(AiInteractionRow & { promptCode: string | null })[]> {
  const rows = await prisma.aiInteraction.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
    include: { prompt: { select: { code: true } } }
  });
  return rows.map(({ prompt, ...row }) => ({ ...row, promptCode: prompt?.code ?? null }));
}

/** One interaction, cross-project safe: the caller must scope it by id only
 *  after the route has resolved which project it belongs to. */
export async function getAiInteraction(id: number): Promise<AiInteractionRow & { promptCode: string | null }> {
  const row = await prisma.aiInteraction.findUnique({
    where: { id },
    include: { prompt: { select: { code: true, title: true } } }
  });
  if (!row) throw notFound('AI interaction not found', 'load a saved AI interaction');
  const { prompt, ...rest } = row;
  return { ...rest, promptCode: prompt?.code ?? null };
}

/** Label map for the frontend detail views (single source: the Phase 8 keys). */
export const contextSectionLabels = AI_CONTEXT_LABELS;
