# UI / UX — Project Hub 2.0

> **Temporary reference document.** Generated 2026-10-06 from the codebase
> (`frontend/src`). It describes what exists today and will drift as the app
> evolves; delete or regenerate it when it stops matching the code.

---

## 1. Design language

Project Hub is a **local, single-user, dark-only** workspace app. The visual
language is deliberately close to GitHub's Primer dark theme: near-black
backgrounds, subtle 1px borders, compact typography, and color used as
*information* (status, severity, lifecycle) rather than decoration.

Principles observable in the code:

- **Density over whitespace.** 13px base font, 12–12.5px controls, tables and
  toolbars pack information tightly; padding is 14–16px inside cards.
- **Color is semantic.** Every badge/dot color comes from `lib/status.ts` —
  green means done/healthy, red blocked/failed, yellow needs-attention,
  blue in-flight, gray idle/unknown. There are no arbitrary accents.
- **Everything is a record.** Lists, detail modals, and forms follow one
  pattern (section 5), so learning one page teaches all 20 resources.
- **Destructive actions are two-step.** `ConfirmButton` arms on first click,
  disarms after 4 s if unused.
- **Honest empty states.** Empty, loading, degraded and error states are all
  distinct and never fake data (`EmptyState`, `Loading`, `ErrorBox`,
  `Not provided in Project Hub.` markers).

There is **no light theme** (`color-scheme: dark`), no custom fonts (system
sans + `ui-monospace`), and no icon library — glyphs are Unicode characters
(`▦ ◫ # ⚙ ⌕ ✓ ✗ ×`).

---

## 2. Design tokens (`src/styles.css`)

| Token | Value | Use |
| ----- | ----- | --- |
| `--bg` | `#0d1117` | Page background |
| `--bg-elev` | `#161b22` | Cards, sidebar, topbar, tables |
| `--bg-elev-2` | `#1c2128` | Buttons, chips, elevated bits |
| `--bg-hover` | `#21262d` | Hover states |
| `--border` / `--border-muted` | `#30363d` / `#21262d` | Borders, dividers |
| `--text` / `--text-muted` / `--text-dim` | `#e6edf3` / `#8b949e` / `#6e7681` | Primary / secondary / tertiary text |
| `--accent` / `--accent-hover` | `#58a6ff` / `#79c0ff` | Links, focus rings, active tab |
| `--green` `--yellow` `--orange` `--red` `--purple` `--pink` `--cyan` | `#3fb950` `#d29922` `#db6d28` `#f85149` `#bc8cff` `#f778ba` `#39c5cf` | Semantic states |
| `--radius` | `6px` | Everything is slightly rounded |
| `--mono` / `--sans` | `ui-monospace…` / system sans | Code vs prose |

**Status color map** (`lib/status.ts`, `statusColor(value)`): one lookup table
covering stages (IDEA→ABANDONED), task statuses, priorities/severities, issue
lifecycle, prompt results (SUCCESSFUL / PARTIALLY_SUCCESSFUL / FAILED…),
deployment environments and git kinds. Unknown values fall back to gray, so a
new enum value never renders as an unstyled surprise.

---

## 3. Application shell

```
┌─────────────┬──────────────────────────────────────────────┐
│  SIDEBAR    │  TOPBAR  [ ⌕ global search…… ]   [+ Project] │
│  248px      ├──────────────────────────────────────────────┤
│             │  CONTENT (scrolls)                           │
│  brand      │   .page  (max-width 1400px, padding 20/24)   │
│  + Quick Add│                                              │
│  Dashboard  │                                              │
│  Projects   │                                              │
│  Tags       │                                              │
│  Settings   │                                              │
│  Projects ▸ │                                              │
│   ● name…   │                                              │
│  Archived ▸ │                                              │
│  Tags cloud │                                              │
└─────────────┴──────────────────────────────────────────────┘
```

- `.app` is a CSS grid `248px 1fr`, full viewport height, overflow hidden —
  **only the content column scrolls**.
