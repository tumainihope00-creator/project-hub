import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Phase 8: prompt storage rules shared by every write path.
 *
 * The invariant this file exists to protect:
 *
 *   prompts.content  ==  text of the newest prompt_versions row for that prompt
 *
 * `content` is denormalized so that search, filtering and the PROJECT.md
 * synchronization can read the current prompt text from one column instead of
 * joining the history. `prompt_versions` remains the history and is never
 * rewritten. Three paths write prompt text - creating a prompt, editing one, and
 * applying a PROJECT.md change - and all three go through this module, so the two
 * copies cannot drift apart.
 *
 * No AI provider is involved anywhere in this module: it stores and organizes
 * text, nothing more.
 */

/**
 * The suggested prompt categories.
 *
 * Suggestions, not constraints: `prompts.category` is free text, so a category
 * added later needs no migration and no code change - this list only feeds the
 * dropdowns and the generator's defaults. Keep it aligned with the frontend's
 * PROMPT_CATEGORIES in frontend/src/resources.ts.
 */
export const PROMPT_CATEGORIES = [
  'Research',
  'Planning',
  'Architecture',
  'Coding',
  'Debugging',
  'Refactoring',
  'Database',
  'UI/UX',
  'Testing',
  'Deployment',
  'Documentation',
  'Security',
  'Troubleshooting',
  'General',
  'V1 Build Prompt'
] as const;

/** Either the live client or a transaction client - both satisfy these helpers. */
export type PromptClient = PrismaClient | Prisma.TransactionClient;

export interface PromptVersionInput {
  text: string;
  response?: string | null;
  changes?: string | null;
  reason?: string | null;
}

/**
 * Append a new immutable version and point the prompt at it.
 *
 * The version number is `count + 1` inside the caller's transaction, so two
 * concurrent appends cannot claim the same number (the unique constraint on
 * `[promptId, version]` is the backstop).
 */
export async function appendPromptVersion(
  client: PromptClient,
  prompt: { id: number },
  input: PromptVersionInput
): Promise<{ id: number; version: number }> {
  const existing = await client.promptVersion.count({ where: { promptId: prompt.id } });
  const version = await client.promptVersion.create({
    data: {
      promptId: prompt.id,
      version: existing + 1,
      text: input.text,
      response: input.response ?? null,
      changes: input.changes ?? null,
      reason: input.reason ?? null
    }
  });
  await client.prompt.update({
    where: { id: prompt.id },
    data: { finalVersionId: version.id }
  });
  return { id: version.id, version: version.version };
}

/**
 * Write new prompt text: update `content` and append the version that records it,
 * atomically.
 *
 * A text identical to the current content is a no-op - no version is appended for
 * an edit that changed nothing, so saving a form untouched does not grow the
 * history. `changes`/`reason` describe the edit for the version history; callers
 * that do not supply them get a description of where the edit came from.
 *
 * `response` is only attached when the caller explicitly supplies one: an edited
 * prompt has not been run again, so the new version legitimately has no AI
 * response of its own. Older versions keep theirs.
 */
export async function writePromptContent(
  client: PromptClient,
  prompt: { id: number; content: string },
  text: string,
  meta: { changes?: string | null; reason?: string | null; source?: string; response?: string | null } = {}
): Promise<boolean> {
  if (text === prompt.content) return false;
  await client.prompt.update({ where: { id: prompt.id }, data: { content: text } });
  await appendPromptVersion(client, prompt, {
    text,
    response: meta.response ?? null,
    changes: meta.changes ?? (meta.source ? `Edited in ${meta.source}` : 'Edited'),
    reason: meta.reason ?? null
  });
  return true;
}
