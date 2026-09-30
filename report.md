# Project Hub — Technical Audit Report

**Repository:** `C:\Users\ILGRIS\Desktop\projects\p-hub`
**Audit date:** 2026-09-29
**Audit type:** Read-only technical audit (no implementation, no data changes)
**HEAD at audit time:** `a55468d` — *"v1 prompt fixing and project import addition"*
**Working tree at audit time:** clean (`git status --short` empty)

---

## 1. Executive Summary

Project Hub is a **local, single-user, two-process web application** that manages the full lifecycle of software projects as structured, typed records rather than as free-form documents. It is already a mature, coherent system: 29 Prisma models, a config-driven generic CRUD layer, an append-only activity timeline, archive-first project deletion, a versioned prompt/document model, and a genuinely sophisticated document importer that discovers its own schema from Prisma DMMF.

The audit found **no data-loss defect and no broken architecture**. What it found instead is a set of precise, bounded gaps that matter for the four intended expansions — project folders, `PROJECT.md` synchronization, evidence-based status, and AI conversation/agent support:

| Area | Verdict |
| --- | --- |
| Core architecture | Sound, config-driven, well-factored. Extend, do not rebuild. |
| Data model | Rich and consistent. Missing: project path, sync state, links, conversations, messages. |
| Document importer | Best-engineered subsystem in the repo. Directly reusable for `PROJECT.md`. |
| Filesystem awareness | **None exists.** No fs, path, watcher, or process code anywhere. |
| Status model | Manual only. Two write paths; one is unlogged. No evidence model. |
| Safety | Archive-by-default, transactional import, cascades correct. Generic delete is unguarded. |
| Testing | 82 test declarations, excellent importer coverage, but **runs against the live database**. |
| AI | Deterministic local prompt generator. No provider transport, no conversation model. |

**Highest-severity findings (all confirmed in source):**

1. **Cross-project data exposure via query-string filter injection** — `backend/src/routes/generic.ts:120-126` builds its `where` clause from `{ projectId }` and then assigns *every* remaining query-string key over it. A request such as `GET /api/projects/1/requirements?projectId=2` returns project 2's rows. Single-user today, but it breaks the ownership invariant that every other layer enforces.
2. **Two write paths to `Project.stage`, only one of which is audited** — `POST /projects/:id/stage` writes a `STAGE_CHANGED` event; `PUT /projects/:id` accepts `stage` in its body via `projectUpdateSchema` and writes only `PROJECT_UPDATED`. A stage transition can therefore happen with no lifecycle history.
3. **Project creation is not atomic** — `backend/src/routes/projects.ts:167-179` performs `project.create`, then tag assignment, then activity logging as three independent writes with no transaction. A failure after the insert leaves a project with no tags and no `PROJECT_CREATED` event.
4. **Generic resource delete is unguarded and leaks orphans** — `backend/src/routes/generic.ts:282-290` is a bare `delegate().delete()`: no activity event, no confirmation, no transaction, and no cleanup of `tag_assignments`, which have no FK to their target row.
5. **Test suite mutates the live database** — `backend/tests/*` load the normal `backend/.env` and do not override `DATABASE_URL`. Running `npm test` creates and hard-deletes real records. This is the single biggest obstacle to safe future development.

**Overall recommendation:** proceed with the 16-phase plan in §18. Phases 2–5 (config, path model, `PROJECT.md` template, sync engine) deliver the largest user-visible value and carry the lowest risk. The two immediate code fixes — the query-filter scoping bug and the duplicate stage write path — should land first, before any feature work.

---

## 2. Scope, Constraints & Method

### 2.1 In scope

Project creation, document import, project status/stages, filesystem integration, project links/URLs, AI/prompt generation, database schema, safety and data protection, testing, configuration, repository structure.

### 2.2 Constraints observed

- **Audit only.** No feature was implemented, no migration authored, no seed or reset run.
- **No database writes.** All database access was `SELECT`-only.
- **No existing files modified, moved, or deleted.**
- **No dependencies added, removed, or upgraded.**
- **Tests were not run** — see §16.2 for why this was the correct call.
- Builds were not run (`prisma generate` writes into `node_modules`).

### 2.3 Method

1. Static read of every backend and frontend source file in the data path, the Prisma schema, and all three migrations.
2. `npx prisma migrate status` — confirmed migration state against the live database.
3. `npx prisma db pull --print` — read-only confirmation that the live schema matches `schema.prisma`.
4. A temporary read-only Node/Prisma script for row counts, stage distributions, and `information_schema` column inspection.
5. Repository-wide content search for filesystem, process, watcher, and settings code to prove *absence*, not just infer it.
6. `git ls-files` to confirm which config files are actually tracked.

### 2.4 Environment

| Item | Value |
| --- | --- |
| Node.js | `v24.13.0` |
| npm | `11.6.2` |
| Platform | win32, PowerShell 5.1 |
| Database | PostgreSQL, database `projecthub`, localhost |
| Package manager | npm (three separate lockfiles: root, backend, frontend) |
| Not available | `psql`, `pg_isready` |

---

## 3. System Architecture Overview

### 3.1 Top-level shape

```
┌──────────────────────────┐        fetch('/api/...')        ┌───────────────────────────┐
│  Frontend                │ ──────────────────────────────► │  Backend                  │
│  React 18 + Vite 6       │                                 │  Express 4 + TypeScript   │
│  React Router 7          │ ◄────────────────────────────── │  ESM, Node                │
│  :5173                   │        JSON { data, meta }      │  :4000                    │
│  /api proxied by Vite ───┼────────────────────────────────►│  /api                     │
└──────────────────────────┘                                 └─────────────┬─────────────┘
                                                                           │ Prisma 6
                                                                          ▼
                                                          ┌────────────────────────────┐
                                                          │ PostgreSQL · projecthub    │
                                                          │ 29 models + _prisma_       │
                                                          │ migrations                 │
                                                          └────────────────────────────┘
```

Two independent processes. `Start Project Hub.bat` → `scripts/project-hub-launcher.ps1` starts a backend window and a frontend window, polls `http://localhost:5173` for up to 45 s, checks `http://localhost:<port>/api/health` informationally, and opens the browser. `Stop Project Hub.bat` → `scripts/stop-project-hub.ps1`. Launcher state lives in `%LOCALAPPDATA%\ProjectHub\state.json` and the launcher reads `BACKEND_PORT` directly out of `backend/.env` rather than trusting the default.

**There is no combined production server.** `npm run build` compiles the backend to `backend/dist/` and the frontend to `frontend/dist/`; nothing serves the frontend build from Express and no static-hosting or reverse-proxy configuration exists in the repository.

### 3.2 Backend composition

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Entry point; reads `BACKEND_PORT`; installs `SIGINT`/`SIGTERM` shutdown. |
| `src/server.ts` | Creates the HTTP server; `SIGTERM` → `server.close()` + Prisma `$disconnect()`. |
| `src/app.ts` | Express assembly: Helmet, CORS, JSON body limit 5 MB, rate limit 600 req/min, 404 handler, Prisma-error-aware error handler, and every router mount. |
| `src/resources.ts` | Single source of truth for the 20 project sub-resources: Prisma delegate, Zod create/update schemas, search fields, code prefix, numbering, activity event types, tags, and version/hook behaviour. |
| `src/routes/projects.ts` | Portfolio list with aggregate stats, CRUD, stage, archive/activate, relationships, overview/health/snapshot, timeline/heatmap, full JSON export. |
| `src/routes/generic.ts` | `resourceRouter(def)` factory implementing the shared CRUD for every resource; plus feature↔requirement linking, prompt versioning, and document versioning routers. |
| `src/routes/misc.ts` | Dashboard, global search, tags, and activity endpoints. |
| `src/routes/import.ts` | Document import HTTP surface. |
| `src/routes/generator.ts` | V1 Prompt Generator HTTP surface. |
| `src/lib/prisma.ts` | Prisma singleton. |
| `src/lib/activity.ts` | `logActivity()` — the only writer of `activity_events`. |
| `src/lib/tags.ts` | Polymorphic `tagAssignments` read/write. |
| `src/lib/projectStats.ts` | `STAGE_ORDER` and aggregate project statistics. |
| `src/lib/errors.ts` | `ApiError` and the 9 error categories. |
| `src/lib/validation.ts` | `intFromQuery()` bounded integer parsing. |
| `src/lib/import/*` | Five-module importer pipeline (§9). |
| `src/lib/generator/*` | Seven-module deterministic prompt generator (§13). |

### 3.3 API surface

Routers, in mount order (`src/app.ts:45-60`):

- `GET /api/health` → `{ status, time }`
- `/api/projects` → `projectsRouter`
- `/api` → `miscRouter` (dashboard, search, tags, activity)
- `/api/import` → `importRouter`
- `/api/projects/:projectId/generator` → `generatorRouter()`
- per-resource: `/api/projects/:projectId/<path>` → `resourceRouter(def)` for each of the 20 `RESOURCES`
- extra nested routers: prompts `/:id/versions`, documents `/:id/versions`, features `/:id/requirements`

**Design note:** the generic router is mounted *after* the dedicated routers, so `/api/projects/:key/...` project routes win over any resource path that would collide. Note that `projects.ts` declares `/:id/relationships/:relId` and `/:key/export`, so any future resource literally named `relationships` or `export` would be shadowed.

### 3.4 Frontend composition

| File | Responsibility |
| --- | --- |
| `src/main.tsx` | React root. |
| `src/App.tsx` | All routes; wraps providers. |
| `src/api/client.ts` | Thin `api.get/post/put/del` wrapper over `fetch`, plus `ApiError` carrying backend `category`/`operation`/`possibleAction`. |
| `src/api/types.ts`, `src/api/importTypes.ts` | Wire types mirroring backend payloads. |
| `src/resources.ts` | Frontend mirror of the resource registry: 553 lines of `FieldDef`/`ColumnDef` used to render every list, form, filter, and detail view. |
| `src/projectConfig.ts` | The `Project` form config, including the repository URL field. |
| `src/context/AppContext.tsx` | Global projects list, toasts, global reload. |
| `src/context/ProjectContext.tsx` | Current project + reload. |
| `src/lib/useApi.ts` | Fetch-on-mount hook. |
| `src/lib/status.ts` | Stage → colour. |
| `src/pages/*` | 20 project tabs + dashboard/projects/search/tags pages. |
| `src/components/ResourceForm.tsx` | Generic form renderer (text, textarea, select, date, number, url, tags, relation). |
| `src/components/ResourcePage.tsx` | Generic list/detail/page renderer. |
| `src/components/DocumentImportWizard.tsx` | 553-line three-step import wizard. |

A `data-changed` `CustomEvent` on `window` is the cross-component invalidation signal. It is untyped and global — fine at this scale, but it is the mechanism a future filesystem-sync layer will need to hook into.

**Duplication to be aware of:** `backend/src/resources.ts` and `frontend/src/resources.ts` and `frontend/src/projectConfig.ts` are three hand-maintained declarations of the same shape. They are consistent today. Any schema change must touch all three or the UI will drift from validation.

---

## 4. Repository & File Structure

```
p-hub/
├── Start Project Hub.bat          one-click launcher
├── Stop Project Hub.bat           one-click stop
├── package.json                   setup / dev / build / test / db scripts
├── package-lock.json
├── report.md                      this document
├── scripts/
│   ├── project-hub-launcher.ps1   189 lines; two windows + health poll
│   ├── run-server-window.ps1      per-window `npm run dev` runner
│   └── stop-project-hub.ps1       targeted shutdown
├── backend/
│   ├── package.json               Prisma 6, Express 4, Zod, multer, mammoth, pdf-parse
│   ├── .env                       git-ignored, live local config
│   ├── .env.example               tracked
│   ├── vitest.config.ts
│   ├── prisma/
│   │   ├── schema.prisma          29 models
│   │   ├── seed.ts                374 lines, FORCE=1 destructive reseed
│   │   ├── baseline-before.json   pre-importer snapshot
│   │   └── migrations/            3 migrations
│   ├── src/                       index, server, app, resources, routes/, lib/{import,generator}
│   ├── tests/                     api (19) · import (36) · promptGenerator (27) · helpers
│   └── IMPORT-REPORT.md           existing importer inventory (partly stale)
└── frontend/
    ├── package.json
    ├── vite.config.ts             proxy /api → :4000
    └── src/                       App, api/, components/, context/, lib/, pages/, resources.ts
```

**Filesystem hygiene:** `.gitignore` correctly ignores `node_modules/`, `dist/`, `.env`, `.env.*` with `!.env.example` un-ignoring the example, `*.log`, and Prisma local DB files. Verified: `git ls-files backend/.env` returns nothing; `backend/.env.example` is tracked. The local database password is therefore not in version control.

**Nothing else in the repository is generated artefact noise** — there is no committed `dist/`, no committed lockfile drift, and no stray files.

---

## 5. Live Database & Schema Audit

### 5.1 Migration state

`npx prisma migrate status` against the live database reports **`Database schema is up to date!`** with three applied migrations:

| Migration | Purpose |
| --- | --- |
| `20260921131459_init` | Full base schema: 29 models, enums, indexes, 40 FK constraints. |
| `20260924095430_v1_prompt_generator` | Prompt-generator tables/columns. |
| `20260924100550_generator_activity_and_prompt_result` | Generator activity + `PromptResult` enum. |

`npx prisma db pull --print` output matched `schema.prisma` exactly. **There is no schema drift between the repository and the live database.**

### 5.2 Referential integrity rules

Verified across all 40 foreign keys in the init migration:

| Rule | Applied to |
| --- | --- |
| `ON DELETE CASCADE` | Every `*_projectId_fkey` — all 20 project-owned tables, plus `activity_events`, `attachments`, and both directions of `project_relationships`. |
| `ON DELETE SET NULL` | All optional cross-links: `prompts.issueId/featureId/taskId`, `tasks.featureId/milestoneId/requirementId/devSessionId`, `architecture_decisions.supersededById`. |
| `ON DELETE CASCADE` (derived) | `prompt_versions.promptId`, `document_versions.documentId`, `feature_requirements.*`, `tag_assignments.tagId`. |
| `ON UPDATE CASCADE` | All FKs. |
| **No FK at all** | `tag_assignments.taggableType` / `taggableId` — a polymorphic soft reference. |

**Consequences:**

- Hard-deleting a project correctly and completely removes its entire history, including its activity timeline. This is intentional and consistent, but it means §15.3's hard-delete requirement is not a formality.
- Deleting a feature nulls its tasks' `featureId` rather than cascading — correct; a task outlives its feature.
- **Deleting any resource leaves its `tag_assignments` rows behind as orphans**, because the polymorphic link has no FK. `prisma/seed.ts:15` has to delete `tagAssignment` first for exactly this reason. This is a real, currently-unhandled data-hygiene defect.

