# Project Hub 2.0

A personal **project lifecycle & AI/vibe-coding management system**. It answers one
question for every project: *what actually happened, from idea to maintenance?* — without
losing any of that history along the way.

Unlike a task manager, Project Hub keeps the full story: the original idea, research,
architecture decisions, requirements, features, tasks, AI prompts (and every version of
them), development sessions, deployments, incidents, documents (and every version), and an
append-only activity timeline.

---

## Core principles

- **Capture ≠ Commitment** — ideas can be captured without becoming work.
- **Reversible lifecycle** — projects move through stages, and stages can change back.
- **History is never erased** — prompts/documents are versioned; projects are archived, not
  silently deleted (hard delete is explicit: `?hard=true`).
- **No fake data** — every counter is computed from real records.
- **Structured modules over note dumps** — typed resources, not one giant notes field.
- **Dense developer-tool UI** — information-dense, keyboard-friendly, not dashboard-fluff.

---

## Tech stack

| Layer     | Technology                                        |
| --------- | ------------------------------------------------- |
| Frontend  | React 18 + TypeScript + Vite 6 + React Router 7   |
| Backend   | Node.js + Express 4 + TypeScript (ESM, tsx)       |
| Database  | PostgreSQL + Prisma ORM 6                          |
| API       | REST (JSON)                                       |
| Tests     | Vitest + Supertest                                |

No authentication in V1 (single-user, local).

---

## Repository layout

```
p-hub/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma        # source of truth (~24 models/enums)
│   │   └── seed.ts              # idempotent seed (6 sample projects)
│   ├── src/
│   │   ├── app.ts               # Express app + route mounting
│   │   ├── resources.ts         # config-driven ResourceDef list (20 resources)
│   │   ├── lib/                 # prisma, errors, validation, tags, activity, stats
│   │   └── routes/              # projects.ts, misc.ts, generic.ts
│   └── tests/                   # Vitest + Supertest API tests
├── frontend/
│   └── src/
│       ├── api/                 # fetch client + shared types
│       ├── components/          # Layout, QuickAdd, ResourceForm, UI primitives
│       ├── context/             # AppContext (tags/toasts), ProjectContext
│       ├── pages/               # Dashboard, Portfolio, workspace tabs, ResourcePage
│       └── resources.ts         # frontend mirror of backend resource config
└── package.json                 # root orchestration scripts
```

---

## Prerequisites

- Node.js 20+ (developed on 24.x)
- PostgreSQL 14+ running locally

---

## Setup

1. **Install dependencies** (installs backend + frontend):

   ```bash
   npm run setup
   ```

2. **Configure the backend environment** — copy `backend/.env.example` to
   `backend/.env` and set `DATABASE_URL`:

   ```env
   DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/projecthub"
   BACKEND_PORT=4000
   CORS_ORIGIN="http://localhost:5173"
   ```

3. **Create the schema and seed data:**

   ```bash
   npm run db:migrate     # prisma migrate dev
   npm run db:seed        # 6 sample projects (FORCE=1 to wipe & reseed)
   ```

4. **Run both apps:**

   ```bash
   npm run dev
   ```

   - Frontend: http://localhost:5173
   - Backend:  http://localhost:4000/api

   The Vite dev server proxies `/api` to the backend, so no CORS setup is needed in dev.

---

## Scripts

Run from the repository root:

| Command                | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `npm run setup`        | Install backend + frontend dependencies              |
| `npm run dev`          | Run backend and frontend concurrently                |
| `npm run dev:backend`  | Run only the backend (`tsx watch`)                   |
| `npm run dev:frontend` | Run only the frontend (`vite`)                       |
| `npm run build`        | Build backend (`dist/`) and frontend (`dist/`)       |
| `npm test`             | Run backend test suite (Vitest)                      |
| `npm run test:watch`   | Vitest in watch mode                                 |
| `npm run db:migrate`   | Create/apply a Prisma migration                      |
| `npm run db:seed`      | Seed the database                                    |
| `npm run db:studio`    | Open Prisma Studio                                   |

---

## Architecture notes

### Config-driven resources

Most of the API and UI is generated from a single resource definition:

- `backend/src/resources.ts` — each `ResourceDef` declares the URL path, Prisma model,
  create/update Zod schemas, searchable fields, taggability, code/number generation,
  activity hooks, and a `describe` function.
