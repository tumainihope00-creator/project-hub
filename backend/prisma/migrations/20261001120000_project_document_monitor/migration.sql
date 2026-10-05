-- Phase 7: PROJECT.md monitoring state.
--
-- Additive only. Four nullable columns on `projects`, no index, no default, no
-- backfill, and no write of any kind to existing rows. No table is dropped,
-- renamed or rewritten. A project whose document has never been detected as
-- changed keeps all four columns NULL, which the application reports as "no
-- detected change", not as a gap.
--
-- The columns hold monitoring bookkeeping only - never document content, and
-- never a project data field:
--
--   project_document_last_detected_hash sha256 of the PROJECT.md bytes the
--                                        monitor last analyzed, so a restart or a
--                                        rescan can tell "already reported" from
--                                        "never looked at"
--   project_document_detected_at        when the monitor last saw content that
--                                        differed from the last synchronized hash
--                                        (project_document_hash from Phase 6).
--                                        Derived from detection, not from mtime.
--   project_document_change_state       the classified state of that detection
--   project_document_dismissed_at       when the user dismissed the notification,
--                                        so an unchanged file is not re-notified
--                                        on every restart
--
-- Project content still only reaches the database through the explicit Phase 6
-- synchronization. Nothing in the monitoring path may write a project data column
-- or a child table, which is exactly why these columns are separate: the write
-- path for them is a single helper with a hard-coded column list.
--
-- ADD COLUMN without a DEFAULT is a metadata-only change in PostgreSQL, so this
-- migration is instant and does not rewrite the table.
ALTER TABLE "projects"
  ADD COLUMN "projectDocumentLastDetectedHash" TEXT,
  ADD COLUMN "projectDocumentDetectedAt" TIMESTAMP(3),
  ADD COLUMN "projectDocumentChangeState" TEXT,
  ADD COLUMN "projectDocumentDismissedAt" TIMESTAMP(3);