### 5.3 `projects` table (live `information_schema`)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `SERIAL` | Primary key. |
| `slug` | `text` | **UNIQUE.** Used as the public URL key. |
| `name` | `text` | |
| `description`, `problem`, `motivation`, `targetUsers`, `expectedValue`, `assumptions`, `initialQuestions`, `inspiration`, `v1Scope` | `text` | Nullable narrative fields. |
| `originalIdea` | `text` | Nullable. **Dual-purpose:** manual creation writes a JSON snapshot of the initial idea; import writes a JSON snapshot including document provenance. |
| `stage` | `LifecycleStage` | `NOT NULL DEFAULT 'IDEA'`. |
| `isArchived` | `boolean` | `NOT NULL DEFAULT false`. |
| `archivedAt` | `timestamp` | Nullable. |
| `repositoryUrl` | `text` | Nullable. **0 of 8 live projects have it set.** |
| `createdAt`, `updatedAt` | `timestamp` | |

Indexes: unique on `slug`; btree on `stage`, `isArchived`, `updatedAt`.

Relations out of `Project`: 20 child collections plus `projectRelationships` (both directions), `activityEvents`, and `tags` via the polymorphic join.

**What is missing for the future features:** there is no `path` / `folderName` column, no `externalSync` state, no `controlFile` reference, no conversation relation.

### 5.4 Live data inventory (read-only, 2026-09-29)

| Table | Rows | | Table | Rows |
| --- | ---: | --- | --- | ---: |
| `projects` | 8 | | `notes` | 9 |
| `tag_assignments` | 25 | | `project_documents` | 2 |
| `tags` | 17 | | `document_versions` | 2 |
| `research_entries` | 21 | | `deployments` | 1 |
| `research_questions` | 9 | | `production_incidents` | 1 |
| `requirements` | 36 | | `git_references` | 1 |
| `features` | 41 | | `activity_events` | 202 |
| `feature_requirements` | 0 | | `project_relationships` | 1 |
| `architecture_decisions` | 15 | | `attachments` | 0 |
| `tech_stack` | 9 | | `ai_sessions` | 2 |
| `database_tables` | 2 | | `development_sessions` | 2 |
| `api_endpoints` | 3 | | `prompts` | 3 |
| `milestones` | 11 | | `prompt_versions` | 4 |
| `tasks` | 18 | | `prompt_generations` | 1 |
| `issues` | 44 | | | |

**Project stage distribution:** `IDEA` 3, `RESEARCH` 2, `PLANNING` 1, `BUILDING` 2.

**The database is in a healthy, exercised state.** 202 activity events across 8 projects is the signature of a system that is actually being used, not just seeded. One project (`id` 330) was created 2026-09-28, after the last import report was written, and its slug/name pattern is consistent with a persisted test artefact — the exact cause could not be confirmed without modifying data, but §16.2 explains the mechanism.

### 5.5 Enum consistency — one documentation defect

The live `LifecycleStage` enum, `schema.prisma`, `backend/src/resources.ts` (`STAGES`), and `frontend/src/resources.ts` (`STAGES`) **all agree**:

```
IDEA, RESEARCH, PLANNING, ARCHITECTURE, BUILDING, TESTING, DEPLOYMENT,
PRODUCTION, MAINTENANCE, PAUSED, COMPLETED, ARCHIVED, ABANDONED
```

`backend/IMPORT-REPORT.md` documents a **stale, superseded** enum containing `IDLE`, `DEPLOYED`, and `ITERATING`. That document is misleading and should be corrected or clearly marked historical before it misleads a future contributor. This is the only schema/frontend/backend disagreement found.

---

## 6. API & Service Layer Audit

### 6.1 Project routes (`src/routes/projects.ts`, 560 lines)

| Method + path | Behaviour |
| --- | --- |
| `GET /` | Portfolio list. Filters: `q` (name/description, insensitive), `stage`, `tag`, `archived` (`active`\|`only`). `take: 1000`, ordered `updatedAt desc`. Issues **10 aggregate queries** (`groupBy` per child) and builds a `lastActivityAt` map from a 2000-row `findMany`. |
| `POST /` | Create. `projectCreateSchema` is **`.strict()`** — unknown keys rejected. Returns **201**. |
| `GET /:key` | Accepts numeric id **or** slug. Adds `tags` + `stats`. |
| `PUT /:id` | Partial update. Re-slugs only when `name` changes. Returns the row **with** tags. |
| `DELETE /:id` | **Archives by default.** `?hard=true` performs `prisma.project.delete()`. |
| `POST /:id/archive` \| `/activate` | Explicit lifecycle toggles, both logged. |
| `POST /:id/stage` | `{ stage, note? }`. Logs `STAGE_CHANGED` with `{ fromStage, toStage, note }`. |
| `GET /:key/overview` | Project + tags + stats + 12 recent activity events + heuristic `nextActions`. |
| `GET /:key/snapshot` \| `/health` | Stats-only views for future automation. |
| `GET /:key/timeline` | All events (`take: 5000`) bucketed by day. |
| `GET /:key/ai-timeline` | Prompts with versions + AI sessions. |
| `GET /:key/activity` | Paged activity; `pageSize` clamped 50–200. |
| `GET /:key/heatmap` | Event counts per day, last 70 days. |
| `GET/POST /:id/relationships`, `DELETE /:id/relationships/:relId` | Typed relationships with self-link guard and `upsert`. |
| `GET /:key/export` | Full JSON snapshot, `Content-Disposition: attachment`. |

**Validation.** `projectCreateSchema`: `name` trimmed, 1–200, required. `description`/`problem`/`motivation`/`assumptions`/`initialQuestions`/`v1Scope` ≤ 20 000. `targetUsers`/`expectedValue`/`inspiration` ≤ 5 000. `repositoryUrl` ≤ 1 000 — **and unvalidated as a URL**: any string is accepted, including `javascript:...`. It is rendered in the frontend as `<a href target="_blank" rel="noreferrer">`.

### 6.2 Generic resource router (`src/routes/generic.ts`)

One factory, instantiated 20 times from `RESOURCES`. Provides list (paged, filtered, searched), create, read, update, delete.

**Cross-cutting behaviour, all driven by the resource definition rather than hardcoded per resource** — this is good design:

- `nextCode()` allocates `REQ-001`, `TASK-001`, … by scanning the project's existing `code` column with a trailing-digit regex.
- `nextNumber()` allocates sequential `number` where `numbered: true`.
- `applyDerived()` stamps `completedAt` on `COMPLETED` tasks and `resolvedAt` on resolved issues.
- `beforeCreate`/`afterCreate`/`afterSave`/`beforeUpdate`/`afterUpdate` hooks receive `{ projectId }`.
- **Prompts and documents are special-cased** for version chaining: creating a prompt writes `Prompt` + `PromptVersion 1` and sets `finalVersionId`; updating a document's `content` writes a new `ProjectDocumentVersion` and increments `currentVersion`. Body `text`/`response` are stripped from prompt updates.
- `loadOne()` always scopes by `{ id, projectId }` — correct ownership enforcement on read, update, and delete.

### 6.3 Confirmed defects in the generic router

**(a) Query-string filter injection — cross-project data exposure.**
`src/routes/generic.ts:120-126`:

```ts
const where: Record<string, any> = { projectId };
for (const [key, value] of Object.entries(req.query)) {
  if (['q', 'page', 'pageSize', 'sort', 'order'].includes(key)) continue;
  if (typeof value === 'string' && value.length > 0) where[key] = value;
}
```

`where.projectId` is established first and then **overwritten** by any caller-supplied `projectId`. `GET /api/projects/1/tasks?projectId=2` returns project 2's tasks. There is no allowlist of filterable keys, so `id`, `createdAt`, or any other column can be used as a filter too. `req.query` keys are also never schema-validated, so unknown parameters fail silently.

*Impact today:* low (single-user). *Impact after any multi-surface or multi-user work:* critical. This breaks the invariant that `loadOne()` and every `where: { projectId }` in the codebase upholds.

*Fix:* build filters from `def.filters` (an allowlist that does not exist yet in the backend `ResourceDef` — the frontend has it) and merge them *before* assigning `projectId`, or reject `projectId` in the reserved set.

**(b) Unguarded delete.**
`src/routes/generic.ts:282-290` — `loadOne()` then `delegate().delete()`. Consequences:

- **No activity event.** Every create and update logs; every generic delete is invisible in the timeline. This is an inconsistency in an otherwise well-maintained audit trail, and it matters directly for the future filesystem-sync feature, where "a record disappeared" must be attributable.
- **No confirmation or archive.** Project deletion is archive-first; task/feature/milestone deletion is immediate and irreversible. `ConfirmButton` exists in the UI, but the API imposes nothing.
- **Orphaned tag assignments** (see §5.2).
- **Not transactional** relative to any hook that might run alongside it (currently none do, but `afterDelete` is an obvious future hook).
- **No document/prompt version integrity check** — deleting a prompt cascades away its entire version history without warning.

**(c) `applyDerived` uses non-null assertions loosely.** `data.completedAt = new Date()` is fine, but the function has no type discipline; a `status` supplied as a non-string is coerced only on the issue branch.

### 6.4 Error handling

`src/lib/errors.ts` defines `ApiError` with 9 categories — `VALIDATION_FAILED`, `NOT_FOUND`, `DATA_MISSING`, `GENERATION_ERROR`, `SYSTEM_ERROR`, `DOCUMENT_ERROR`, `EXTRACTION_ERROR`, `MAPPING_ERROR`, `DATABASE_ERROR` — and a body carrying `category`, `operation`, `possibleAction`, and optional `details`. `src/app.ts:76-125` maps `ApiError` directly and additionally translates raw Prisma error codes: **`P2025` → 404, `P2002`/`P2003` → 409** with `meta` details.

This is genuinely good: a concurrent slug collision surfaces as a clean `409`, not a 500. The one blemish is `category: isDbProblem ? 'SYSTEM_ERROR' : 'SYSTEM_ERROR'` — both ternary branches are identical, so the `isDbProblem` computation is dead code.

### 6.5 Middleware posture

| Control | Status |
| --- | --- |
| Helmet | ✅ on |
| CORS | ✅ restricted to `CORS_ORIGIN` split on `,`; `credentials: false` |
| JSON body limit | ✅ 5 MB |
| Rate limit | ✅ 600 requests / minute (all routes) |
| **Authentication** | ❌ **none — no auth middleware, no session, no token check anywhere** |
| **Authorization** | ❌ none. Single-user by design, but nothing enforces that. |
| Uploads | ✅ Multer **memory** storage, 1 file, 15 MB cap (importer only) |
| Static file serving | ❌ none |

**For a local single-user app this is the correct posture.** The moment P-Hub is bound to a non-loopback interface, or an external AI endpoint is added that can be influenced by document content, this table becomes the top security concern. See §18 Phase 13.

---

## 7. Frontend Architecture Audit

### 7.1 Routing

`App.tsx` defines the top-level routes (`/`, `/projects`, `/search`, `/tags`) and nests 20 project tabs under `ProjectLayout`, which resolves the project by slug and provides it through `ProjectContext`:

`Overview · Idea · Research · Requirements · Features · Tasks · Milestones · Architecture · Decisions · Development · AI Prompts · Prompt Generator · Bugs · Testing · Deployments · Production · Documentation · Notes · Activity · Settings`

`ProjectLayout` also hosts the two global lifecycle controls: a stage `<select>` posting to `/projects/:id/stage`, and an archive/reactivate `ConfirmButton`.

### 7.2 Data flow

`useApi<T>(path)` fetches on mount and exposes `{ data, loading, error, reload }`. Mutations call `api.*` and then `window.dispatchEvent(new CustomEvent('data-changed'))`, which every mounted `useApi` consumer is expected to listen for. This is a **pull-based-with-global-invalidation** model rather than a cache library.

*Consequence for the future:* a filesystem watcher that wants to refresh the UI needs exactly one hook point — dispatch `data-changed` — so the existing pattern is a good foundation. The event is currently untyped and has no payload, which will need to change if sync needs to explain *what* changed.

### 7.3 Form and list rendering

`ResourceForm` renders any `FieldDef` (`text`, `textarea`, `select`, `date`, `number`, `url`, `tags`, `relation`) and supports relation fields that load options from another resource. `ResourcePage` renders lists, columns, and filters from `ResourceConfig`. This is why adding a resource is largely a config change.

**Two sources of truth for resource shape, duplicated across three files:** `backend/src/resources.ts` (validation, hooks, activity), `frontend/src/resources.ts` (553 lines of UI config), and `frontend/src/projectConfig.ts` (the `Project` form). Nothing enforces they agree. This is the most likely source of future "the field exists in the DB but not in the UI" bugs.

### 7.4 Project creation UI

`Portfolio.tsx` renders a create modal with two modes: **manual** (`ResourceForm` with `PROJECT_CONFIG`) and **document** (`DocumentImportWizard`). The wizard is explicitly documented as three steps — *choose* (nothing sent), *review* (parsed and mapped, nothing written, cancel leaves nothing behind), *create* (one transaction) — and carries an in-file comment stating there is no path in the component that edits an existing project. That invariant is enforced server-side too (§9.4).

### 7.5 Project settings UI

`ProjectSettings.tsx` shows read-only basics (name, slug, stage, status, created, updated, repository link, tags), relationship management, a JSON export download, and the **Danger zone**: archive/reactivate and, behind a two-step `ConfirmButton`, `DELETE /projects/:id?hard=true` with the copy *"Deletes the project and every related record. This cannot be undone."* That copy is accurate — see §5.2.

### 7.6 Frontend quality gaps

- **No tests, no test runner, no test script.** `frontend/package.json` has no test tooling at all.
- **No error boundary** at the router level; a render failure in one tab blanks the app (the `1953f5a` commit is literally *"fixing UI problem (blank screens)"* — the class of bug this leaves open).
- **`repositoryUrl` is rendered as a raw `href`** in two places with no URL scheme validation (§6.1).
- `ProjectSettings` passes `tagSuggestions={[]}` to `ResourceForm`, so tag autocomplete is lost in the edit path while creation has it.

---

## 8. Project Creation Flow

### 8.1 Manual creation — exact sequence

`POST /api/projects` → `backend/src/routes/projects.ts:148-184`:

1. `projectCreateSchema.safeParse(req.body)`; failure → `400` `VALIDATION_FAILED` with `error.flatten()`.
2. Destructure `tags` out of the payload.
3. `uniqueSlug(data.name)` — `slugify()` lowercases, replaces every non-`[a-z0-9]` run with `-`, trims leading/trailing `-`, `.slice(0, 80)`; empty result falls back to `'project'`. Collisions get `-2`, `-3`, … via a `findFirst` loop.
4. Build `originalIdea` as a JSON snapshot of the nine narrative fields + `capturedAt`.
5. `prisma.project.create({ data: { ...data, slug, originalIdea, isArchived: false } })`.
6. If tags were supplied → `setTags('project', id, tags)`.
7. `logActivity({ type: 'PROJECT_CREATED', description: 'Project "X" created (STAGE)' })`.
8. `201 { data: project }` — **the response body does not include tags.**

**`stage` is client-settable at creation** and defaults to `'IDEA'`.

### 8.2 Import creation — the same shape, but atomic

`POST /api/import/create` → `backend/src/lib/import/write.ts`. Same narrative fields, same `originalIdea` concept, same activity vocabulary — but see §9 for the full list of differences. The one that matters here: **the import path is a single transaction; the manual path is not.**