- **Sidebar**: brand + green **+ Quick Add** button (shows `Q` kbd chip);
  primary nav items with glyph + right-aligned counts; an *active projects*
  list with a **stage dot** (`--color` per stage) and ellipsized name; a
  collapsed *Archived* section (▸/▾ toggle, archived projects render at
  0.55 opacity elsewhere); a tag cloud (top 18 tags with counts).
- **Topbar** (48px): one global search field (Enter → `/search?q=`) and a
  `+ Project` button (→ `/projects?new=1`). Nothing else — secondary actions
  live on pages.
- **Responsive**: grids collapse 4→2 and 3→2 columns below 1100px; the quick-add
  grid goes 3→2 columns below 700px; project tabs scroll horizontally. There is
  no dedicated mobile layout — it is a desktop tool.

---

## 4. Navigation & routes

| Area | Route | Page |
| ---- | ----- | ---- |
| Global | `/` | Dashboard |
| | `/projects` | Portfolio (card grid; `?new=1` opens the creation wizard) |
| | `/search?q=` | Global search across every entity |
| | `/tags` | Tag cloud + tag detail (`?tag=`) |
| | `/settings` | Global settings (Projects Root, workspace) |
| Project | `/projects/:slug` | **ProjectLayout** — header + tab bar + `<Outlet/>` |

Project tabs (in order): Overview (`end`), Idea, Research, Requirements,
Features, Tasks, Milestones, Architecture, Decisions, Development, **AI
Prompts**, **Prompt Generator**, Bugs, Testing, Deployments, Production,
Documentation, Notes, Activity, Settings.

- The active tab is underlined (`border-bottom: 2px solid --accent`), tabs
  scroll horizontally when they overflow, and the sidebar highlights the
  current project.
- ProjectLayout listens for the `data-changed` window event and re-fetches the
  project after any write, so stage/status changes made in tabs reflect
  immediately.
- Some tabs host sub-navigation via `SubTabs` (in-page buttons, not routes):
  Architecture, Development, Production, Testing.

---

## 5. Page patterns

Every list/detail page is assembled from the same vocabulary:

### 5.1 Page header — `.page-head`
`h1` + `.sub` line (count or one-sentence intro) on the left,
`.actions` buttons pushed right (primary action first: `+ New …`).

### 5.2 Toolbar — `.toolbar`
One wrapping row: search input (min 240px, debounced 300 ms), filter `<select>`
dropdowns ("All status", "All category"…), `.spacer`, right-aligned secondary
controls. Focus turns borders blue.

### 5.3 List — `.table-wrap > table.data`
- Uppercase 11px column headers, hover rows, right-aligned Tags column and
  actions cell.
- Cell values render through `renderCell`: `badge` (colored pill), `date` /
  `datetime` (localized, `nowrap`), `mono`, `number`, `bool` (Yes/No),
  `percent`; long text truncates at 120 chars; empty values show a dim `-`.
- **Row click opens the detail modal** (rows are `cursor: pointer`).
- Loading shows a spinner row; zero rows show `EmptyState` with a helpful hint.

### 5.4 Detail — modal with `dl.kv`
Two-column label/value grid (160px labels), followed by full-width content
blocks (`pre.content-block` for prompt text / markdown), tags as chips, and a
footer: destructive action left (after `.spacer`), then secondary actions, then
**Close** right.

### 5.5 Forms — `ResourceForm` (2-column `.form-grid`)
- Field types: text, textarea (monospace, vertical resize), select, date,
  number, url, tags, relation (dynamic dropdown), boolean (Yes/No select).
- Required fields get a red `*`; hints (`.hint`) sit under inputs; validation
  errors render above the footer in red and keep the form open.
- Submit shows `Saving…`, then the modal closes, a toast appears, and the
  affected views reload (`after()` → list + project + tags).
- Tags use `TagEditor`: pill chips with `×`, free-text add, suggestions from
  global tag usage.

### 5.6 Cards, grids, stats
`.card` (elevated panel), `.grid.c2/c3/c4` (responsive), `.stat` tiles
(uppercase label, 22px tabular-nums value, hint), `.stat-row` compact groups,
`h2.section` uppercase section headings separating zones on long pages.

