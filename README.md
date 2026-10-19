# Project Hub

> **Capture. Build. Ship.**

A personal **project lifecycle & AI/vibe-coding management system** and developer command
center. It answers one question for every project: *what actually happened, from idea to
maintenance?* — without losing any of that history along the way.

**Created by [Tumaini Kimtai](https://github.com/tumainihope00-creator)** —
repository: <https://github.com/tumainihope00-creator/project-hub>

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

   The AI provider is optional: add `AI_PROVIDER_API_KEY` (and optionally the
   other `AI_*` variables documented in `backend/.env.example`) to use the
   **AI Workspace** tab. Everything else works without it, and the key can
   instead be stored later from **Settings → AI Provider** — an environment key
   takes precedence over a stored one.

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
| GET    | `/projects/:key/workspace`            | Workspace folder status on disk          |
| POST   | `/projects/:key/open-folder`          | Open the workspace in File Explorer     |
| POST   | `/projects/:key/open-vscode`          | Open the workspace in VS Code           |
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
| GET    | `/prompts`                            | Cross-project prompt search (`?q=`, `?projectId=`, `?reusable=`, `?status=`) |
| GET    | `/prompts/:id`                        | One prompt anywhere, with its history    |
| POST   | `/projects/:id/prompts/generate`      | Offline prompt draft + readiness checklist |
| POST   | `/projects/:id/prompts/:pid/copy`     | Duplicate a prompt (`targetProjectId?`)  |
| POST   | `/projects/:id/prompts/:pid/archive`  | Archive (status only, never deletes)     |
| GET    | `/ai/status`                          | Provider readiness, never the key        |
| GET    | `/ai/providers`                       | Registered providers and suggested models |
| GET/PUT| `/ai/settings`                        | Provider, model, enabled, timeout, write-only `apiKey` |
| POST   | `/ai/generate`                        | Send a reviewed prompt (writes nothing)  |
| GET    | `/ai/interactions/:id`                | One saved interaction, full detail       |
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
- `GET /ai/context?sections=` — preview the exact context a request would send
- `GET/POST /ai/interactions` — saved AI interactions for this project (list / save)

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
| GET    | `/sync/status`           | State, every conflict value, and history        |
| POST   | `/sync/resolve`          | Decide conflicting fields, then apply            |
| GET    | `/monitor`               | Monitored state (drift, problems)               |
| POST   | `/monitor/check`         | Re-read the file now                            |
| POST   | `/monitor/dismiss`       | Hide the notification, keep the change          |

---

## Frontend workspace

Global pages: **Dashboard**, **Portfolio**, **Search**, **Tags**.

Each project (`/projects/:slug`) has tabs: Overview, Idea, Research, Requirements, Features,
Tasks, Milestones, Architecture, Decisions, Development, Prompts, Prompt Generator,
AI Workspace, Bugs, Testing, Deployments, Production, Documentation, Notes, Activity,
Settings.

A global quick-add palette and keyboard shortcuts are available from the layout.

Every project page also has **Open Folder** and **Open in VS Code** buttons in
the header action bar (next to the stage selector) — see *Opening the workspace
locally* below.

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

### How a difference is decided

Synchronization compares three things, not two: the file, the project record, and
a **baseline** — the last value the two sides agreed on, stored as JSON on the
project row. Every compared field gets one verdict:

| Verdict | Meaning |
| ------- | ------- |
| `unchanged` | Nothing moved since the baseline. |
| `markdown_changed` | Only PROJECT.md moved. Safe to apply. |
| `database_changed` | Only the record moved. Kept; regenerate to catch up. |
| `both_changed` | Both moved **to the same value**. No conflict, no write. |
| `conflict` | Both moved the same field to **different** values. |

The state shown to the user is rolled up from those verdicts: `synchronized`,
`markdown_changed`, `database_changed`, `both_changed`, `conflict`, `error`, or
`unavailable`. Changing a different field on each side is therefore not a conflict —
both changes are applied in one transaction. Only the same field, differently, needs
a decision.

The baseline is captured when Project Hub writes the document itself (create,
generate, regenerate), and advanced after each successful synchronization. A project
that predates this phase has no baseline: differences are then reported as conflicts
rather than applied, and the baseline is recorded on the first pass that finds the
two in agreement.

### Using it

1. Edit the file in your editor.
2. **Check / Preview** — returns the classified change set without writing anything,
   including every conflicting value side by side.
3. **Synchronize** — applies the safe changes in one transaction. If any field is in
   conflict, nothing is applied until each one is decided.
4. **Decide conflicts** — per field: *Keep database*, *Keep PROJECT.md*, or enter a
   value. The decisions are applied together, in one transaction.

`acknowledgeConflict: true` on `POST /sync` remains supported and means "PROJECT.md
wins everywhere". The response of every one of these carries the classified state, the
conflicts, and (on `/sync/status`) the recent history.

Synchronization is also available from the API and runs automatically through the
monitor, which reports drift rather than writing.

### Safety rules

- **Never deletes.** A database record missing from the document is reported as
  *unmatched*, never removed.
- **Never clears.** A missing section, a blank field, or the `_Not yet
  documented._` placeholder means "no opinion", so the database value is kept.
- **Never partially applies.** All field updates, all record creations and all
  conflict decisions happen in a single transaction; a failure rolls the whole
  thing back, including the baseline it would have written.
- **Never guesses at a conflict.** A field changed on both sides is withheld until
  the caller decides. A field changed only in the document is applied; a field
  changed only in the record is kept and reported.
- **Never trusts a stale read.** The file is re-read and re-hashed immediately
  before applying; if it changed in between, nothing is written and the newer file
  is asked for again. One synchronization runs at a time per project.
- **Never loops.** After a sync the document hash is recorded, so an untouched file
  produces no work, and a sync never rewrites the file it just read. Keeping the
  database value leaves the file as it is — bringing the document back in line is
  an explicit *Regenerate*.

### History

Each synchronization writes one row to the project's activity timeline, inside the
same transaction, recording the direction, the fields it wrote, the fields it kept
from the database, the conflicts it held back, and any decisions made about them.
There is no separate audit table for this: the timeline is the history, and
`GET /sync/status` reads it back.

### Limitations

- Matching is by code or stable key where one exists (`T-12`, `ADR-03`, `FR-2`)
  and otherwise by normalized title. Records without either are reported as
  unmatched rather than guessed at.
- Prose is not reformatted or reflowed; the parser only reads the sections it
  knows about, and unknown sections are ignored instead of failing the sync.
- Endpoint detail blocks are shown but not synchronized.

---

## AI prompt library & project context

Prompts are first-class records and are **never executed**: Project Hub stores,
versions and drafts prompt text, and using it with an AI tool is a human action
outside the app. No AI provider is called anywhere in this phase.

Each prompt has a stable code (`PROMPT-001`), an optional title, a category, a
purpose, a **status** (`DRAFT → READY → USED → ARCHIVED`) and a **reusable**
flag. Content lives in the append-only version history: `prompts.content` always
equals the text of the newest version, and every content write — create, new
version, PROJECT.md edit, conflict resolution — goes through one helper that
appends the version in the same transaction.

- **Archiving changes status, never deletes.** Archived prompts leave the default
  lists; `?status=ARCHIVED` reads them back.
- **Reusable prompts** (`isReusable`) are listed in generated drafts under
  "Reusable prompts in this project".
- **Search** (`q`) matches title, purpose, category, content, code and tags — on
  the project list, on the cross-project `GET /api/prompts`, and in `GET /api/search`.

### PROJECT.md

Prompts render as an `## AI Prompts` section (bold code, optional title,
`Category · Status · Reusable · Purpose` attributes, content as the detail block)
and are a full synchronization citizen: hand edits are classified, previewed,
applied and conflict-managed like every other section. An applied edit appends a
prompt version whose `changes` records PROJECT.md as the source, so the version
invariant holds through sync and conflict resolution alike.

### Context builder & generator

`POST /api/projects/:id/prompts/generate { purpose }` assembles a draft from the
project's own records (requirements, features, tasks, issues, decisions, tech
stack, milestones, deployments, notes, research, reusable prompts) and returns it
with a readiness checklist for the chosen purpose — required and recommended items,
what is missing, and where to record it. Missing information renders as
`Not provided in Project Hub.`; nothing is ever invented. The endpoint always
answers 200 (an unknown purpose is the only 400).