### 8.3 Findings

**(a) Creation is not atomic.** Steps 5, 6, and 7 are three independent writes. If `setTags` or `logActivity` throws, the project row survives with no tags and no `PROJECT_CREATED` event. Wrapping steps 4–7 in a `prisma.$transaction` is a small, contained fix.

**(b) `uniqueSlug` is check-then-act.** The `findFirst` loop is not protected against a concurrent creator; the unique index catches it and `app.ts` returns a clean `409`. Correct outcome, but the user-facing message is a generic conflict rather than "try a different name." Given a single user, low priority.

**(c) Two different slug rules.** Manual creation truncates to **80** characters (`projects.ts:18`); import truncates to **60** (`write.ts:36`). For the same name, the two paths can produce different slugs. Worse, 80 characters of a filesystem-illegal name is longer than most filesystems' 255-byte component limit only after accounting for encoding, so this must be unified before folders are derived from slugs. **Folder names must not be derived from a slug without a dedicated, validated folder-name function.**

**(d) `originalIdea` is overloaded.** Manual creation stores the initial idea; import stores the initial idea *plus* `importedFrom { filename, format, sizeBytes, sha256, characters }`, `importedRecords`, and `unsupportedConcepts` — with the *same field name*. Any future code that parses `originalIdea` must handle both shapes. The importer's own test asserts on this (`JSON.parse(project.originalIdea).importedFrom.sha256`). A dedicated provenance table would be cleaner; see §18 Phase 6.

**(e) The 201 response omits tags** that were just written. Minor inconsistency with `PUT`, which does return them.

---

## 9. Document Import Flow

This is the most important subsystem in the repository for the planned work, and it is well built.

### 9.1 Pipeline

`POST /api/import/analyze` (multipart field `document`) → `POST /api/import/create` (JSON `{ draft, tags }`), with `GET /api/import/capabilities` feeding the wizard's `accept` attribute.

| Module | Responsibility |
| --- | --- |
| `src/routes/import.ts` | HTTP surface, multer config, error categorisation. |
| `src/lib/import/parse.ts` | Format detection and text extraction. |
| `src/lib/import/extract.ts` | Deterministic, local extraction with provenance. |
| `src/lib/import/discovery.ts` | **Schema discovery from live Prisma DMMF.** |
| `src/lib/import/mapping.ts` | Draft validation, type coercion, limits. |
| `src/lib/import/write.ts` | **The only place the importer writes.** |

### 9.2 Parsing

`SUPPORTED_FORMATS`: `.txt`/`.text`, `.md`/`.markdown`/`.mdown`, `.json`, `.docx`, `.pdf`. Detection is by filename extension, falling back to MIME type. `MAX_BYTES = 15 * 1024 * 1024` (15 MiB), rejected with a `DOCUMENT_ERROR` naming both sizes. DOCX via **mammoth**, PDF via **pdf-parse** (text layer only, no OCR). Multer uses **memory storage**, `files: 1`.

**Nothing is written to disk, nothing is sent to a network service, and the raw file is not persisted** — only its `sha256` and metadata are recorded.

### 9.3 Extraction

Deterministic and local. `splitSections()` understands Markdown ATX headings and plain-text headings. Twelve `RecordConcept` definitions map headings **and** inline sentence patterns to entities:

`requirements` · `features` · `tech-stack` · `decisions` · `database-tables` · `api-endpoints` · `research` · `research-questions` · `milestones` · `tasks` · `issues` · `notes`

Each extracted item carries:

- `provenance`: `'explicit'` (stated in the document) or `'inferred'`
- `confidence`: e.g. `0.8` for a heading-scoped match, `0.65` unscoped
- `evidence`: the heading or sentence fragment it came from
- `horizon`: `'v1'` \| `'future'` \| `'unscoped'`, with `FUTURE_INLINE` and `V1_HEADINGS` guards so a "later" statement inside a V1 section is dropped rather than misfiled
- `duplicateOf`: set by `dedupeRecords()` when an item repeats another in the same file

Concepts Project Hub cannot represent are collected into `unsupported[]` with a reason instead of being silently dropped or force-fit. Requirement `type` and `priority` are classified from the statement text (performance/latency → `NON_FUNCTIONAL`; "must use"/"license" → `CONSTRAINT`; else `FUNCTIONAL`; "must"/"critical" → `HIGH`). `refineV1Scope()` derives `v1Scope` from the matched V1 records.

`EXTRACTABLE_ENTITIES` is exported and enforced by `mapping.ts` (`EXTRACTABLE` set) — a hand-edited draft naming `attachments` is rejected and reported as unmapped. There is a dedicated test for exactly this, using `storagePath: '/etc/passwd'`.

### 9.4 Schema discovery — the architectural centrepiece

`discovery.ts` hardcodes **no field list**. It reads `Prisma.dmmf.datamodel` and derives:

- **Project fields** — every scalar field except `id`, relation fields, and anything appearing in a relation's `relationFromFields`. Column names honour `@map`/`dbName`.
- **Enums** — real allowed values straight from the DMMF.
- **Child entities** — one per `RESOURCES` entry, with their writable fields, their `projectId` FK, any nested parent FK, and their code prefix.
- **Relations and cardinality** — from `relationFromFields`/`isList`, plus `requiredOnTo` for cascade semantics.
- **JSON-in-a-String columns** — the one thing DMMF cannot expose is schema *comments*, so `JSON_TEXT_COLUMNS` names the 11 affected columns explicitly, with an honest comment noting it affects display only, never storage.

Two honesty details worth crediting: `resolveModel()` reports unresolved delegates via `console.warn` rather than guessing, and `DERIVED_MODELS` explicitly excludes join/version tables (`FeatureRequirement`, `PromptVersion`, `ProjectDocumentVersion`, `PromptGeneration`, `TagAssignment`) because they are owned by another record.

**Implication for the future:** a `PROJECT.md` synchroniser can discover the *same* way. Adding a new project field makes it syncable with no code change.

### 9.5 Mapping and limits

`validateDraft()` coerces each value to its real Prisma type and, on failure, records an `unmapped[]` entry with the reason — including enum violations that list the allowed values. Hard limits in `mapping.ts:76-81`:

| Limit | Value |
| --- | --- |
| `maxRecordsPerEntity` | 200 |
| `maxRecordsTotal` | 1000 |
| `maxTags` | 25 |
| `maxValueLength` | 8000 |

An unticked or duplicate record goes to `skipped[]` rather than being written.

### 9.6 The write path

`importProject()` is documented as *the one and only place the importer writes*, and the code honours it:

- Wrapped in `prisma.$transaction(..., { timeout: 60_000, maxWait: 10_000 })`.
- Takes **no project id parameter at all** — structurally impossible to target an existing project. Enforced by Zod on the route and by a test (`'refuses to target an existing project'`).
- Builds the project row by iterating `importableProjectFields()` rather than a hand-picked subset, so **a column added to the schema later is picked up automatically**.
- Reuses `RESOURCES` conventions: `nextCode`, `nextNumber`, `applyDerived`, and the resource hooks — all given the **transaction client** so hook writes join the transaction instead of escaping it.
- Writes per-entity `metadata` on each activity event: `{ import: { source, entity, provenance, horizon, evidence } }`.
- On failure, converts any error into a `DATABASE_ERROR` whose message states *"nothing was saved."*

Two tests substantiate the guarantees: one injects a NUL byte (valid JS, valid Zod, rejected by Postgres) and asserts the project count is unchanged after a 500; another fingerprints every pre-existing project's name/slug/stage/description/problem/v1Scope/`originalIdea`/`isArchived`/`updatedAt` before and after an import and asserts equality.

### 9.7 Findings

**(a) Import can create new global tag rows.** `applyTags()` does `findUnique` then `create` for any tag name not already present. A document containing an unusual word in a tag field therefore **adds a project-global tag** that shows up for every other project. Defensible (tags are a shared vocabulary) but surprising, and it means imports are not as isolated as the "creates exactly one new project" framing implies.

**(b) `originalIdea` shape divergence** — see §8.3(d).

**(c) No sync identity.** Provenance is per-import and ephemeral: filename + sha256 of the source. There is no way to ask "which of these 36 requirements came from `PROJECT.md` line 40, and has that line changed?" Answering that question is the core requirement for a bidirectional synchroniser.

**(d) Stale documentation.** `backend/IMPORT-REPORT.md` reports an obsolete lifecycle enum (§5.5).

**(e) Positive note.** Tag assignment in `write.ts` correctly passes the transaction client, and derived fields are recomputed identically to the CRUD path, so imported rows are indistinguishable from hand-made ones — which is exactly what the next phases depend on.

---

## 10. Project Status & Lifecycle Model

### 10.1 The model

One column, `Project.stage`, `NOT NULL DEFAULT 'IDEA'`, with 13 values (§5.5). Archive is deliberately **orthogonal**: `isArchived` / `archivedAt`, with UI copy that says so explicitly — *"Archiving hides the project from active views but preserves all history. It does not change the stage."* That separation is good design and should be preserved.

### 10.2 How status changes

| Path | Logs? |
| --- | --- |
| `POST /projects/:id/stage` `{ stage, note? }` | ✅ `STAGE_CHANGED` with `{ fromStage, toStage, note }` |
| `PUT /projects/:id` with `stage` in the body | ❌ logs `PROJECT_UPDATED` only |
| `PUT /projects/:id/import` (project-level edit via `ResourceForm`) | ❌ same as above |

**Confirmed defect: `projectUpdateSchema = projectCreateSchema.partial()` includes `stage`.** The generic project edit modal (`ProjectSettings` → *Edit project* → `ResourceForm` with `PROJECT_CONFIG`) posts the whole form, so if `PROJECT_CONFIG` renders a stage field, an edit silently changes the stage with no `STAGE_CHANGED` event. Even if it does not render one today, the API permits it. This is the status-integrity finding from §1, and it is a two-line fix: omit `stage` from the update schema and force stage changes through the dedicated endpoint.

**No transition rules exist.** Any of the 13 values can follow any other, including `PRODUCTION → IDEA` and `ARCHIVED → BUILDING`. There is no guard, no reason field, and no history beyond the activity event.

### 10.3 Derived progress

`projectStats.ts` exports `STAGE_ORDER`, used in `GET /api/projects` to compute a fallback `progress` percentage from stage position when a project has no tasks:

```ts
progress = total > 0
  ? round(done / total * 100)
  : (STAGE_ORDER.indexOf(stage) >= 0
      ? round(STAGE_ORDER.indexOf(stage) / (STAGE_ORDER.length - 1) * 100)
      : 0)
```

**This is a stage-position percentage presented as "progress"** — a project at `PRODUCTION` with zero tasks shows ~78% complete. It is a display heuristic, not a measure of work, and it will look like a bug once evidence-based status exists. Worth renaming or relocating to an explicit `stagePosition` field in the future.

### 10.4 Heuristic next actions

`buildNextActions()` is the closest thing to an automation engine that exists: blocked/overdue task counts, critical open issues, open tasks while `TESTING`, `PRODUCTION` with no deployment, and a deployment staleness warning after 30 days. It is **advisory string generation with no persisted state**.

### 10.5 What does not exist

- No stage-transition validation or state machine.
- No per-stage completion criteria or required evidence.
- No automated stage advancement of any kind.
- No status history beyond `STAGE_CHANGED` activity events.
- No `BUILDING` gate. The two live `BUILDING` projects were placed there by hand, and nothing verifies why.

**The `BUILDING` requirement:** when this is implemented, `BUILDING` must be gated on evidence — e.g. at least one completed development session, or a non-empty `src/`, or an in-progress task — and a project-folder creation event must never be sufficient on its own. This is Phase 8 and Decision I.

---

## 11. Filesystem & Project Folder Management

### 11.1 Finding: there is no filesystem integration

This was verified by exhaustive content search across `backend/src`, `frontend/src`, and `scripts`, for: `node:fs`, `fs`, `node:os`, `node:path`, `path`, `child_process`, `exec`, `execFile`, `spawn`, `fork`, `watch`, `chokidar`, `readdir`, `mkdir`, `readFile`, `writeFile`, `PROJECT_ROOT`, `projectsRoot`.

**Result: zero matches in application source.** Specifically:

- **No filesystem capability exists in the backend.** Nothing reads or writes a user's project directory.
- **No `PROJECTS_ROOT` / `projectsRoot` configuration** in `.env`, `.env.example`, or code.
- **No settings table.** Confirmed absent from `information_schema`. There is nowhere in the database to store a root path, and no place in the UI to configure one.
- **No folder creation, no template scaffolding, no folder-name derivation, no collision handling.**
- **No file watcher.** `chokidar` appears in `backend/package-lock.json` **only as a transitive dependency** and is never imported.
- **No process spawning**, so no shell execution, no IDE launch, no `code .` integration, and — importantly — **no command-injection surface today**.
- **No OS detection, no path-case handling, no symlink policy, no canonicalisation.**
- **`attachments.storagePath` is a dead column.** The `attachments` table has 0 rows, the importer explicitly refuses to create them, and nothing uploads files. A `text` path column with no writer is a future footgun: the moment an upload path exists, it must not accept caller-supplied absolute paths.

### 11.2 What does exist

Only the PowerShell launcher touches the filesystem, and only for its own bookkeeping: `%LOCALAPPDATA%\ProjectHub\state.json` for window PIDs, `Test-Path` prerequisite checks, and `Get-Content` of `backend/.env` to read `BACKEND_PORT`. All of this is launcher-scoped, not application logic, and it never touches a managed project.

### 11.3 What this means for the plan

Good news: **there is no legacy to unpick and no existing path handling to harden.** The entire filesystem capability is greenfield, and it can be designed correctly from the start with no back-compat burden. The three requirements the plan must satisfy:

1. **Path safety.** Resolve the configured root once at startup, `path.resolve` + `fs.realpath` every derived path, and assert the result is inside the root before any read or write. Refuse symlinks that escape the root. Never interpolate a user string into a shell command — use `child_process.spawn` with an argument array if IDE launching is ever added.
2. **Non-derivation from slug.** Slugs allow `[a-z0-9-]`, truncate at 80, and carry numeric suffixes. A dedicated `folderName` function must additionally reject Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`), trailing dots/spaces, and case-insensitive collisions, and must be bounded well below 255 bytes to survive UTF-8 encoding.
3. **Reversibility.** Database and filesystem cannot share a transaction. The compensation strategy is a decision, not an implementation detail — see Decision E.

---

## 12. Project Links, URLs & External References

### 12.1 Current URL-shaped columns (verified in `information_schema`)

| Table.column | Purpose | Live rows populated |
| --- | --- | ---: |
| `projects.repositoryUrl` | The single project repository | **0 / 8** |
| `git_references.repositoryUrl` | Per-reference repo URL | 1 |
| `git_references` (`kind` ∈ `REPOSITORY`,`COMMIT`,`BRANCH`,`PULL_REQUEST`,`RELEASE`) | Typed code-host references | 1 (`COMMIT`) |
| `deployments.url` | Deployed instance URL | 1 |
| `research_entries.url` | Source URL for a research item | some of 21 |
| `api_endpoints.path` | API route path, **not** a URL | 3 |
| `attachments.storagePath` | Local file path, **no writer** | 0 |

**There is no `project_links` table, and no `frontendUrl` / `backendUrl` / `demoUrl` / `docsUrl` fields anywhere.** The only project-level link is the single `repositoryUrl`, which is currently empty for every project in the database.

### 12.2 The gap

"Support multiple links per project" cannot be met by adding columns. A project realistically has a repository, a live demo, a staging deployment, a backend API, a docs site, a design file, and a CI dashboard. A `demoUrl`/`backendUrl`/`frontendUrl` column triple is a losing shape: it does not scale, has no per-link metadata, and every new link category becomes a migration.

### 12.3 Current validation gaps

**`repositoryUrl` is not validated as a URL.** `projectCreateSchema` accepts any string up to 1 000 characters. It is rendered twice in the frontend as `<a href={project.repositoryUrl} target="_blank" rel="noreferrer">`. In a React app, `javascript:` in an `href` is a live XSS vector if any untrusted content (an imported document, a clipboard paste, a future AI-suggested link) can reach that field. **The importer can currently write it** — `write.ts` iterates `importableProjectFields()`, which includes `repositoryUrl`, and coercion is to `String`, so a document containing `Repository URL: javascript:alert(1)` would be stored and rendered. This is a real, low-effort fix: validate with `z.string().url()` and/or an explicit `https?:` scheme allowlist in the shared validation layer.

**`api_endpoints.path` is a path, not a URL** — correctly so, but the column name invites confusion and there is no base-URL concept.

### 12.4 Recommendation

Introduce a `ProjectLink` model rather than extending `repositoryUrl`:

```
ProjectLink { id, projectId, kind, label, url, isPrimary, createdAt, updatedAt }
  kind ∈ REPOSITORY | LIVE_DEMO | STAGING | PRODUCTION | API | DOCS |
        DESIGN | CI | CHAT | OTHER
  @@unique([projectId, kind, url])