### 5.7 Timeline — `.timeline`
Left rule with dot markers; each item has an uppercase type chip, right-aligned
time, description and optional dim detail. Used by Activity, version history,
sync history.

### 5.8 Markdown rendering
`lib/markdown.tsx` converts markdown to **React elements only** (never
`dangerouslySetInnerHTML`); the `.markdown` styles provide headings, lists,
quotes, code blocks, and `.md-unsafe-link` (yellow mono) for non-http(s) URLs.

---

## 6. Component inventory (`components/ui.tsx` etc.)

| Component | Behavior |
| --------- | -------- |
| `Badge` / `StageBadge` | Pill with colored dot; color from `statusColor`, humanized label (`IN_PROGRESS` → `In progress`) |
| `Loading` / `Spinner` | Inline 14px spinner + label |
| `EmptyState` | Centered dim block: big title + hint |
| `ErrorBox` | Fixed bottom-right toast-style alert (red left rule) for request failures |
| `Modal` | Centered dialog (720px / 900px `wide`), dim overlay; **Esc closes**, backdrop click closes, `×` button; body scrolls at 68vh; optional footer row |
| `ConfirmButton` | Two-step: click arms (label → `confirmLabel`, styled danger), 4 s timeout reverts, second click confirms. The `question` shows as tooltip while armed |
| `ProgressBar` | 6px accent bar, clamped 0–100 |
| `TimeAgo` | Relative time with absolute tooltip |
| Toast (AppContext) | Success/info messages, bottom-right, auto-dismiss **5 s**, `role="alert"` |
| `SubTabs` | In-page tab buttons (no URL change) |
| `ReadinessChecklist` / `ReadinessModal` | V1 prompt readiness UI (section 8.7) |
| `ProjectDocumentCard` | PROJECT.md viewer + sync controls (section 8.3) |
| `ProjectStatusCard` | STATUS.md / lifecycle state + stage transitions |
| `DocumentImportWizard` / `CompleteInfoWizard` | Multi-step wizards with progress dots (`wz-*` styles) |
| `QuickAdd` | Global create palette (section 7) |

---

## 7. Global interactions

- **`Q` key** opens Quick Add (ignored while typing in inputs/selects).
  Quick Add shows a 3-column grid of create shortcuts — Project, Task,
  Bug/Issue, Research, AI Prompt, Decision (ADR), Note, Dev Session, AI
  Session — then renders the standard `ResourceForm` in a modal with a project
  picker. `Project` jumps to the Portfolio wizard instead.
- **Global search** (topbar, Enter): jumps to `/search`, which groups results
  by entity type (projects, tasks, prompts, research, issues, documents, notes…)
  with meta line + snippet cards.
- **Toasts** confirm every successful mutation ("Prompt recorded",
  "Version added", "Prompt archived — nothing was deleted").
- **Esc / backdrop click** closes any modal; forms never lose data silently —
  Cancel is explicit and separate from Save.
- **`data-changed` window event**: writes notify the shell, which refreshes
  project header state (stage, counts) without a full reload.
- Keyboard hints are shown as `.kbd` chips (e.g. the `Q` on the sidebar
  button).

---

## 8. Page-by-page

### 8.1 Dashboard (`/`)
Stat tiles (totals), **Next actions** (heuristic suggestions), stage
distribution bars, project cards, recent activity timeline, task status
breakdown — each an `h2.section` zone.

### 8.2 Portfolio (`/projects`)
Filterable card grid (`.project-card`): name + stage badge, 2-line idea
clamp, mini stats (tasks/notes counts), archived cards dimmed. Search box
filters name/description client-side. `+ Project` / `?new=1` opens the import
or manual creation wizard (progress-dot steps, choice chips, hint text).

