-- Phase 7: the change-aware synchronization baseline.
--
-- Additive only. Four columns on `projects`, no index, no table dropped, renamed or
-- rewritten, no backfill and no write of any kind to existing rows. The eight
-- existing projects keep every column exactly as it is.
--
-- Phase 6 could detect *that* the database moved (one hash over the rendered
-- document) but could not describe *what* moved, so a conflict was all-or-nothing
-- and the only remedy was "acknowledge and overwrite". These columns hold the
-- per-field description Phase 7 needs:
--
--   project_document_baseline         the last state in which the document and the
--                                     database agreed, field by field (jsonb). The
--                                     three-way comparison is baseline vs. the
--                                     database now vs. the document now, which is
--                                     what separates "the document changed" from
--                                     "the database changed" from "both changed
--                                     different fields" (a merge) from "both
--                                     changed the same field" (a conflict).
--                                     NULL means "no baseline yet".
--   project_document_sync_state       the last classified state, for the UI.
--   project_document_sync_direction   which way the last synchronization moved
--                                     data, so "who wrote this?" is answerable
--                                     from the record itself.
--   project_document_conflict_fields  names of the fields currently in conflict.
--                                     Names only: no value is stored here.
--
-- Two rules this migration depends on:
--
--   1. NULL is a real state, not a gap. A project that has never been synchronized
--      in Phase 7 reports "no baseline" and establishes one on its first generate
--      or synchronization. For a project whose document already disagrees with the
--      database, no baseline is written at all until the difference is resolved
--      explicitly - nothing here decides who was right.
--   2. The baseline is a snapshot, not an audit log. Synchronization history lives
--      in the existing `activity_events` table, which already records every applied
--      synchronization with its metadata.
--
-- ADD COLUMN without a volatile DEFAULT is a metadata-only change in PostgreSQL,
-- so this migration is instant, takes no lock that blocks reads or writes, and does
-- not rewrite the table.
ALTER TABLE "projects"
  ADD COLUMN "projectDocumentBaseline" JSONB,
  ADD COLUMN "projectDocumentSyncState" TEXT,
  ADD COLUMN "projectDocumentSyncDirection" TEXT,
  ADD COLUMN "projectDocumentConflictFields" TEXT[] DEFAULT ARRAY[]::TEXT[];