In the UI, **Generate Prompt** on the Prompts tab opens the checklist plus an
editable draft: *Fill missing* links to the pages where absent information can be
recorded, *Proceed anyway* saves the draft as an ordinary `DRAFT` prompt (v1), and
the last purpose is remembered for the browser session. **Copy** duplicates a
prompt with a fresh code and history (cross-project copies drop record links),
**Archive** is idempotent, and the draft context is built entirely offline.

---

## AI provider integration & AI workspace

The AI Workspace is the first phase that can actually *send* a prompt. The chain is
deliberately shallow and each layer speaks only to the next:

```
AI Workspace (React)  →  AI Service (lib/ai/aiService.ts)
                           ↓ builds the request, normalizes the result or failure
                         Provider Adapter (lib/ai/providers/*)
                           ↓ provider-specific HTTP
                         AI Provider (external service)
```

Everything above the service knows only the provider-independent vocabulary in
`lib/ai/types.ts`; the adapter layer owns the Authorization header, the request
body shape and the response parsing. **The OpenAI Chat Completions adapter** is the
only one registered today, chosen because most compatible endpoints (OpenAI,
OpenRouter, DeepSeek, Groq, LM Studio, Ollama's OpenAI-compatible route) answer the
same `POST {baseUrl}/chat/completions`. It is implemented with the platform `fetch`,
so the backend gains no SDK dependency. Adding a second provider later is: one new
file in `providers/`, one line in the `ADAPTERS` table of `registry.ts` — the
workspace, routes, settings and history do not change.

### Configuration

| Value | Precedence |
| ----- | ---------- |
| API key | env `AI_PROVIDER_API_KEY` → stored `ai_api_key` (env wins) |
| Provider | stored `ai_provider` → env `AI_PROVIDER` → `openai` |
| Model | stored `ai_model` → env `AI_MODEL` → provider default |
| Enabled | stored `ai_enabled` → env `AI_ENABLED` → `true` |
| Timeout | stored `ai_timeout_ms` → env `AI_TIMEOUT_MS` → `60000` |
| Base URL | env `AI_BASE_URL` only → provider default |
| Response cap | env `AI_MAX_RESPONSE_CHARS` → `200000` |

The stored values live in the existing `app_settings` table under five fixed keys
and are edited from **Settings → AI Provider** (provider, model, timeout, enabled,
write-only API key). The base URL is environment-only on purpose: a client-supplied
URL would turn the backend into an open relay that posts secrets to attacker-chosen
hosts, so no request body or query string can ever set it — both the settings and
the generate schemas are `.strict()` and reject unknown fields outright.

The API key never crosses the wire: settings and status report `apiKeyConfigured`
and `apiKeySource`, never a value, and what is typed into Settings is written once
and then unreadable. `.env` stays git-ignored (as it already was).

### The request

`POST /api/ai/generate { projectId, prompt, sections[], promptId?, model? }`:

1. readiness — enabled, registered provider, key present, endpoint known;
2. validation — the project exists and the optional `promptId` belongs to it;
3. context — the Phase 8 builder renders only the selected sections server-side;
   absent records keep the `Not provided in Project Hub.` marker, and an identity
   header (name, stage, repository, tags) always travels with the request;
4. dispatch to the adapter with a system instruction that frames project content
   as data to be treated as text, never as instructions;
5. normalization — response text (capped by `AI_MAX_RESPONSE_CHARS`), usage as the
   provider reported it (`null` when absent, never invented), and the echo of what
   was actually sent, so the caller can store an exact snapshot.

**The endpoint writes nothing.** A failed or abandoned attempt leaves no permanent
record and a retry cannot duplicate one: the interaction is persisted only by an
explicit `POST /api/projects/:id/interactions`, which stores `SUCCEEDED` rows with
snapshot columns (prompt text, context text, selected sections) so later edits
cannot rewrite history. Failures are reported in the response of the failure
itself.

### Failures

Every provider-side problem becomes an `AI_ERROR` with a stable
`details.code`, a `retryable` flag and a `possibleAction` the UI can show:
`DISABLED` / `MISSING_API_KEY` / `UNKNOWN_PROVIDER` / `INVALID_API_KEY` /
`INVALID_MODEL` (400), `RATE_LIMIT` (429), `TIMEOUT` (504), `NETWORK` (503), and
`PROVIDER_ERROR` / `MALFORMED_RESPONSE` / `EMPTY_RESPONSE` (502). The provider's
own message is passed through length-capped and header-free; the key itself appears
in no error, log or response.

### Workspace UI

The **AI Workspace** tab is a four-step flow: pick a stored prompt (or type a
custom one), toggle context sections with a live preview of the exact text that
will be sent, review prompt + context + model, then read the response rendered
through the safe Markdown renderer. Responses are never executed and never act on
the app. Saved interactions appear in a history column with a detail view showing
the prompt, the context, the response and the usage as they were at the time.

---

## Opening the workspace locally

The **Open Folder** and **Open in VS Code** buttons on every project page
launch that project's actual workspace folder on your machine — File Explorer
or Visual Studio Code (Windows only; other platforms get a clear error).

The endpoints take only a project id. The backend re-derives the folder from
the stored `folderPath`, proves it resolves inside the configured **Projects
Root** and still exists on disk, then spawns the application with
`shell: false` and a detached process, so the server never blocks on the
window. A project with no folder, a missing folder, or a path outside the
root gets an honest error with guidance — Project Hub never recreates a
missing folder and never falls back to the parent directory. VS Code is found
via its standard install locations or the `code` PATH shim; if it cannot be
found, the response explains how to fix the installation, and nothing is
installed or modified automatically.

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

`backend/tests/projectDocumentSyncPhase7.test.ts` covers the change-aware
comparison: each of the six verdicts, per-field conflict resolution (keep database,
keep PROJECT.md, manual), projects that predate the baseline, generated and AI-edited
documents, a failed synchronization applying nothing, rapid consecutive edits,
and the recorded history.

`backend/tests/promptPhase8.test.ts` covers the prompt library: create defaults and
content/version pairing, metadata-only edits adding no version, scoped and global
search, category and reusable filters, archive semantics, the `## AI Prompts`
round trip through PROJECT.md (render, preview, sync, conflict, resolve), the
generator's readiness checklist, missing-information honesty, proceeding anyway,
filling the gaps and regenerating, same-project and cross-project copies, and a
before/after database fingerprint asserting no non-`__TEST__` row changed.

`backend/tests/aiPhase9.test.ts` covers the AI integration. No test ever talks to
a real provider: a local `node:http` stub stands in for one and the backend is
pointed at it through `AI_BASE_URL`. It asserts that status, providers and
settings never return the key (before or after it is stored), that the settings
endpoint is strict (no client-side base URL, known providers, bounded timeouts),
that readiness failures arrive as the documented `AI_ERROR` codes, that a
successful request carries the right key, model and system instruction and writes
nothing, that context preview renders only the selected sections with the
`Not provided` marker, that cross-project `promptId`s are refused on both paths,
that 401/429/model-rejection/5xx/malformed/empty/timeout/offline responses are
normalized, that oversized responses are capped, and that interactions are saved
only explicitly with exact snapshots — plus the usual environment and settings
snapshot/restore and database fingerprint.

`backend/tests/openLocal.test.ts` covers the **Open Folder / Open in VS Code**
endpoints: trusted folder resolution for real created projects (each project
resolves to its own distinct stored folder), refusal of projects without a
configured folder, paths outside the Projects Root, and folders deleted from
disk (which are never recreated), plus 404s for unknown ids and slug-key
handling. The launchers themselves are deliberately not invoked by tests, so a
test run never opens real windows on the machine; the success path is verified
manually against live projects.

---

## Status

Implemented phases: foundation, project management, knowledge, AI development, delivery,
history/portability, PROJECT.md ↔ database synchronization, change-aware PROJECT.md
monitoring and synchronization, AI prompt management (library, versioning, PROJECT.md
section, context builder and offline prompt generator), AI provider integration with
the AI workspace, and local workspace launch (Open Folder / Open in VS Code) —
including tests and production builds for both apps.

### Known limitations / future work

- No authentication or multi-user support (V1 is local, single-user).
- No real-time updates (the UI refreshes on write events).
- Global search covers core entities; per-resource search is available on each list page.
- Opening the workspace locally (Open Folder / Open in VS Code) is Windows-only, and
  VS Code is currently the only editor target.

---

## Product identity & About

The product name, tagline, creator attribution, repository links, logo references and
version are defined in one place: [`frontend/src/appInfo.ts`](frontend/src/appInfo.ts).
The displayed version is injected at build time from `frontend/package.json` (see
`frontend/vite.config.ts`), so the About dialog always reports the real package version.

The in-app **About Project Hub** dialog (topbar info button, or **Settings → About**)
shows the logo, tagline, version, creator attribution and third-party acknowledgements.
Brand assets:

| Asset                | Location                                  |
| -------------------- | ----------------------------------------- |
| Logo (vector)        | `frontend/public/logo.svg`                |
| Favicon              | `frontend/public/favicon.svg`             |
| In-app logo component | `frontend/src/components/Logo.tsx`       |
| Windows icon (multi-size .ico) | `assets/project-hub.ico`       |

The Windows icon can be regenerated from the logo geometry with
`scripts\generate-icon.ps1`. Desktop packaging itself is not set up yet.

---

## Creator

Project Hub is created and maintained by **Tumaini Kimtai**.

- GitHub profile: <https://github.com/tumainihope00-creator>
- Repository: <https://github.com/tumainihope00-creator/project-hub>

---

## License

No software license has been declared for this repository yet (there is no `LICENSE`
file and no `license` field in the package manifests). Until one is added, the source
code is **not open source** and all rights are reserved by the creator.

Project Hub depends on third-party open-source libraries (React, Vite, Express, Prisma,
PostgreSQL, Recharts, lucide-react, Inter, and others — see `frontend/package.json` and
`backend/package.json` for the full list). Each is licensed independently by its own
authors; their licenses, names and trademarks remain the property of their respective
owners. The About dialog lists the main acknowledgements.
