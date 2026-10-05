-- Phase 6: PROJECT.md -> database synchronization metadata.
--
-- Additive only. Three nullable columns, no index, no backfill, and no write of
-- any kind to existing rows. No table is dropped, renamed or rewritten, and no
-- existing record changes value: a project that has never been synchronized keeps
-- all three columns NULL, which the application already treats as a real state
-- ("not synchronized yet") rather than a gap.
--
-- The columns record *hashes and a timestamp only*:
--
--   project_document_hash       sha256 of the PROJECT.md bytes on disk as of the
--                               last generate or sync (change detection)
--   project_document_state_hash sha256 of the document Project Hub would render
--                               from the database now, captured at the last sync
--                               (conflict detection)
--   project_document_synced_at  when the last synchronization applied
--
-- No document content is stored here. Project content lives in the tables it
-- already lived in; these columns only make the document/database relationship
-- auditable, so change detection never has to depend on filesystem mtime.
ALTER TABLE "projects"
  ADD COLUMN "projectDocumentHash" TEXT,
  ADD COLUMN "projectDocumentStateHash" TEXT,
  ADD COLUMN "projectDocumentSyncedAt" TIMESTAMP(3);
