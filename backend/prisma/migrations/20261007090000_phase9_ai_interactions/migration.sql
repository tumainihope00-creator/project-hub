-- Phase 10: AI provider integration & AI workspace.
--
-- Additive only: one new enum, one new table, two back-relation fields on
-- existing tables (which produce no SQL - the foreign key lives on the new
-- table). Nothing existing is dropped, renamed or rewritten, and no existing
-- row is touched, so projects, tasks, notes and prompts stay exactly as they
-- are.
--
-- ai_interactions stores one saved AI interaction per row: the prompt snapshot,
-- the context snapshot that was sent, the provider registry id, the model, the
-- response, and usage/duration when the provider reported them. It NEVER stores
-- an API key - credentials stay in backend/.env (AI_PROVIDER_API_KEY) or the
-- app_settings table, both server-side only.

CREATE TYPE "AiInteractionStatus" AS ENUM ('SUCCEEDED', 'FAILED');

CREATE TABLE "ai_interactions" (
  "id"            SERIAL NOT NULL,
  "projectId"     INTEGER NOT NULL,
  "promptId"      INTEGER,
  "title"         TEXT,
  "provider"      TEXT NOT NULL,
  "model"         TEXT NOT NULL,
  "status"        "AiInteractionStatus" NOT NULL DEFAULT 'SUCCEEDED',
  "promptText"    TEXT NOT NULL,
  "contextSections" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "contextText"   TEXT NOT NULL DEFAULT '',
  "responseText"  TEXT NOT NULL DEFAULT '',
  "error"         TEXT,
  "inputTokens"   INTEGER,
  "outputTokens"  INTEGER,
  "totalTokens"   INTEGER,
  "durationMs"    INTEGER,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_interactions_pkey" PRIMARY KEY ("id")
);

-- Deleting a project cascades its interactions (project history goes with it).
CREATE INDEX "ai_interactions_projectId_createdAt_idx" ON "ai_interactions"("projectId", "createdAt");

-- One prompt, many interactions (attempt 1, attempt 2, ...). Deleting the
-- prompt keeps the interactions: promptId becomes NULL via ON DELETE SET NULL.
CREATE INDEX "ai_interactions_promptId_idx" ON "ai_interactions"("promptId");

ALTER TABLE "ai_interactions"
  ADD CONSTRAINT "ai_interactions_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_interactions"
  ADD CONSTRAINT "ai_interactions_promptId_fkey"
  FOREIGN KEY ("promptId") REFERENCES "prompts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