- `src/routes/generic.ts` — a generic router provides `list / get / create / update / delete`
  for every resource, plus special routers for prompt versions, document versions, and
  feature↔requirement linking.
- `frontend/src/resources.ts` — the frontend mirror drives the generic `ResourcePage`
  (columns, fields, filters, enum options).

This keeps the 20 project-scoped resources consistent while still allowing per-resource
hooks (e.g. task completion stamps `completedAt`, documents bump `currentVersion`).

### Versioning

- `Prompt` and `ProjectDocument` have **no** top-level content column; content lives in
  `PromptVersion` / `ProjectDocumentVersion`. Creating or updating content appends a new
  immutable version.
- Projects keep an immutable `originalIdea` snapshot captured at creation time, so the
  original spark is always recoverable even after the description evolves.

### Tags

A single polymorphic `TagAssignment` table links tags to any taggable type
(`project`, `task`, `issue`, `research`, `prompt`, `document`, `note`) without foreign keys,
so tags never block deletion.

---

## API overview

Base URL: `http://localhost:4000/api`

| Method | Endpoint                              | Purpose                                  |
| ------ | ------------------------------------- | ---------------------------------------- |
| GET    | `/health`                             | Health check                             |
| GET    | `/meta`                               | Available resources                      |
| GET    | `/projects`                           | Portfolio list (`?archived=active\|only\|all`, `?q=`, `?stage=`, `?tag=`) |
| POST   | `/projects`                           | Create project (captures `originalIdea`) |
| GET    | `/projects/:key`                      | Get by id or slug                        |
| PUT    | `/projects/:id`                       | Update project                           |
| DELETE | `/projects/:id`                       | Archive (`?hard=true` to delete)         |
| POST   | `/projects/:id/stage`                 | Change stage (`{ stage, note? }`)        |
| POST   | `/projects/:id/archive` `/activate`   | Archive / reactivate                     |
| GET    | `/projects/:key/overview`             | Project + tags + stats + recent activity |
| GET    | `/projects/:key/snapshot` `/health`   | Compact snapshot / health summary        |
| GET    | `/projects/:key/timeline`             | Activity grouped by day                  |
| GET    | `/projects/:key/ai-timeline`          | Prompts + AI sessions over time          |
| GET    | `/projects/:key/activity`             | Activity feed                            |
| GET    | `/projects/:key/heatmap`              | Activity heatmap data                    |
| GET    | `/projects/:key/export`               | Full JSON export                         |
| GET    | `/dashboard`                          | Global totals + stage/status breakdown   |
| GET    | `/dashboard/next-actions`             | Cross-project suggested next actions     |
| GET    | `/search`                             | Global search                            |
| GET    | `/tags`                               | Tags with usage counts                   |

### Project-scoped resources

All 20 resources follow the same CRUD pattern under
`/api/projects/:projectId/<resource>`:

```
research              research-questions    requirements        features
milestones            tasks                 issues              development-sessions
ai-sessions           prompts               documents           notes
deployments           incidents             git-references      decisions
tech-stack            database-tables       api-endpoints       attachments
```

List endpoints accept `?q=`, `?page=`, `?pageSize=` and enum filters (e.g. `?status=`,
`?priority=`, `?environment=`).

Special sub-routes:

- `GET/POST /prompts/:id/versions` — list / append prompt versions
- `GET /documents/:id/versions`, `PUT /documents/:id` with `content` — document versioning
- `GET/POST/DELETE /features/:id/requirements[/:requirementId]` — link/unlink requirements

PROJECT.md sub-routes (`/:key/project-document/...`):

| Method | Path                     | Effect                                          |
| ------ | ------------------------ | ----------------------------------------------- |
| GET    | ``                       | Metadata: path, hash, modified flag             |
| GET    | `/content`               | The current file                                |
| POST   | ``                       | Project Hub writes the file (database → file)  |
| POST   | `/regenerate`            | Rebuild the file from the record                |
| GET    | `/sync/state`            | Read-only change detection                      |
| POST   | `/sync/preview`          | Build a change set, write nothing               |
| POST   | `/sync`                  | Apply the change set atomically                 |
| GET    | `/monitor`               | Monitored state (drift, problems)               |
| POST   | `/monitor/check`         | Re-read the file now                            |
| POST   | `/monitor/dismiss`       | Hide the notification, keep the change          |