```

Then **deprecate `projects.repositoryUrl`** by backfilling it into `ProjectLink` and keeping it only as a derived convenience read, rather than maintaining two sources of truth. This is Phase 12 and Decision J-adjacent. It also gives the future a natural place to record the folder-vs-remote relationship, since a local `folderName` and a `REPOSITORY` link will want to be cross-checked.

---

## 13. AI, Prompt Generation & Agent Readiness

### 13.1 What exists: a deterministic prompt generator

Seven modules under `backend/src/lib/generator/`:

| Module | Role |
| --- | --- |
| `collect.ts` | Gathers project context from the database. |
| `analyze.ts` | Derives readiness/completeness signals. |
| `build.ts` | Assembles the prompt text. |
| `validate.ts` | Validates the assembled prompt. |
| `readiness.ts` | Readiness criteria. |
| `pipeline.ts` | Orchestrates the above. |
| `types.ts` | Shared types. |

**It makes no network calls and uses no model.** There is no provider SDK, no API key, no HTTP client to any AI service, and no AI credential in `backend/.env` or `.env.example`. Output is assembled locally and stored as an ordinary `PromptGeneration` + `Prompt` + `PromptVersion`.

This is an important and healthy property: **the AI surface today is a pure function of local data.** It cannot leak, cannot hallucinate into the database, and cannot be prompt-injected by a document.

### 13.2 Existing AI-related models

| Model | Live rows | Notes |
| --- | ---: | --- |
| `Prompt` | 3 | `code`, `title`, `category`, `result` (`PromptResult`), `finalVersionId`. |
| `PromptVersion` | 4 | `version`, `text`, `response`, `changes`, `reason`. Full version chain. |
| `PromptGeneration` | 1 | One generator run, with `analysis`/`readiness` JSON. |
| `AiSession` | 2 | A single record per session with a `date` and narrative fields. |

**`AiSession` is not a conversation model.** It has no messages, no per-turn sequence, no role, no token counts, no model identity, and no parent/child structure. `GET /projects/:key/ai-timeline` returns it as a flat list alongside prompts.

### 13.3 Prompt versioning — a genuinely good pattern

`generic.ts` special-cases prompts: creating a prompt writes `Prompt` + `PromptVersion 1` and sets `finalVersionId`; `promptVersionRouter` adds further versions and logs `PROMPT_VERSIONED` with the prompt code. Body `text`/`response` are stripped from prompt *updates* so a version can never be silently mutated. The `AI Prompts` tab exposes the full chain.

**This versioning discipline should be inherited by the future conversation system**, which is why Phase 13 introduces a new model rather than overloading `PromptVersion`.

### 13.4 Gap analysis for conversation + agent support

| Requirement | Status | Gap |
| --- | --- | --- |
| Message/turn persistence | ❌ | No `Conversation` or `Message` model. No `sequence`, `role`, `content`, or per-message timestamp. |
| Model metadata | ❌ | No provider, model name, version, temperature, or token-usage storage anywhere. |
| Streaming | ❌ | No SSE or chunked response path. |
| Provider transport | ❌ | No SDK, no HTTP client for any AI service. |
| API-key handling | ❌ | No key storage, no key redaction, no rotation story. |
| Context assembly | ⚠️ Partial | `collect.ts` gathers project context well, but it is shaped for a *static* prompt, not a token-budgeted, redaction-aware conversation window. |
| Tool/agent actions | ❌ | No tool registry, no action model, no approval state, no execution log. |
| Cost/usage tracking | ❌ | Nothing. |
| Prompt-injection defence | ⚠️ | The importer's `evidence` and document text become `Note`/`ResearchEntry` content. A future AI step reading them is the first place untrusted content influences model behaviour. |
| Redaction | ❌ | No secret-pattern detection. `repositoryUrl`, deployment URLs, and imported text all pass through untouched. |

### 13.5 Security posture for the future

Adding an external AI call changes the risk profile of the whole application in three specific ways:

1. **The backend makes outbound network requests.** Today it talks to exactly one host: the local database.
2. **Document content becomes model input.** Import accepts arbitrary `.docx`/`.pdf`/`.txt`. A document containing adversarial instructions is a live prompt-injection vector once the agent reads project records.
3. **The API key becomes a secret in a local app** that has no auth. Any process on the machine that can reach `localhost:4000` can spend the key.

Mitigations, folded into Phase 13: key from environment only (never DB, never `.env` committed, never returned by any endpoint), an explicit host allowlist on outbound requests, a redaction pass over context before send, a hard token budget, and a visible confirmation step for any action the model requests. See Decisions G and H.

### 13.6 Positive note

The readiness/validation layer means a generation request is already refused or flagged when project data is too thin. Extending that "tell the user what is missing before you generate" pattern to conversation context is straightforward and consistent with the existing design.

---

## 14. Configuration, Environment & Secrets

### 14.1 Current configuration surface

`backend/.env.example` defines exactly three variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. |
| `BACKEND_PORT` | Backend listen port. Default `4000` in code and launcher. |
| `CORS_ORIGIN` | Comma-separated allowed origins, split at `app.ts:19`. |

There is **no root `.env`**. The launcher reads `BACKEND_PORT` out of `backend/.env` itself, so the one-click path respects a non-default port.

**`PROJECTS_ROOT` does not exist in any form** — not in `.env.example`, not in code, not in the database, not in the UI.

### 14.2 Secrets handling

- `backend/.env` holds a live local PostgreSQL credential and is **git-ignored** (`.gitignore:11`). Verified: `git ls-files backend/.env` returns nothing; only `.env.example` is tracked. **This is correct.**
- No API keys of any kind are stored anywhere in the repo.
- There is no settings table, so there is currently no risk of a secret ending up in a database row.
- `prisma/seed.ts` and the launcher state file are not secret-bearing.

### 14.3 Runtime environment loading — one open question

`app.ts` reads `process.env` for port/CORS, but **neither `index.ts` nor `app.ts` imports `dotenv/config`**. `dotenv` is a declared dependency, and it *is* imported by the test setup and by the Prisma CLI (which loads `.env` itself). The launcher does not set the variables in the child process environment — it only *reads* `BACKEND_PORT` to decide which port to poll.

In practice `npm run dev` works, which means the variables reach the process through one of: `tsx`/`node` picking up `.env` implicitly, the Prisma client engine loading it, or the user's shell profile. **This was not confirmed by running the server, because that is outside audit scope.** The risk is that behaviour differs between `npm run dev`, `npm start`, and the launcher. For a future `PROJECTS_ROOT` — a value the application must read at startup and validate — this ambiguity must be resolved first, by explicitly loading configuration at the entry point and failing fast on a missing or invalid value.

### 14.4 Where `PROJECTS_ROOT` belongs

| Option | Assessment |
| --- | --- |
| **Environment variable (recommended)** | Matches the existing `backend/.env` convention. The filesystem root is a *deployment/host* concern, not application content. Survives a DB reset. Cannot be set from a web page that has no auth. |
| Database settings table | Convenient for a UI picker, but creates a chicken-and-egg problem (the app needs the root to work; the root lives in the app) and puts a host path inside a backup-able data store. If added later, it should be a UI convenience that writes a value the env var can override. |
| Hardcoded default (e.g. `~/Projects`) | Simplest, but silently operates on the wrong directory. Must be paired with explicit first-run confirmation. |

**Recommendation:** `PROJECTS_ROOT` in `backend/.env`, required at startup, validated to an existing absolute directory, with the absolute resolved path exposed read-only in a settings/status UI so the user can see what the app is pointed at. Optional DB override for UI-driven changes, with the env var taking precedence.

---

## 15. Safety, Data Protection & Deletion Semantics

### 15.1 What is already right

- **Archive-by-default deletion.** `DELETE /api/projects/:id` sets `isArchived`/`archivedAt` and logs `PROJECT_ARCHIVED`. Hard deletion requires the explicit `?hard=true` query parameter.
- **Transactional import.** One `prisma.$transaction` with a 60 s timeout; a single unwritable value rolls back the whole project.
- **Structurally impossible to import into an existing project.** No parameter exists to pass a project id.
- **Correct cascade rules.** Project-owned rows cascade; optional cross-links (`task.featureId`, `prompt.issueId`, `decision.supersededById`) are `SET NULL`, so deleting a feature does not silently destroy its tasks.
- **Memory-only uploads**, 15 MB cap, single file, no disk write, no outbound transfer.
- **The imported file is never stored** — only `sha256`, filename, format, size, and character count.
- **UI copy matches behaviour.** The danger-zone text *"Deletes the project and every related record"* is accurate, including the activity timeline.

### 15.2 Gaps

| # | Gap | Detail |
| --- | --- | --- |
| 1 | **Generic delete is unguarded** | §6.3(b). No activity event, no confirmation, no transaction, orphans tag assignments, silently discards prompt version history. |
| 2 | **Tag-assignment orphans** | `tag_assignments` has no FK to its target. Every deleted resource leaks rows. `seed.ts:15` works around this. |
| 3 | **Hard delete has no second factor** | `?hard=true` is a query string. No typed confirmation, no project-name echo, no pre-delete summary. |
| 4 | **Hard delete removes the audit trail** | `activity_events.projectId` is `ON DELETE CASCADE`, so a hard delete erases the record that it happened. At minimum, hard deletion should leave a global tombstone. |
| 5 | **Project create is not atomic** | §8.3(a). |
| 6 | **URL fields unvalidated** | §12.3. |
| 7 | **Import can create global tags** | §9.7(a). |
| 8 | **`seed.ts` FORCE=1** | See §15.4. |
| 9 | **No backup mechanism** | The JSON export is per-project and manual. There is no whole-database backup, and the "your data is never locked in" claim rests entirely on a user remembering to click download. |
| 10 | **No auth** | §6.5. Acceptable locally; a blocker for anything beyond localhost. |

### 15.3 The seed script

`backend/prisma/seed.ts` (374 lines):

- `const FORCE = process.env.FORCE === '1'`.
- `main()` counts projects; **if any exist and `FORCE` is not set, it prints `"Seed skipped: N project(s) already exist. Run FORCE=1 to reseed."` and returns.** This is the correct default-deny behaviour.
- `clearAll()` runs only when `FORCE=1` **and** at least one project exists: 28 `deleteMany` calls, children before parents, `project` before `tag`.

**Assessment:** the guard is sound — a bare `npm run db:seed` against the current 8-project database is a no-op. The residual risk is that `FORCE=1` is a single environment variable with no additional confirmation and destroys 202 activity events along with everything else, and `FORCE=1` is not documented in `.env.example`.

### 15.4 Data-loss scenarios not currently guarded

1. A user hard-deletes a project, taking 202-class activity history with it.
2. A user deletes a prompt, taking its version chain via cascade.
3. A bug in future sync logic deletes records it failed to match.
4. A test run hard-deletes a real project (mechanism in §16.2).
5. The database is lost with no backup beyond a manual per-project export.

### 15.5 What future work needs

- A **trash/archive tier** before hard delete, with a global tombstone for hard deletion.
- **Activity logging on every destructive operation**, including generic deletes.
- **Two-step destructive confirmation** (type the project name, or a short-lived server-issued token) for `?hard=true`.
- **Tag-assignment cleanup** inside the generic delete path.
- **A whole-database backup/restore command** and, if a filesystem feature lands, a documented recovery story for the folder.
- **Test isolation before any further schema work** — see §16.2.

---

## 16. Testing & Quality Assurance

### 16.1 Inventory

Vitest + Supertest, configured in `backend/vitest.config.ts`: Node environment, 20 s test timeout, 30 s hook timeout, `fileParallelism: false`.

| File | `describe` | `it` | Focus |
| --- | ---: | ---: | --- |
| `tests/api.test.ts` | — | 19 | Project CRUD, slug uniqueness, stage events, archive, resources, tags, relationships, search. |
| `tests/import.test.ts` | — | 36 | Discovery reflects live schema, parsing per format, extraction, provenance, horizon, mapping limits, allowlist enforcement, transaction rollback, isolation. |
| `tests/promptGenerator.test.ts` | — | 27 | Readiness, context collection, prompt building, validation. |
| **Total** | **22** | **82** | |

`tests/helpers.ts` provides an `api` supertest agent bound to the real Express app and an exported `prisma` instance.

### 16.2 The blocking problem: tests run against the live database

`tests/setup.ts` sets `NODE_ENV=test` and imports `dotenv/config`, which loads `backend/.env`. **No `DATABASE_URL` override exists** — not in `vitest.config.ts`, not in the setup file, not in any `.env.test`. Tests therefore connect to the same `projecthub` database the application uses.

The tests create real projects through the real API and remove them with the real hard-delete endpoint. `import.test.ts` tracks created ids in a `created[]` array and hard-deletes them in `beforeAll`/`afterAll` via `prisma.project.deleteMany`. The API tests use a similar helper.

**Consequences:**

- Any failure between create and cleanup **leaves records behind permanently.** Project `id` 330, created 2026-09-28 with a test-shaped slug, is very likely residue from exactly this.
- A failed `import.test.ts` run can leave orphan `tag_assignments` (§5.2), which `prisma.project.deleteMany` will not remove.
- A mistyped or inherited `DATABASE_URL` would make the suite destructive against real data.
- The `'never modifies a pre-existing project'` test is *evidence of the risk*, not evidence against it: it asserts that an import does not touch other rows, while the suite itself is concurrently creating and deleting them.

**This is why the audit did not run the test suite.** Running it would have modified real project data, violating the audit constraint. Verifying the suite's health requires first giving it an isolated database.

**Fix (Phase 16):** `setupFiles` that force `DATABASE_URL` to a dedicated test schema (e.g. `?schema=p-hub_test`), `migrate deploy` in a global setup, and per-run truncation instead of create/delete cleanup. Cost: roughly half a day. Benefit: every future phase can be developed and tested normally.

### 16.3 What the tests do well

The importer tests are exemplary and encode the subsystem's safety properties as executable assertions:

- `'exposes the real Project columns and none that do not exist'` — discovery cannot drift.
- `'rolls the whole import back when one record cannot be written'` — injects a NUL byte, which is valid JS and valid Zod but rejected by Postgres, so the failure can only surface *inside* the transaction.
- `'never modifies a pre-existing project'` — fingerprints 10 fields of every pre-existing project before and after.
- `'refuses entities the importer never extracts, even in a hand-edited draft'` — uses a `/etc/passwd` `storagePath` to prove the allowlist works against a hostile client.
- `'stores every importable project field, not a hand-picked subset'`.
- `'refuses to target an existing project'`.

The tests include explanatory comments explaining *why* the assertion matters. This is the testing standard the new filesystem and sync code should meet.

### 16.4 Gaps

| Gap | Impact |
| --- | --- |
| **No test-database isolation** | §16.2. Blocks all safe development. |
| **No frontend tests at all** | No runner, no script, no component tests. The 553-line wizard and the 553-line resource config are entirely untested. |
| No concurrency tests | The check-then-act slug loop and the sequential `nextCode` scan are both race-prone and unverified. |
| No cascade/deletion tests | The `SET NULL` vs `CASCADE` distinction is correct in the schema but unasserted. |
| No route-ownership test | The `generic.ts` filter-injection bug (§6.3(a)) is exactly the class of bug a `?projectId=<other>` test would catch. |
| No auth/security tests | N/A while there is no auth, but a gap once there is. |
| No `npm run lint` at the root | Only `eslint-disable-next-line` comments appear in the frontend; no lint script is defined at the root. |

---

## 17. Architectural Decisions (A–J)

These are the decisions the future implementation must make. Each is stated with its rationale and the rejected alternative, so a future contributor can see why the choice was made.

### A. Source of truth: database or `PROJECT.md`?

**Decision — the database is authoritative; `PROJECT.md` is a managed projection of it.**
The app must always render and export from the DB. The file is a deterministic render plus a machine-readable sync block. This keeps the 8 live projects and 202 activity events exactly where they are, keeps the existing export path truthful, and means a corrupt or hand-mangled file can never lose data.
**Rejected:** file-as-truth, which would require a complete import of every existing project and would make the DB a cache that can be rebuilt only by parsing Markdown.

### B. Write authority: who may change a record?

**Decision — three explicit modes, no silent merges.**
`DB_ONLY` (file regenerated, file edits ignored/reported), `FILE_READONLY` (file is regenerated and never parsed), and `SYNC` (file is parsed and applied after review). Every applied change is attributable to a source: `db-ui`, `file`, `import`, or `agent`.
**Rejected:** last-write-wins. Two users — or a user and their editor — would silently clobber each other.

### C. Deletion semantics for sync

**Decision — removal from `PROJECT.md` never deletes DB records.**
A missing item is marked `orphaned` with a timestamp and shown in the UI; deletion requires an explicit user action. Rationale: absence of evidence is not evidence of absence; Markdown sections get renamed and reorganised constantly; and the catastrophic failure mode is irreversible data loss on a cosmetic edit.
**Rejected:** mirror deletion (too destructive) and "prompt on every removal" (too noisy to be usable).

### D. Folder identity, naming and collisions

**Decision — a dedicated `folderName` column, validated, never derived from `slug`.**
Not null, unique per project, validated against Windows reserved names, trailing dots/spaces, length in bytes, and case-insensitive collisions. Folder creation is **idempotent**: an existing non-empty folder is adopted only after explicit user confirmation; a collision with a *different* project always fails and asks the user to choose.
**Rationale:** slugs truncate at 80 vs 60 depending on the code path (§8.3(c)), carry `-2` suffixes, and are a URL concern. Folders are a filesystem concern.
**Rejected:** derive from slug (breaks on the two different rules and on Windows reserved names); hash suffix (unreadable); "just pick the next free name" silently (creates folders nobody can predict).

### E. Cross-store consistency: DB + filesystem

**Decision — database first, filesystem second, with an explicit compensating action and a persisted operation record.**
A `ProjectFolderOp` row records intent (`create`, `adopt`, `move`, `remove`) and outcome. If the DB transaction commits but the folder write fails, the project is marked `folderState: 'ERROR'` with the reason and is retried on demand — it is never left silently inconsistent. The reverse order is forbidden: never create a folder for a project row that does not exist.
**Rationale:** there is no distributed transaction here. An outbox-style record is the only honest way to represent a two-phase operation.
**Rejected:** write the folder first (a failed DB insert orphans a folder); best-effort fire-and-forget (silent divergence); distributed transactions (absurd for one local app).

### F. Provenance and confidence persistence

**Decision — give sync a first-class provenance record rather than overloading `originalIdea`.**
`RecordOrigin { projectId, model, recordId, source: 'file'|'ui'|'import'|'agent', sourcePath, sourceHash, importedAt, confidence, evidence, lastSyncedHash }`, with a `§7 origin` annotation in the file itself. The existing per-value `provenance`/`confidence`/`evidence` from the importer becomes persistent rather than ephemeral.
**Rationale:** the importer already computes exactly this and throws it away at the end of the request (§9.7(c)). `originalIdea` already means two different shapes (§8.3(d)).
**Rejected:** no provenance (unattributable changes); prose notes (not queryable).

### G. Redaction and context safety for AI

**Decision — a mandatory redaction and budget pass between the database and any outbound model call.**
Secret-pattern detection (keys, tokens, `.env` contents, credentials, private key blocks, connection strings) runs over assembled context and is **reported to the user as a count**, never silently dropped. A hard token budget with deterministic truncation. Context provenance travels with every fragment, and imported document text is explicitly labelled untrusted.
**Rationale:** §13.5. Imported documents are arbitrary user content; a future agent reading them is the first prompt-injection surface in the application.
**Rejected:** sending everything (leak risk); silently redacting (the user cannot tell what the model actually saw).

### H. Agent action approval and audit

**Decision — the model may propose, never execute.**
An `AgentAction { projectId, kind, args, rationale, risk, status: proposed|approved|rejected|executed|failed, result }` record. Read-only actions may be auto-approved; anything that writes to the DB, writes to disk, or spawns a process requires explicit user approval in the UI. Every action, approved or not, is written to the activity timeline. Process execution is limited to an allowlist and spawned with an argument array — never `shell: true`.
**Rationale:** §11.1 confirms no `child_process` usage exists today, so there is no precedent to inherit and no existing attack surface to protect. That is a reason to design carefully, not to be casual.
**Rejected:** autonomous execution (a prompt-injected document could delete projects); shell-string commands (injection).

### I. `BUILDING` stage evidence

**Decision — `BUILDING` requires evidence, and folder creation is never sufficient.**
Qualifying evidence: at least one `DevelopmentSession` with recorded work, or an in-progress task, or the presence of a source directory in the managed folder. A folder created by P-Hub alone is never evidence. Transitions are validated against an explicit state machine, and an automated transition writes a `STAGE_CHANGED` event carrying the evidence that justified it — so automation and manual changes produce the same auditable trail.
**Rationale:** this is an explicit product requirement, and the current system has zero transition rules (§10.5).
**Rejected:** folder-creation heuristic (a user can create folders for planning); free-form stages (unverifiable).

### J. Link model and path/remote coherence

**Decision — a typed `ProjectLink` table; `repositoryUrl` becomes a derived read.**
`@@unique([projectId, kind, url])` with an `isPrimary` flag per kind. Existing `repositoryUrl` values are backfilled. When a folder and a `REPOSITORY` link disagree (e.g. the link points at a different repo than the local `git remote`), surface it as a warning rather than auto-correcting.
**Rationale:** §12. Multiple link categories cannot be modelled as columns, and a folder/remote mismatch is a real and common source of confusion.
**Rejected:** adding `demoUrl`/`backendUrl`/`frontendUrl` columns (does not scale, no metadata); leaving `repositoryUrl` authoritative alongside a new table (two sources of truth).

---

## 18. Proposed 16-Phase Future Plan

Each phase lists purpose, files, database, API, frontend, dependencies, risks, and tests. **Phases are ordered by dependency; none may start before its predecessors.**

---

### Phase 1 — Audit and baseline freeze ✅ *(complete)*

**Purpose:** establish ground truth before changing anything.
**Deliverables:** this report; verified live schema; verified migration state; verified data inventory.
**Files:** `report.md` (new). Nothing else modified.
**Risks mitigated:** every later phase is designed against reality rather than against `IMPORT-REPORT.md`, which is stale (§5.5).

---

### Phase 2 — Fix the two confirmed API defects

**Purpose:** close the two §1 findings before building on top of them.
**Depends on:** Phase 1.

**Files:** `backend/src/routes/generic.ts` (filter allowlist + reserved-key rejection), `backend/src/routes/projects.ts` (`stage` removed from `projectUpdateSchema`), `backend/src/lib/errors.ts` (add a `DB_CONFLICT` category; remove the dead `isDbProblem` ternary in `app.ts:124`), `backend/tests/api.test.ts`.
**DB:** none.
**API:** Generic list filters become allowlist-driven — a **breaking change** for any client relying on arbitrary query filtering. Audit the frontend's filter usage first; `ResourceConfig.filters` is the intended allowlist.
**Frontend:** no change expected; verify each list's filters.
**Dependencies:** none new.
**Risks:** breaking undocumented filter behaviour; medium.
**Tests:** `GET /api/projects/1/tasks?projectId=2` returns only project 1's rows; `?bogus=1` is ignored or rejected; `PUT /projects/:id` with `stage` is rejected; `POST /projects/:id/stage` still logs `STAGE_CHANGED`.

---

### Phase 3 — Test database isolation

**Purpose:** make it safe to develop anything else (§16.2).
**Depends on:** Phase 1. **Strongly recommended before Phase 2's tests are relied upon.**

**Files:** `backend/vitest.config.ts`, new `backend/tests/setup.ts` (force `?schema=p_hub_test`, `migrate deploy`, truncate between files), `backend/tests/helpers.ts`, `backend/.env.example` (document `DATABASE_URL` shape and the test schema).
**DB:** a dedicated test schema. **No production schema change.**
**API/Frontend:** none.
**Dependencies:** none new.
**Risks:** a test that reaches for a real table name outside the test schema; mitigate by asserting the schema name in global setup. Medium-low.
**Tests:** the existing 82 declarations must pass against the test schema, plus a guard that fails if `DATABASE_URL` does not contain the test schema.
**Benefit:** unblocks every subsequent phase.

---

### Phase 4 — Configurable Projects Root

**Purpose:** introduce `PROJECTS_ROOT` as a validated startup dependency (Decision, §14.4).
**Depends on:** Phase 3.

**Files:** new `backend/src/config.ts` (load + validate + resolve + realpath; fail fast), `backend/src/index.ts` (explicit config load), `backend/src/app.ts` (expose a sanitised, read-only status), `backend/.env.example`, `backend/src/app.ts` health/meta route.
**DB:** none initially. Optional `AppSetting` later for a UI override, with env precedence.
**API:** `GET /api/settings` returning `{ projectsRoot, projectsRootExists, managedProjectCount }` — **read-only, never accepting a path**.
**Frontend:** new Settings page section showing the resolved absolute path and a warning if it is missing or not writable.
**Dependencies:** none new (`node:path`, `node:fs` are built-ins).
**Risks:** silently pointing at the wrong directory; mitigate with first-run confirmation and always-visible display. Low.
**Tests:** valid/invalid/missing root; unreadable root; symlinked root resolves correctly.

---

### Phase 5 — Project path model and folder orchestrator

**Purpose:** give each project a managed folder, created safely and reversibly (Decisions D, E).
**Depends on:** Phase 4.

**Files:** new `backend/src/lib/paths.ts` (`folderName()` validation, `resolveInRoot()` canonicalisation, escape detection), new `backend/src/lib/folders.ts` (orchestrator), new `backend/src/lib/folderOps.ts` (persisted operation record), new `backend/src/routes/folders.ts`, `backend/src/routes/projects.ts` (create/update/delete integration), `backend/src/lib/errors.ts` (`PATH_*` categories).
**DB:** new migration — `Project.folderName` (unique), `Project.folderPath` (relative to root, for display only), `Project.folderState` enum (`NONE`/`PENDING`/`READY`/`ERROR`/`ADOPTED`), `ProjectFolderOp { id, projectId, kind, requestedPath, resolvedPath, status, error, createdAt, completedAt }`.
**API:** `POST /projects/:id/folder` (create), `POST /projects/:id/folder/adopt`, `POST /projects/:id/folder/remove` (archive-only, never delete files automatically), `GET /projects/:id/folder` (status + last error + pending op).
**Frontend:** folder status chip on `ProjectLayout`; create/adopt/retry/remove actions in `ProjectSettings`.
**Dependencies:** none new. **Do not add chokidar yet** (Phase 9).
**Risks:** (a) path traversal or symlink escape — mitigated by resolve + realpath + containment assertion; (b) partial DB/disk failure — mitigated by the `ProjectFolderOp` outbox and `folderState: 'ERROR'`; (c) **project creation must not start depending on disk success** — wrap project create + slug + tags + activity in a transaction first, then perform the folder step, so folder failure never blocks project creation. Medium.
**Tests:** reserved names, trailing dots/spaces, case-insensitive collision, length in bytes, traversal attempts, symlink escape, existing-empty-folder adopt, existing-non-empty-folder refusal, DB-commit-then-disk-failure leaving `folderState: 'ERROR'` and a retryable op, and an explicit assertion that **no filesystem state implies a `BUILDING` stage**.

---

### Phase 6 — `PROJECT.md` template and renderer

**Purpose:** generate a canonical, human-readable `PROJECT.md` from project data. Read-only; no parsing yet.
**Depends on:** Phase 5.

**Files:** new `backend/src/lib/markdown/template.ts` (sections), new `backend/src/lib/markdown/render.ts`, new `backend/src/lib/markdown/syncBlock.ts` (machine-readable block), `backend/src/lib/folders.ts` (write path), `backend/src/routes/projects.ts` (`GET /projects/:key/project-md`, `POST /projects/:id/project-md/refresh`).
**DB:** none (the sync block is generated from existing data).
**API:** preview (returns text, writes nothing) and write-to-disk. The preview endpoint must be the default in the UI.
**Frontend:** a Markdown preview panel with a copy button and an explicit *Write to folder* confirmation.
**Dependencies:** none new. A Markdown library is **optional** — a deterministic string renderer keeps output stable and diffable, which matters more than syntax highlighting.
**Risks:** nondeterministic output causing noisy diffs — mitigate with a fixed section order and a stable timestamp placement; low.
**Tests:** golden-file tests for the rendered output; idempotence (render twice, identical bytes); all 13 stages render correctly; empty project renders valid Markdown.

---

### Phase 7 — Sync state, identity and provenance

**Purpose:** make the sync relationship answerable — which record came from which file line, and has it changed?
**Depends on:** Phase 6.

**Files:** `backend/src/lib/markdown/syncBlock.ts` (stable per-record ids), new `backend/src/lib/markdown/identity.ts` (id derivation), `backend/src/lib/import/discovery.ts` (reuse), `backend/src/routes/projects.ts`.
**DB:** new migration — `RecordOrigin` (Decision F) and `ProjectSyncState { projectId, lastSyncedAt, lastSyncedHash, syncMode, status, lastError }`.
**API:** `GET /projects/:id/sync` (state, conflicts, orphans), `PUT /projects/:id/sync/mode`.
**Frontend:** sync status block in `ProjectSettings`; per-record origin badges in resource detail views.
**Dependencies:** none new.
**Risks:** identity churn when sections are reordered — mitigate with content-hash matching plus explicit renames; medium.
**Tests:** stable ids across renders; reorder does not change identity; a genuinely new record gets a new id; identical content yields no change.

---

### Phase 8 — `PROJECT.md` synchronisation engine

**Purpose:** two-way, review-before-write synchronisation by **extending the existing importer** (never a second importer).
**Depends on:** Phase 7. Requires Phase 3 for safe testing.

**Files:** `backend/src/lib/import/parse.ts` (register `PROJECT.md` as a source), `backend/src/lib/import/extract.ts` (reuse `RecordConcept`; add an identity-aware mode), `backend/src/lib/import/discovery.ts` (**unchanged** — the reuse point), `backend/src/lib/import/mapping.ts` (add `UPDATE`/`SKIP` actions alongside `CREATE`), new `backend/src/lib/import/apply.ts` (the only module that applies an update to an existing project, in a transaction), `backend/src/routes/import.ts` (add a sync route; keep the create-only guard on the import route).
**DB:** none new beyond Phase 7.
**API:** `POST /api/import/sync/analyze` and `POST /api/import/sync/apply`, mirroring the existing analyze/create shape so the existing wizard UI is reused. Reuses the existing `EXTRACTABLE_ENTITIES` allowlist, `LIMITS`, coercion, and `unmapped`/`skipped` reporting.
**Frontend:** reuse `DocumentImportWizard`'s review UI with a diff-oriented variant (added / changed / unchanged / orphaned).
**Dependencies:** none new.
**Risks:** (a) **destructive sync** — mitigated by Decision C (absence never deletes) and by mandatory review; (b) partially applied sync — mitigated by a single transaction in `apply.ts`; (c) the create-only invariant being weakened — keep the import route's strict schema and add a test that `projectId` is still rejected there. Medium.
**Tests:** full round-trip (DB → file → DB with zero diffs); a removed section becomes `orphaned`, never a delete; a changed field updates and logs origin; unchanged content is a no-op; the transaction rolls back entirely on one bad value; the create route still refuses `projectId`.

---

### Phase 9 — Filesystem watcher and debounce

**Purpose:** detect external edits to managed folders.
**Depends on:** Phase 5 (folders exist), Phase 7 (identity).

**Files:** new `backend/src/lib/watcher.ts`, `backend/src/server.ts` (start/stop lifecycle), `backend/package.json` (**add `chokidar` as a direct dependency** — it is currently only transitive), `backend/src/app.ts` (watcher status in the health route).
**DB:** none (it feeds Phase 10).
**API:** `GET /api/sync/watcher` (running, watched project count, last event, recent errors).
**Frontend:** live sync indicator; debounce control.
**Dependencies:** `chokidar` (promoted from transitive to direct, and pinned).
**Risks:** (a) event storms on save — mitigate with per-project debounce plus a hash check so unchanged content is a no-op; (b) watching too much — only watch registered project folders, never the root recursively; (c) **infinite sync loops** (file change → DB write → file re-render → file change) — mitigate with a `selfWrite` suppression window keyed on the rendered hash. Medium.
**Tests:** debounce collapses a burst; unchanged content produces no DB write; a self-write is suppressed; watcher start/stop is clean; an unwatched folder produces no events.

---

### Phase 10 — Rollback-safe apply, change events and conflict resolution

**Purpose:** make watched changes safe to apply, and visible.
**Depends on:** Phases 8, 9.

**Files:** `backend/src/lib/import/apply.ts`, new `backend/src/lib/markdown/conflicts.ts`, `backend/src/routes/projects.ts` (activity on sync), `backend/src/resources.ts` (new activity types `SYNC_APPLIED`, `SYNC_CONFLICT`, `SYNC_ORPHANED`).
**DB:** `ProjectSyncState.conflictCount`; conflicts recorded in `activity_events.metadata`.
**API:** `GET /projects/:id/sync/conflicts`, `POST /projects/:id/sync/conflicts/:id/resolve` (`keep-file` / `keep-db`).
**Frontend:** conflict resolution UI.
**Dependencies:** none new.
**Risks:** conflicts are confusing without clear provenance — Decision F's origin records are the prerequisite. Medium.
**Tests:** both conflict resolutions produce the documented result and log an event; a conflict never silently overwrites.

---

### Phase 11 — Status control file and explicit project state

**Purpose:** give each project a small, explicit state file complementing `PROJECT.md`, written by P-Hub and readable by humans and tools.
**Depends on:** Phase 6.

**Files:** new `backend/src/lib/status/file.ts` (render/parse), `backend/src/lib/projectStats.ts` (stage-position fix), `backend/src/routes/projects.ts` (stage validation), `frontend/src/lib/status.ts`.
**DB:** `Project.statusNote` (nullable string, the human reason for the current stage).
**API:** `GET /projects/:id/status` (stage, note, evidence, allowed transitions), `POST /projects/:id/status/transition` (validates the state machine).
**Frontend:** stage selector becomes transition-aware — it shows only legal next stages and requires a note for a backward or terminal transition.
**Dependencies:** none new.
**Risks:** an over-rigid state machine frustrating real use — keep it permissive with warnings, not blocks, except for `BUILDING` (Decision I). Medium-low.
**Tests:** illegal transitions rejected; legal ones log `STAGE_CHANGED` with a reason; a backward transition requires a note; `PAUSED`/`ARCHIVED`/`ABANDONED` are reachable from anywhere.

---

### Phase 12 — Evidence-based stage automation

**Purpose:** make `BUILDING` mean something, per the explicit requirement.
**Depends on:** Phases 5, 11.

**Files:** new `backend/src/lib/status/evidence.ts` (evaluator), new `backend/src/lib/status/automation.ts`, `backend/src/routes/projects.ts` (auto-transition writes a full `STAGE_CHANGED` event carrying the evidence), `frontend/src/pages/ProjectSettings.tsx` (evidence panel).
**DB:** `Project.stageEvidence` (JSON: the signals that justified the current stage, with timestamps).
**API:** `GET /projects/:id/status/evidence`, `POST /projects/:id/status/re-evaluate`.
**Frontend:** evidence panel showing exactly why a stage was applied, with the ability to override.
**Dependencies:** Phase 5's folder state; Phase 11's state machine.
**Risks:** (a) **false positives — the whole point of the requirement** — a folder alone is explicitly *not* evidence; qualifying signals are a completed development session, an in-progress task, or a non-empty source directory; (b) surprising automatic changes — mitigate with a preview/dry-run endpoint and an opt-in per-project toggle; (c) automation and manual edits diverging in the audit trail — both must write identical `STAGE_CHANGED` events. Medium.
**Tests:** a newly created project with a folder is **not** `BUILDING`; a completed development session *is*; the transition is reversible and logged; dry-run changes nothing; automation never bypasses the state machine.

---

### Phase 13 — VS Code / IDE integration

**Purpose:** open a managed project in the user's editor, safely.
**Depends on:** Phase 5.

**Files:** new `backend/src/lib/ide.ts`, `backend/src/routes/ide.ts`, `backend/src/app.ts` (mount), `frontend/src/pages/ProjectSettings.tsx`.
**DB:** `Project.editorPreference` (nullable; per-project, not global).
**API:** `GET /api/ide` (detected editors), `POST /projects/:id/ide/open` (executes). **Never accepts a command from the client.**
**Frontend:** "Open in editor" button with a detected-editor picker.
**Dependencies:** `child_process` (built-in) — **first process execution in the codebase**.
**Risks:** (a) **command injection** — mitigate with a hard-coded allowlist of editor commands and `spawn(cmd, [path], { shell: false })`; never interpolate; (b) `code` may not be on `PATH` — detect and report clearly; (c) opening a path that was not validated through `resolveInRoot` — reuse Phase 5's guard. Medium.
**Tests:** the allowlist rejects anything not on it; a path outside the root is refused; a missing binary produces a clear error; no shell is ever spawned.

---

### Phase 14 — Typed project links

**Purpose:** multiple links per project (Decision J).
**Depends on:** Phase 3 (a schema migration needs a safe test path).

**Files:** new `backend/src/resources.ts` entry for `links`, `frontend/src/resources.ts` matching entry, new `frontend/src/components/ProjectLinks.tsx`, `backend/src/routes/projects.ts` (backfill), `frontend/src/pages/ProjectSettings.tsx`.
**DB:** new migration — `ProjectLink` table; backfill `repositoryUrl` into it; keep `repositoryUrl` as a derived read only.
**API:** `/api/projects/:id/links` via the generic router (so it gets validation, activity, and tags for free); `repositoryUrl` write path deprecated.
**Frontend:** links section in Settings; a `REPOSITORY` link renders where the old repo button was.
**Dependencies:** none new.
**Risks:** two sources of truth during transition — mitigate by making `repositoryUrl` a computed field from the primary `REPOSITORY` link, with the column kept only for the backfill window and dropped in a later migration. Low.
**Tests:** backfill is idempotent; adding a link logs an event; the unique constraint is enforced; `repositoryUrl` reads as the primary repository link.

---

### Phase 15 — AI conversation, context engine and controlled actions

**Purpose:** real conversation and agent support, with the safety model in §13.5 and Decisions G, H.
**Depends on:** Phases 3, 6, 7. **This is the highest-risk phase and should be last.**

**Files:** new `backend/src/lib/ai/` (`provider.ts`, `context.ts`, `redact.ts`, `budget.ts`, `transport.ts`, `actions.ts`, `approvals.ts`), new `backend/src/routes/conversations.ts`, extend `backend/src/lib/generator/collect.ts` (reuse context collection), new `frontend/src/pages/Conversation.tsx`, new `frontend/src/components/ApprovalPrompt.tsx`, `frontend/src/lib/useStream.ts` (SSE), `backend/.env.example` (`AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY`).
**DB:** new migration — `Conversation { id, projectId, title, model, createdAt, updatedAt }`, `Message { id, conversationId, sequence, role, content, model, inputTokens, outputTokens, truncated, createdAt }`, `AgentAction { id, projectId, kind, args, rationale, risk, status, result, createdAt, executedAt }`. **Reuse `PromptVersion` discipline for messages; do not overload it.**
**API:** `GET/POST /projects/:id/conversations`, `GET/POST /projects/:id/conversations/:id/messages` (SSE stream), `GET/POST /projects/:id/actions`, `POST /actions/:id/approve|reject|execute`.
**Frontend:** conversation view with streaming, a visible redaction notice ("3 secrets removed from context"), and an approval prompt for any proposed action.
**Dependencies:** a provider SDK or plain `fetch`; `eventsource` or `fetch` streaming (no new frontend library needed).
**Risks (all high, all mitigated by design):** (a) **secret exfiltration** — redaction before send, key from env only, never stored in DB, never returned by any endpoint, always displayed as a count; (b) **prompt injection from imported documents** — provenance-tagged context with untrusted fragments explicitly marked and excluded from instruction-bearing positions; (c) **unauthorised destructive action** — the model proposes, the user approves, every action is logged, process execution stays allowlisted per Phase 13; (d) **cost runaway** — hard token budget, explicit per-conversation caps, visible usage; (e) **no auth** means any local process can spend the key — surfaced as a prerequisite warning, and localhost-only binding enforced.
**Tests:** redaction patterns (AWS keys, JWTs, connection strings, private key blocks); the redacted count is reported; a document containing injected instructions is treated as data; a write action cannot execute without approval; a rejected action is logged and never runs; a filesystem or process action goes through the Phase 5 path guard; budget truncation is deterministic.

---

### Phase 16 — Unified timeline, test isolation hardening and release readiness

**Purpose:** consolidate and close out.
**Depends on:** all previous phases.

**Files:** `backend/src/lib/activity.ts`, `backend/src/resources.ts` (new activity types), `frontend/src/pages/Activity.tsx`, `frontend/src/pages/ProjectTimeline.tsx`, `backend/src/app.ts` (health/meta reporting folder + sync + watcher + AI status), `backend/tests/` (all suites), new `frontend/vitest.config.ts` + `frontend/src/**/*.test.tsx`.
**DB:** none (unless new activity types need columns).
**API:** `GET /projects/:key/timeline` extended to merge DB activity, sync events, and file changes with a unified `source` discriminator; `GET /api/health` extended with per-subsystem status.
**Frontend:** filterable unified timeline; first frontend tests (wizard, resource config, sync review).
**Dependencies:** whatever earlier phases added.
**Risks:** timeline noise — mitigate with a source filter and sensible defaults. Low.
**Tests:** the full suite green against the isolated test schema; frontend tests for the import wizard and resource config; a smoke test that boots the app, creates a project, creates a folder, renders `PROJECT.md`, syncs, and re-syncs with zero drift.

---

### Phase dependency summary

```
1 ── 2 (API fixes) ──────────────────────────────┐
                                                 ├── 14 (links)