### 8.3 Overview tab (per project)
Zones: **Workspace** (folder path + open actions), **Project status**
(lifecycle card with stage transitions), **Project document** (the PROJECT.md
card — see below), **What needs attention** (gaps/health), **The idea**
(original idea prose), **Activity heatmap** (last 10 weeks, GitHub-style
`heat-l0…l4` greens), **At a glance** stats, **Recent activity** timeline.

**Project document card** (`ProjectDocumentCard`):
- View the generated Markdown (safe React rendering), with hash/modified state.
- Actions: **View / Check / Generate / Regenerate** (confirm before rewriting),
  sync controls **Preview → Synchronize**, history expansion, and monitor
  notification **Check / Dismiss**.
- Conflicts render as a card: per-field *Keep database* / *Keep PROJECT.md* /
  manual value; "Resolve" enables only when every conflict is decided.
- Degraded/missing file states are explained, not thrown as errors.

### 8.4 List tabs (Research, Requirements, Tasks, Bugs, Notes, Milestones, …)
All use `ResourcePage` + config from `resources.ts`: header → toolbar
(search + enum filters) → table → detail modal → create/edit modals →
pagination (`page`, `pageSize`) and a total count in the sub-line. Features
extend this with linked requirements; Tasks support completion toggles and
code columns (`T-12`, mono).

### 8.5 AI Prompts tab
Like a resource page but with prompt-specific behavior:
- Header: primary **Generate Prompt** + `+ New Prompt`.
- Toolbar: search, Status, Result, Category, Reusable (Yes/No) filters;
  archived prompts are excluded unless `Status = Archived` is chosen.
- Table: Code (mono), Prompt, Status (badge), Category, Template (Yes/No),
  Tool, Result (badge), Date, Ver count.
- Detail modal: status + "reusable template" marker, tool/model, result, dates,
  purpose, current prompt text (`pre.content-block`), AI response, version
  timeline; footer actions **Copy**, **Archive** (two-step; archived prompts
  show a "restore via Edit metadata" hint instead), **+ Add version** (text +
  response + what-changed + reason), **Edit metadata**, **Delete** (two-step).
- **Generate Prompt modal** (offline generator):
  - Purpose select (Research / Architecture / Feature implementation /
    Debugging / Refactoring / Testing / Documentation / Deployment), remembered
    in `sessionStorage` for the session.
  - Live **readiness checklist**: green ✓ / red ✗ per item, "· required" tags,
    verdict line ("Ready — every required item is recorded." in green, or
    "Missing N required items." in red).
  - **Fill missing** (enabled only when something required is absent) toggles a
    card of links to the exact tab where each gap can be recorded.
  - Editable draft textarea (monospace) with the honesty note: sections read
    `Not provided in Project Hub.`; "no AI service is called" is stated in the
    hint.
  - Footer: **Fill missing** · **Cancel** · **Proceed anyway** (unready) or
    **Save prompt** (ready). Saving creates a normal DRAFT prompt (v1).
  - Degraded sources surface as a red warning listing which reads failed.

### 8.6 Prompt Generator tab (V1)
The older, richer generator: readiness-first flow with choice chips
(`wz-choice`), progress dots, and the `rc-*` checklist system (section 8.7).

### 8.7 Readiness checklist UI (`rc-*` styles)
Used by V1 Prompt Generator / ReadinessModal:
- Header block with title, subtitle and a meta strip (purpose, tool, verdict).
- System errors in a red `rc-error-box` (never silent).
- Checklist groups with counts; each item is an expandable row with glyph,
  label, detail, `required`/`recommended` flag chips, and a status word;
  expansion reveals key/value details.
- Summary panel with verdict colors: `ready` green, `needs-info` yellow,
  `error` red; missing/recommended blocks; collapsible optional list; a
  left-accent "next step" note.
- A 3-column evidence grid appears when complete.

### 8.8 Documents, Architecture, Development, Production, Testing
Custom pages combining tabs/sub-tabs with viewers: document list + version
history + markdown viewer; architecture decisions/tech-stack tables;
development sessions timeline; production/health summaries; testing views.
All reuse the same header/toolbar/table/modal vocabulary.

