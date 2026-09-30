-- Phase 3: link a project record to its physical workspace folder.
--
-- Additive only. Two nullable columns and one index. No existing row is
-- touched, no table is rewritten, and nothing is backfilled: projects that
-- predate this feature keep folder_path = NULL, which the application already
-- treats as "this project has no workspace yet".
ALTER TABLE "projects"
  ADD COLUMN "folderName" TEXT,
  ADD COLUMN "folderPath" TEXT;

CREATE INDEX "projects_folderPath_idx" ON "projects"("folderPath");