---

## Frontend workspace

Global pages: **Dashboard**, **Portfolio**, **Search**, **Tags**.

Each project (`/projects/:slug`) has tabs: Overview, Idea, Research, Requirements, Features,
Tasks, Milestones, Architecture, Decisions, Development, Prompts, Bugs, Testing,
Deployments, Production, Documentation, Notes, Activity, Settings.

A global quick-add palette and keyboard shortcuts are available from the layout.

The **Project File** card on the Overview tab holds the document and its
synchronization controls: **Check**, **Preview**, **Synchronize**, and **Regenerate**.

---

## PROJECT.md → database synchronization

Every project folder has one generated `PROJECT.md` file. It is the human-readable
mirror of the project record, and it is the only place the file is written from:
Project Hub regenerates it from the database. The synchronization direction that
Phase 6 adds is the other one — a hand-edited `PROJECT.md` can be applied back
into the database.

### Supported content

The Overview fields and prose sections (`Description`, `Problem`, `Motivation`,
`Assumptions`, `Inspiration`, `Initial Questions`, `V1 Scope`, `Repository`),
plus the list sections: tasks, notes, requirements, features, issues, research
entries, research questions, milestones, decisions, tech-stack entries, database
tables, API endpoints, deployments, git references, and prompt history.

`STATUS.md` is deliberately **not** part of this. Lifecycle state (`Status`,
`Status Stage`, `Archived`) stays under Project Hub's explicit control and is
never written by a sync — a document that claims otherwise is ignored.

### Using it

1. Edit the file in your editor.
2. **Check** — reports whether the file has drifted from the database.
3. **Preview** — returns the exact change set without writing anything.
4. **Synchronize** — applies the change set in one transaction, and returns
   `{ success, changed, updatedFields, applied, skipped }`.

Synchronization is also available from the API (see the table above) and runs
automatically through the monitor, which reports drift rather than writing.

### Safety rules

- **Never deletes.** A database record missing from the document is reported as
  *unmatched*, never removed.
- **Never clears.** A missing section, a blank field, or the `_Not yet
  documented._` placeholder means "no opinion", so the database value is kept.
- **Never partially applies.** All field updates and all record creations happen
  in a single transaction; a failure rolls the whole thing back.
- **Refuses conflicts.** If the database changed since the document was
  generated, the sync is refused unless the caller acknowledges the conflict.
- **Never loops.** After a sync the document hash is recorded, so an untouched
  file produces no work, and a sync never rewrites the file it just read.

### Limitations

- Matching is by code or stable key where one exists (`T-12`, `ADR-03`, `FR-2`)
  and otherwise by normalized title. Records without either are reported as
  unmatched rather than guessed at.
- Prose is not reformatted or reflowed; the parser only reads the sections it
  knows about, and unknown sections are ignored instead of failing the sync.
- Endpoint detail blocks are shown but not synchronized.

---

## Testing

```bash
npm test
```

The backend suite (`backend/tests/api.test.ts`) spins up the Express app via Supertest
against the configured database and covers: health/meta, project CRUD + slug + original
idea, portfolio search, stage changes + timeline, task codes/tags/completion, foreign-key
integrity, feature↔requirement linking, prompt and document versioning, research/decisions/
tech-stack/issues/deployments creation, and the archive/reactivate lifecycle.

`backend/tests/projectDocumentSync.test.ts` covers PROJECT.md → database
synchronization: the eight acceptance scenarios (no changes, a single-field change,
a GitHub-URL-only change, several fields at once, a missing section, an unknown
section, malformed Markdown, and loop prevention), idempotency, conflict
acknowledgement, identity stability, status protection, and deletion safety. Each
test file uses a throwaway Projects Root, only `__TEST__` projects, and asserts
that every pre-existing project row is byte-identical afterwards.

---

## Status

Implemented phases: foundation, project management, knowledge, AI development, delivery,
history/portability, and PROJECT.md ↔ database synchronization — including tests and
production builds for both apps.

### Known limitations / future work

- No authentication or multi-user support (V1 is local, single-user).
- No real-time updates (the UI refreshes on write events).
- Global search covers core entities; per-resource search is available on each list page.