### 8.9 Activity, Tags, Search, Settings
- **Activity**: full timeline grouped by day, filterable.
- **Tags**: cloud + per-tag usage; `?tag=` deep link from the sidebar cloud.
- **Search**: grouped result cards (`.search-result`: meta, title, snippet).
- **Settings**: global (Projects Root browser with path validation, danger
  zone with two-step confirms) and per-project (rename, slug, archive,
  import/export).

---

## 9. Feedback, safety & state conventions

| Situation | Treatment |
| --------- | --------- |
| Loading | Spinner row (`Loading…`), tables show it only while empty |
| Empty | `EmptyState` title + actionable hint |
| Request failure | `ErrorBox` toast (red), backend message shown verbatim (it always explains *what / operation / next step*) |
| Success | Toast, 5 s, auto-dismiss |
| Destructive | Two-step `ConfirmButton`, question in tooltip, red armed state; archive preferred over delete |
| Optimistic? | No — every mutation awaits the API, then reloads |
| Long operations | Buttons switch to `Saving…` / `busy` and disable |
| Sync conflicts | Nothing is applied until every conflict is decided; per-field three-way choice |
| Unknown enum values | Gray badge fallback, humanized label |
| Archived data | 0.55 opacity, excluded from default lists, always restorable |

**Voice**: buttons are verbs (`Generate Prompt`, `Proceed anyway`,
`Regenerate`); warnings state consequences ("Archive this prompt? It leaves the
active lists but is never deleted."); hints explain *why*, not just *what*.

---

## 10. Accessibility & known UX gaps

Working well: visible focus via border-color change, semantic buttons/labels,
`role="alert"` on toasts, aria-label on the modal close button, tooltips on
armed confirms, keyboard Esc on modals, `Q` shortcut with input-guard.

Known gaps (as of this document):

1. **Dark only** — no theme toggle; `color-scheme: dark` forces dark form
   controls too.
2. **No focus trap** in modals — Tab can move focus behind the overlay.
3. **13px base** with 11–11.5px secondary text — dense; below ~1100px some
   grids get tight, and there is no true mobile layout.
4. **No route-level breadcrumbs** inside a project — getting back to a tab
   means the tab bar or sidebar.
5. **In-page sub-tabs** (Architecture/Development/Production/Testing) are not
   reflected in the URL, so they cannot be deep-linked.
6. **Toasts are visually identical for success and error** (the `.toast` style
   has a red left rule); only the wording distinguishes them.
7. **Global search requires Enter** — no as-you-type suggestions.

---

## 11. Where the UI lives

```
frontend/src/
├── styles.css               all tokens + component styles (single file)
├── App.tsx                  route table
├── context/AppContext.tsx   projects, tags, toast, reloads
├── context/ProjectContext.tsx current project + reload
├── components/
│   ├── Layout.tsx           sidebar + topbar shell
│   ├── ui.tsx               Modal, Badge, ConfirmButton, Loading…
│   ├── QuickAdd.tsx         Q palette
│   ├── ResourceForm.tsx     generic form (incl. boolean/relation/tags)
│   ├── ProjectDocumentCard.tsx  PROJECT.md viewer + sync/conflict UI
│   ├── ProjectStatusCard.tsx    STATUS.md / stage control
│   ├── ReadinessChecklist.tsx   rc-* readiness UI
│   ├── DocumentImportWizard.tsx / CompleteInfoWizard.tsx  step wizards
│   └── TagEditor.tsx, SubTabs.tsx, ErrorBoundary.tsx
├── pages/
│   ├── ResourcePage.tsx     generic list/detail/renderCell
│   ├── PromptsPage.tsx      prompt library + GeneratePromptModal
│   ├── ProjectLayout.tsx    project header + tabs
│   └── Dashboard / Portfolio / SearchPage / TagsPage / SettingsPage …
├── resources.ts             per-resource field/column/filter configs
└── lib/status.ts            the status→color map
```

Config-driven principle: adding a resource means adding an entry to
`resources.ts` — the list page, forms, filters, quick-add entry and search
pick it up without new components.