└── 3 (test isolation) ── 4 (projects root) ── 5 (folders) ── 6 (PROJECT.md)
                              │                    │   │          │
                              │                    │   │          ├── 7 (identity) ── 8 (sync engine) ── 9 (watcher) ── 10 (conflicts)
                              │                    │   │          │
                              │                    │   ├── 11 (status file) ── 12 (evidence automation)
                              │                    │   │
                              │                    │   └── 13 (VS Code)
                              │                    │
                              └────────────────────┴── 15 (AI conversation + actions)
                                                                           │
                                                             16 (unified timeline + hardening) ◄── all
```

---

## Audit Attestation

**Files modified during this audit: NONE.**
The only file created is this report, `report.md`, at the repository root. `git status --short` was empty before the audit and this document is the sole difference. No temporary diagnostic artefacts remain inside the repository. A read-only inspection script was created outside the repository, under `%LOCALAPPDATA%\Temp\opencode\`, and is not part of the project.

**Database changes: NONE.** No insert, update, or delete was executed against the live database. No migration, seed, reset, or `prisma db push` was run. Migration status was read with `npx prisma migrate status`; the schema was confirmed with `npx prisma db pull --print`, which writes only to stdout. All row counts and column metadata came from `SELECT`-only queries against `information_schema`.

**Tests run: NONE — deliberately.** `backend/tests/*` connect to the live `projecthub` database (`backend/.env` is loaded and `DATABASE_URL` is never overridden), create real projects, and remove them with the hard-delete endpoint. Executing them would have modified existing project data, violating the audit constraints. The 82 test *declarations* were counted by static source inspection, not by running them. Suite health is therefore **unverified**, and §16.2 documents the isolation work required before it can be checked safely.

**Builds run: NONE.** `npm run build` invokes `prisma generate`, which writes into `node_modules`; `npm start` was likewise not run. The runtime environment-loading question in §14.3 is therefore flagged as unconfirmed rather than asserted.

**Commands executed during the audit:**

| Command | Purpose | Mutation |
| --- | --- | --- |
| `git status --short` | Baseline and final cleanliness | None |
| `git log --oneline -10` | Commit history | None |
| `git ls-files backend/.env backend/.env.example` | Secret tracking check | None |
| `npx prisma migrate status` | Migration state | None |
| `npx prisma db pull --print` | Live schema confirmation (stdout only) | None |
| `node %LOCALAPPDATA%\Temp\opencode\phub-audit.mjs` | Read-only counts, stage distribution, `information_schema` column inspection | None |
| File reads and content searches | Source audit | None |

**No destructive command of any kind was executed:** no `db:reset`, no `db:push`, no `FORCE=1` seed, no `prisma migrate reset`, no file deletion, and no test run.

**Audit integrity:** every claim in this report is traceable to a specific file and line, or to a read-only database query. Where something could not be confirmed without modifying state — the origin of project `id` 330, the runtime `.env` loading mechanism, current test-suite health — it is stated as unconfirmed rather than inferred. The two §1 defects and the §6.3 generic-router findings are reproducible by reading the cited lines.

**Recommendation:** complete Phase 3 (test isolation) before Phase 2, so the API fixes and everything after them can be verified safely. Then proceed 2 → 4 → 5 → 6 → 7 → 8, which deliver folder management and `PROJECT.md` synchronisation — the highest-value work — reusing the existing importer rather than replacing it.

---

# PART II - PHASE 2: CONFIGURABLE PROJECTS ROOT (IMPLEMENTED)

The audit in Part I is the historical record of what was found. This part records
what Phase 2 actually built, what was verified, and what was deliberately left
out. Current source, not the audit, is authoritative.

## P2.1 Objective and scope

Phase 2 delivered exactly one thing: a safe, application-wide **Projects Root**
setting - the parent directory under which project workspaces will live.

Explicitly out of scope and not implemented: project-folder linking (Phase 3),
`PROJECT.md`, `STATUS.md`, document synchronisation, filesystem watching,
automatic lifecycle detection, GitHub or deployment detection, AI integration,
and VS Code integration.

## P2.2 Architecture decision: database, not environment

The audit found no settings model, service, API, or page. Two options existed:
an environment variable, or a database row. A database row was chosen because
the audit's own A14.3/A14.4 findings showed environment loading at runtime is
**unconfirmed** in this codebase, and because the user needs to be able to change
the root from the UI without editing a file and restarting. A `PROJECTS_ROOT`
environment variable would have inherited exactly the uncertainty the audit
flagged.

The setting has **no fallback**. It does not default to the working directory,
the application folder, the home directory, or the repository. Until a user
configures it, Project Hub reports that no Projects Root exists. Guessing a root
would risk writing project folders somewhere the user never chose.

## P2.3 Database changes

One new table, one additive migration, no other schema change:

```sql
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);
```

`key` is the primary key, so saving is an upsert and a second Projects Root row
is structurally impossible. The model has no `projectId` and no relations, so it
is not project data, is not cascaded, and is not reachable from any project
export. `prisma migrate status` reports 4 migrations and "Database schema is up
to date!". The table was left **empty** - no value was pre-set for the user.

## P2.4 The safety principle: checking never changes, changing is never implicit

This is the design rule the whole phase is built around.

| Operation | Reads disk | Writes disk | Creates folders | Tests writability |
| --- | --- | --- | --- | --- |
| `GET` | yes | no | never | no |
| `PUT` (save) | yes | no | never | no |
| `POST /test` | yes | **yes** (one probe file) | never | **yes** |
| `POST /initialize` | yes | yes | **yes** | no |
| `DELETE` | no | no | never | no |

The only `mkdir` call in the entire feature sits behind the explicit "Create
folder" button. The only write anywhere is a uniquely named probe file created
with the `wx` flag, which removes **only that file**. A test asserts the folder
is empty afterwards. Viewing the Settings page performs no writes at all.

`DELETE` forgets the value and never deletes the folder. A user clearing the
setting must never lose data, and the UI says so in the confirmation dialog.

## P2.5 API surface

All under `/api/settings`, using the existing `{ data }` / `{ error }`
conventions and the existing `VALIDATION_FAILED` error category:

| Method | Path | Effect |
| --- | --- | --- |
| GET | `/api/settings/projects-root` | Stored value plus a read-only check |
| PUT | `/api/settings/projects-root` | Validate and save; creates nothing |
| POST | `/api/settings/projects-root/test` | Full check including a real write probe |
| POST | `/api/settings/projects-root/initialize` | Create the folder; the only `mkdir` |
| DELETE | `/api/settings/projects-root` | Forget the value; never touches disk |
| GET | `/api/settings` | Lists recognised keys |

Every failure carries a machine-readable `details.code` and a
`possibleAction` written for a human. Bodies are validated with `.strict()`, so
unknown fields are rejected rather than silently ignored. Rejection codes:
`PATH_EMPTY`, `PATH_TOO_LONG`, `PATH_INVALID`, `PATH_RELATIVE`,
`PATH_RESERVED_NAME`, `PATH_TRAILING_DOT_OR_SPACE`, `PATH_NOT_FOUND`,
`PATH_NOT_DIRECTORY`, `PATH_NOT_READABLE`, `PATH_NOT_WRITABLE`.

## P2.6 A real bug the tests caught

A missing `path` key returned Zod's flattened validation error instead of the
`PATH_EMPTY` code, meaning two different error shapes existed for the same user
mistake. The body schema now passes absent values through to the same
normalizer, so a missing key and an empty string produce an identical response.

Two further defects were introduced and then caught during the Windows
character-validation work: the illegal-character regex matched the drive
letter's own colon, and the per-component scan ran before the absolute-path
check, which misreported `..\Projects` as a trailing-dot problem. Both are now
covered by regression tests, and the character checks are deliberately placed
after the absolute-path check.

## P2.7 Symlinks and paths are handled lexically

Paths are stored lexically and **symlinks and junctions are never resolved**.
A stored path cannot silently redirect operations elsewhere. `isSymbolicLink` is
surfaced in the UI and the path is stored exactly as typed. A link is never
followed to decide whether a folder "really" is something else.

Accepted paths are normalized so that `D:\a`, `D:\a\`, `D:\a\.\` and `"D:\a"`
all store as one form. Path *shape* problems are rejected up front while
*existence and permissions* are reported as findings, which is what allows a
not-yet-existing folder to be saved and then created later.

## P2.8 Frontend

A new application-level Settings page at `/settings`, linked from the sidebar.
It is deliberately separate from the existing project-scoped `ProjectSettings`
page, because a Projects Root belongs to the application, not to any project.

There is **no "Choose folder" button**. Project Hub is a browser app served over
HTTP, and a page cannot ask the operating system for a real folder path.
`<input type="file" webkitdirectory>` returns a list of files the user selected,
not a path Project Hub could manage, and the File System Access API is not
available in every browser. A button that cannot do what it claims would be
worse than an honest text field, so the path is typed and verified on the
backend, which is the only place that can actually check it. The UI states this
reasoning in a comment rather than leaving the absence unexplained.

The connection check renders each result as a tick or a cross, and reports
`Writable` as "Not tested yet" rather than guessing, because only an explicit
test can know it.

## P2.9 Verification performed

| Check | Result |
| --- | --- |
| `npx vitest run tests/projectsRoot.test.ts` | **38/38 passed** (0.86s) |
| `npx tsc -p tsconfig.json --noEmit` (backend) | clean |
| `npx tsc -b --noEmit` + `npm run build` (frontend) | clean, built in 2.19s |
| Live HTTP smoke test through `createApp()` | all endpoints as tabulated |
| `npx prisma migrate status` | 4 migrations, schema up to date |
| Field-by-field comparison against `backend/baseline-before.json` | **zero differences** |

The 38 tests cover the unconfigured state; save, read-back, update and
single-row enforcement; normalisation equivalence across five spellings of one
path; rejection of empty, whitespace, missing, relative, nested-relative,
drive-relative, control-character, overlong, reserved-name, illegal-character and
trailing-dot/space paths; unknown-field rejection; saving a not-yet-existing
folder; refusing a file; testing a good folder, a file and a missing folder;
proving no probe file is left behind; explicit creation, idempotency, and refusal
to create over a file; proving that saving alone creates nothing; proving a file
inside a folder survives initialization; and a whole-suite fingerprint comparison
asserting no project or child record changed.

All filesystem tests use throwaway directories created with `fs.mkdtemp` under
the OS temp folder. The user's real Projects Root was never touched.

## P2.10 Database safety

A verification script compared the live database against the Phase 1 snapshot
field by field, then was deleted. All 6 baseline projects are byte-identical,
including `createdAt` and `updatedAt` and all 23 per-project child counts. The
`app_settings` table is empty and no `phub-projectsroot-*` temp directory was
left behind.

The database holds 8 projects rather than 6. The two extras, `329 Project Hub`
and `330 MMC - Multiplayer Card Pick Betting Game`, were created by the user 71
minutes and roughly 2 days after the baseline snapshot, long before this work.
They are untouched; they are the only reason global child totals differ, which
is why the strict comparison is per-project.

The only database write was the additive `CREATE TABLE`. No existing table, row
or relationship was altered.

## P2.11 Test-suite safety finding carried forward

`backend/tests/setup.ts` loads the real `.env` and `backend/tests/helpers.ts`
creates and hard-deletes projects, so the existing suite runs against the live
`projecthub` database. It was deliberately **not** run during Phase 2; only the
new file was executed. Test isolation remains open work, and every subsequent
phase should either introduce a disposable test database or keep using
targeted, self-cleaning files like this one.

## P2.12 Known limitations carried into Phase 3

- No native folder picker, for the browser reasons above; the path is typed.
- Symlinks are not resolved; a linked path is honoured as typed.
- The length limit is 4096 characters; classic Windows `MAX_PATH` is not handled.
- Writability is unknown until explicitly tested.
- The API is unauthenticated, consistent with the existing single-user local
  application, and is not safe to expose on a network.
- A genuine `EACCES` denial cannot be produced deterministically on Windows, so
  the permission-denied branch is covered by asserting the real code fires for a
  folder this user genuinely cannot read.

## P2.13 Open decision for the user

The suggested Projects Root `C:\Users\ILGRIS\Desktop\projects` currently
contains the Project Hub repository itself. If it is set as the Projects Root,
Phase 3 would treat `p-hub` as a managed project folder. A dedicated folder such
as `C:\Users\ILGRIS\Desktop\projects\workspaces` avoids that. Nothing is
configured yet, so this can still be decided before Phase 3 creates anything.

---

# PART III - PHASE 3: PROJECT WORKSPACE FOLDERS (IMPLEMENTED)

Part I is the audit. Part II recorded Phase 2 (the Projects Root setting). This
part records Phase 3: creating a project now also creates its physical workspace
folder, and the two are kept consistent. Current source, not this document, is
authoritative.

**A note on numbering.** Part I §18 proposed a 16-phase plan in which "Phase 3"
meant *test database isolation* and folders were Phase 5. The plan actually
executed renamed those: Part II delivered the audit's Phase 4 as "Phase 2". This
phase therefore corresponds to the **creation half of the audit's Phase 5**, and
the two pieces of test isolation it assumes are still outstanding - see P3.12 and
P3.14.

## P3.1 Objective and scope

Phase 3 delivered one thing: when Project Hub creates a project, it also creates
that project's workspace folder under the configured Projects Root, and the
database record and the folder are either both there or neither is.

In scope: folder creation at project creation, folder-name derivation,
containment checking, collision refusal, rollback, a preview endpoint, a
workspace status endpoint, and the UI that makes both visible before and after
creation.

Explicitly **not** in scope and not implemented: `PROJECT.md` rendering,
`STATUS.md`, any two-way synchronisation, filesystem watching, adopting a
folder that already exists, moving or renaming a folder when a project is
renamed, opening a folder in Explorer or an editor, and any lifecycle or stage
automation.

## P3.2 Database changes

One additive migration, `20260929220000_project_workspace`, and nothing else:

```sql
ALTER TABLE "projects"
  ADD COLUMN "folderName" TEXT,
  ADD COLUMN "folderPath" TEXT;

CREATE INDEX "projects_folderPath_idx" ON "projects"("folderPath");
```

Both columns are nullable and **nothing is backfilled**. The eight existing
projects keep `folder_path = NULL`, which the application already reads as "this
project has no workspace". Verified after the fact: `projects with folderPath = 0`.
A later phase can attach existing folders if the user asks for it; this phase
never invents a folder for a project it did not create.

`npx prisma migrate status` reports 5 migrations and "Database schema is up to
date!". No existing table, row, constraint or relationship was altered.

## P3.3 The ordering decision, which is the whole design

```
validate name -> load Projects Root -> derive a safe folder name ->
containment check -> collision check -> mkdir -> INSERT project row
```

The folder is created **before** the record, not after. The reasoning: the two
cannot share a transaction, so one of them will eventually fail alone. If the
record is written first and the folder then fails, the database holds a project
that claims a workspace which does not exist - and the user has no way to tell
that from a healthy project. If the folder is created first and the record then
fails, the visible state is an empty folder the user can see and delete, which is
the recoverable direction.

The rollback is deliberately narrow
(`backend/src/lib/projectCreation.ts:182-204`):

- It only ever removes a folder **this call created**. `createdByUs` is a local
  variable set by the `mkdir` itself (`projectWorkspace.ts:246-264`), so it can
  never be true for a folder that already existed.
- It uses `rmdir`, never a recursive delete. If anything at all is inside the
  folder - a file the user dropped in, a git repository someone initialised - the
  removal fails and is **reported**, not forced.
- If the removal fails, the user gets a `500` whose message names the surviving
  path, the reason cleanup was refused, and the original database error, with
  `details.code = 'PARTIAL_STATE_FOLDER_LEFT'`. A folder the user can see but
  that no project points at is a real state, and it is stated rather than hidden.
- A lost race (folder created by something else between the check and the
  `mkdir`) is re-inspected and reported as the same collision, so a folder this
  call did not create is never adopted.

## P3.4 Folder names are derived from the display name, never from the slug

Part I §8.3(c) warned specifically against deriving folder names from slugs
(80 characters, `[a-z0-9-]` only, `-2` suffixes, two different length limits in
two creation paths). The slug is not used here at all.
`toSafeFolderName()` (`projectWorkspace.ts:73-122`) works from the project name:

| Input | Folder name | Note |
| --- | --- | --- |
| `NODIA` | `NODIA` | unchanged |
| `My Trading Bot V2` | `My Trading Bot V2` | spaces are legal and kept |
| `My Trading Bot: V2` | `My Trading Bot- V2` | `:` replaced |
| `a<b>c\|d?e*f"g` | `a-b-c-d-e-f-g` | each illegal character replaced |
| `NUL.txt` | `NUL-project.txt` | suffix goes **before** the extension |
| `trailing dots...` | `trailing dots` | Windows strips these silently |
| `C:\Windows\System32` | `C-Windows-System32` | separators cannot survive |
| `///` | *rejected, 400* | nothing usable remains |

Two deliberate properties:

- **The display name is never rewritten.** `projects.name` stays exactly what
  the user typed. Only the folder is made safe, and when the two differ the API
  returns `renamed: true` so the UI can say so rather than surprise the user with
  a directory on disk.
- **No invented alternatives.** A name that collides is refused with a 409. There
  is no `NODIA2`, no timestamp suffix, no numeric fallback. Part I §11.3 called
  out silent renaming as the failure mode to avoid, and it is avoided.

Windows device names are matched on the stem before the first dot,
case-insensitively, because `NUL.txt` is still a device to Windows. The `-project`
suffix is inserted before the extension for exactly that reason; appending it
would leave `NUL.txt-project`, whose stem is still `nul`.

`MAX_FOLDER_NAME` is 100 characters, bounded well inside the 260-character
classic Windows path budget, and truncation prefers a word boundary.

## P3.5 Containment is checked on path segments, not on string prefixes

`isInsideRoot()` (`projectWorkspace.ts:132-149`) resolves both sides, splits them
into segments, requires the target to be strictly deeper than the root, and
compares segment by segment - case-insensitively on Windows, because
`D:\projects` and `D:\Projects` are the same directory. A string prefix check
would accept `D:\ProjectsOther` as being inside `D:\Projects`; the tests assert
it does not. The root itself is not "inside" the root.

This runs on every creation, and the tests then assert the stronger property: for
each of nine hostile names including `..`, `../../../../Windows`,
`C:\Windows\System32`, `\\server\share\evil` and `/etc/passwd`, the parent
directory of whatever path is produced is exactly the resolved Projects Root, and
nothing appeared in the OS temp folder next to it.

## P3.6 Pre-existing folders are never claimed and never deleted

`inspectTarget()` (`projectWorkspace.ts:191-227`) looks before touching anything
and returns one of four collision kinds, each with its own explanation and
suggested action:

| Kind | Meaning |
| --- | --- |
| `exists` | a directory is already there - refused, not adopted, not emptied |
| `file` | a file occupies the path - refused |
| `symlink` | a link (including a junction) occupies the path - refused, never followed |
| `unreadable` | the path could not be checked at all - refused with a permissions message |

Refusal is a `409` with `category: 'CONFLICT'` and
`details.code: 'WORKSPACE_ALREADY_EXISTS'`. A test creates a folder containing
`precious.txt`, attempts to create a project of the same name, and then asserts
the file's contents, the folder's listing, and the absence of any project row.
The same test proves no `NODIA2`-style alternative appears beside it.

This is a deliberate narrowing of the audit's Phase 5, which proposed an explicit
*adopt* endpoint for an existing empty folder. Adoption is genuinely useful, but
it is a separate user decision - "this folder is mine, use it" - and shipping it
in the same phase as automatic creation would have made the dangerous path the
easy one. It remains open (P3.16).

## P3.7 No Projects Root means no project

`requireUsableProjectsRoot()` (`projectCreation.ts:55-89`) refuses creation when
the setting is missing, when the folder no longer exists, when it is a file, or
when it cannot be read. There is **no fallback** - not the working directory, not
the repository, not the home directory. Writing project folders somewhere the user
did not choose is worse than refusing to create the project, so the API returns
`409` with `PROJECTS_ROOT_NOT_CONFIGURED` or `PROJECTS_ROOT_UNUSABLE` and a
`possibleAction` that names Settings.

The trade-off is real and worth stating: **project creation now depends on
filesystem state.** A user who has not configured a Projects Root cannot create
projects at all, including through a path that previously worked. This is a
deliberate consequence of the ordering in P3.3, not an oversight, and it is the
single most likely thing to surprise a returning user.

## P3.8 A folder is not development activity

The create route now hard-codes `stage: 'IDEA'` (`projects.ts:181`) and the
creation form no longer offers a stage selector (`PROJECT_CREATE_CONFIG` in
`frontend/src/projectConfig.ts`). Part I §10.5 recorded the requirement that
`BUILDING` must be gated on evidence and that "a project-folder creation event
must never be sufficient on its own". Creating a folder is not evidence of
anything, so it cannot move a project. A test asserts `stage === 'IDEA'` on
creation.

A gap remains: the field is still **accepted and silently discarded**. See
P3.16.

## P3.9 API surface

| Method | Path | Effect |
| --- | --- | --- |
| POST | `/api/projects` | unchanged shape; now also creates the folder and stores `folderName`/`folderPath` |
| POST | `/api/projects/preview-workspace` | resolves a name to the folder it *would* use; creates nothing |
| GET | `/api/projects/:key/workspace` | reports whether the folder is still on disk |

`preview-workspace` runs the identical validation, derivation and collision check
as real creation, so what the UI promises is what happens. A test asserts the
previewed path equals the created path, and that a preview of a colliding name
returns the same 409 the create would.

`GET /:key/workspace` returns `{ hasWorkspace, folderPath, folderName, exists,
isDirectory, readable, problems, checkedAt }`, or `hasWorkspace: false` for a
project that never had one. The advice attached to a `PATH_NOT_FOUND` finding is
rewritten for this context: the Settings page owns the "Create folder" button for
the Projects Root, and pointing a project user at a control that does not exist
would be a dead end, so the message instead says the folder was deleted outside
Project Hub and that nothing in the project record was lost.

Two new error categories were added in `backend/src/lib/errors.ts`: `CONFLICT`
(an existing folder is a decision the user must make) and `FILESYSTEM_ERROR` (a
refusal by the operating system is neither a bad request nor a plain system
fault). Every new failure carries a machine-readable `details.code` and a
`possibleAction` written for a human.

## P3.10 Frontend

- **Before committing**, the create modal shows the exact absolute path the
  folder will be created at, under which Projects Root, and states that the
  folder is created empty - no `PROJECT.md`, no `STATUS.md`. If the folder name
  had to differ from the project name, it says which name was changed and why the
  project keeps yours. A collision or a bad name is shown as an error that blocks
  creation. The preview is debounced by 300 ms and driven by a new optional
  `onValuesChange` prop on `ResourceForm`, so the server stays the only authority
  on what the folder will be called.
- **After creating**, the user is taken straight to the new project instead of
  back to a list, and the toast names the workspace that was created.
- **The project page** gained a Workspace card on the overview showing the path
  and three checks - exists, is a folder, readable - with the underlying
  problems listed if any. A project with no folder says so and explains why
  (predates the feature, or came from the importer).

There is deliberately **no "Open folder" button**, in the same way Phase 2 had no
folder picker. A page served over HTTP has no standard way to open a local
directory in the operating system's file manager: the File System Access API is
permission-gated and not universally available, and `<input webkitdirectory>`
returns a list of files rather than a path Project Hub can manage. Shipping a
button that silently does nothing would be worse than showing the path and
letting the user copy it. The reasoning is recorded in the component rather than
left as an unexplained absence. Editor integration remains a later phase.

## P3.11 Verification performed

| Check | Result |
| --- | --- |
| `npx vitest run tests/projectWorkspace.test.ts` | **44/44 passed** (977 ms) |
| `npx vitest run` (whole suite) | **164/164 passed**, 5 files, 16.52s |
| `npx tsc -p tsconfig.json --noEmit` (backend) | clean |
| `npx tsc -b && vite build` (frontend) | clean, built in 3.23s |
| `npx prisma migrate status` | 5 migrations, schema up to date |
| Live database fingerprint, before and after the full suite | **byte-identical** |
| `projects with folderPath` | 0 - no backfill happened |
| `app_settings` rows after the run | 0 - the Projects Root is still unconfigured |
| Temp directories left behind | none |

The 44 new tests cover: record and folder created together and linked; the
folder starting empty; verbatim names with spaces; two projects staying
independent; optional fields surviving; a missing Projects Root and a deleted
Projects Root both refused with nothing written; empty and unusable names
refused; nine hostile names never escaping the root; segment-level containment
including the prefix-sibling and case-folding cases; a pre-existing folder, an
empty pre-existing folder, a file in the way and a symlink in the way all
refused with the original contents intact; no invented alternative name; clean
rollback on database failure; never removing a folder the call did not create;
the partial-state report when cleanup is blocked; pre-existing projects
byte-identical and never backfilled; reserved device names, illegal characters,
trailing dots, over-long names and names with nothing usable; display name
preserved while the folder is transformed; the three preview cases; the four
status cases; and preview/create parity.

**A correction to Part I.** §1, §16 and §18 state "82 test declarations". The
real pre-existing count is **120** (19 `api` + 27 `promptGenerator` + 36
`import` + 38 `projectsRoot`). With this phase's 44 the suite is 164. The Part I
figure undercounted and should not be relied on.

## P3.12 A regression this phase introduced, and the fix

Requiring a usable Projects Root broke the existing test suite, and the phase
shipped without noticing.

`tests/helpers.ts:16` `createProject()` posts to `POST /api/projects`, which now
returns `409 PROJECTS_ROOT_NOT_CONFIGURED`, and the helper throws. `api.test.ts`
and `promptGenerator.test.ts` both create their fixture project in `beforeAll`,
so **46 of the 120 pre-existing tests could not run at all**:

```
FAIL tests/api.test.ts  19 tests | 19 skipped
Error: Failed to create test project (409) ... PROJECTS_ROOT_NOT_CONFIGURED
```

Nothing in `tests/setup.ts` configured a Projects Root, so the fix belongs there.
`tests/setup.ts` now creates one `fs.mkdtemp` directory per test file under the
OS temp folder, stores it as the Projects Root for the duration of the file, and
in `afterAll` **restores whatever value was configured before** - including
deleting the row when there was none - before removing the directory. The
setting is saved and restored rather than assumed empty so that running the suite
against a configured installation cannot silently discard the user's Projects
Root. `projectWorkspace.test.ts` and `projectsRoot.test.ts`, which manage their
own roots, are unaffected: they override the setting in their own hooks and clear
it again, and their own `afterAll` assertions still hold because the setup's
`afterAll` runs last.

With that change the full suite is green, and the before/after database
fingerprint is identical: same 8 projects, same 22 child-table counts, same 202
activity events, same 25 tag assignments, identical `createdAt`/`updatedAt` on
every project row.

## P3.13 Database and filesystem safety

- The only schema change is two nullable columns and one index. No rewrite, no
  backfill, no constraint change, no touch to any existing row.
- No filesystem test ever used the user's real Projects Root. Every directory
  came from `fs.mkdtemp` under the OS temp folder, and every one was removed.
- Pre-existing projects are asserted unchanged by fingerprint inside the suite
  itself, so the claim is a test rather than a promise.
- The only writes in the whole phase are: one `mkdir` for a new project, and
  `rmdir` for a rollback of a folder this call created and that is still empty.

## P3.14 Test isolation is still open

Fixing the helper made the suite run again. It did **not** make it safe.
`backend/tests/*` still load the real `backend/.env`, still point at the live
`projecthub` database, and `import.test.ts` in particular creates and hard-deletes
real project rows through the importer. The full-suite run above wrote to the
live database and cleaned up after itself; the fingerprint proves the cleanup was
complete, not that the writes were harmless.

This is Part I §18's original "Phase 3" and Part II's P2.11, still outstanding. It
now has a concrete blocker worth naming: any solution has to give the tests a
Projects Root that is both real enough for `mkdir` to work and disposable enough
to be thrown away, and a test schema in the same database satisfies both. Until
it is done, the safe way to work is what was done here - run the suite, then prove
with a fingerprint that nothing moved.

## P3.15 Known gaps and limitations

1. **`stage` is silently discarded on create.** `projectCreateSchema` still
   accepts `stage` (`projects.ts:52`, default `'IDEA'`) and the route then
   overwrites it with `'IDEA'` at `projects.ts:181`. A client sending
   `{ "name": "x", "stage": "PRODUCTION" }` receives `201` with `stage: "IDEA"`
   and no indication that its input was dropped. The behaviour is safe; the
   silence is not. It should either be rejected or documented in the response.
2. **Renaming a project does not touch its folder.** `PUT /projects/:id`
   re-slugs the name but leaves `folderName`/`folderPath` alone
   (`projects.ts:306-309`). This is the safe choice - renaming a user's directory
   without being asked is worse - but the Workspace card then shows a path that
   no longer matches the project name with no explanation of why.
3. **No way to give an existing project a folder.** Pre-existing projects and
   imported projects have no adopt flow, no backfill, and no "create the folder
   now" action. The UI states that they have no workspace; it does not offer a
   way out.
4. **Imported projects get no folder.** `POST /api/import/create` goes through
   the importer's own transaction and never touches the workspace code, so a
   project created from a document starts with `folderPath = null`. This is
   visible in the UI and is consistent, but it means the two creation paths in
   the product now behave differently by design.
5. **`MAX_FOLDER_NAME` is 100 characters and path length is not otherwise
   bounded**, so the classic Windows 260-character `MAX_PATH` limit is still not
   handled (carried from P2.12).
6. **Scratch files were left in the repository**: `backend/manual-verify.mjs`
   and `backend/manual-root.txt` are untracked, and an empty
   `%TEMP%\ph-manual-dfd5004a` directory remains. The verification script's step
   7 also reads a `present` field the API does not return (it returns `exists`
   and `isDirectory`), so that step's output was `undefined`. None of this
   affects the application; all of it should be deleted before the next commit.
   Phase 2's equivalent script was deleted after use.
7. **`frontend/tsconfig.tsbuildinfo` is tracked** and shows as modified after
   every build. It is a build artefact in version control and should be ignored.

## P3.16 Open decisions for the user

- **Which Projects Root.** Nothing is configured. The suggested
  `C:\Users\ILGRIS\Desktop\projects` contains the Project Hub repository itself,
  so `p-hub` would become a managed project folder; a dedicated
  `C:\Users\ILGRIS\Desktop\projects\workspaces` avoids that. Project creation is
  refused until this is set.
- **Adopting existing folders.** The Phase 3 refusal is permanent by design.
  Whether a later phase should offer an explicit "use this folder" action, and
  whether it should be limited to empty folders, is a decision for you.
- **Renaming.** Whether a project rename should offer to rename the folder, or
  leave the folder alone and simply explain the mismatch in the UI.
- **What comes next.** `PROJECT.md` generation is the natural follow-on and is
  the first feature that would put content into these folders.
