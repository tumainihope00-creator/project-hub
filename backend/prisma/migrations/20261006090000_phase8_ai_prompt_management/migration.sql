-- Phase 8: AI prompt management.
--
-- Additive only: one new enum, three new columns on `prompts`, one new index.
-- No table is dropped, renamed or recreated, no column is altered, and no
-- project, task or note is touched. The eight existing projects keep every
-- column exactly as it is.
--
-- The columns:
--
--   status         prompt lifecycle (DRAFT/READY/USED/ARCHIVED). Independent of
--                  PromptResult (what an AI run achieved) and of projects.stage
--                  (the project's lifecycle). ARCHIVED replaces deletion as the
--                  way to put a prompt away without losing its history.
--   isReusable     the reusable flag: this prompt may be copied as a template
--                  into another project. A flag, not a status, so a reusable
--                  prompt is reusable in any lifecycle state.
--   content        the current prompt text, denormalized from the newest
--                  PromptVersion.text so that search, the PROJECT.md
--                  synchronization and filtering do not have to join history.
--                  PromptVersion stays the history; every write path keeps the
--                  two equal (see backend/src/lib/promptLibrary.ts).
--
-- Both backfills are data initialization for NEW columns only: they read the
-- existing version history and write into columns that did not exist before
-- this migration, so nothing a previous phase wrote is changed.
--
--   1. Existing prompts were recorded after being used against an AI tool (they
--      carry a result), so their lifecycle starts at USED rather than DRAFT.
--   2. Existing prompts keep their text in prompt_versions only. Copying the
--      newest version's text into `content` makes that text searchable and
--      synchronizable without altering a single version row. The pointer
--      `finalVersionId` wins when set; otherwise the highest version number.

CREATE TYPE "PromptStatus" AS ENUM ('DRAFT', 'READY', 'USED', 'ARCHIVED');

ALTER TABLE "prompts"
  ADD COLUMN "status" "PromptStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "isReusable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "content" TEXT NOT NULL DEFAULT '';

UPDATE "prompts" SET "status" = 'USED';

UPDATE "prompts" p
SET "content" = COALESCE(
  (SELECT v."text" FROM "prompt_versions" v WHERE v."id" = p."finalVersionId"),
  (SELECT v."text" FROM "prompt_versions" v WHERE v."promptId" = p."id" ORDER BY v."version" DESC LIMIT 1),
  ''
);

CREATE INDEX "prompts_projectId_status_idx" ON "prompts"("projectId", "status");
