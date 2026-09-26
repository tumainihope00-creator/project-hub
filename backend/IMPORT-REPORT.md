# Document Import — A–I Inventory and Database Safety Report

Feature: import a project document and create **one new** Project Hub project from it.
Date: 2026-09-26. Baseline: `backend/baseline-before.json` (captured before any importer code ran).

Every inventory table below was generated from the live schema by
`discoveredModel()` in `backend/src/lib/import/discovery.ts`, not written by hand.

---

## A. Accepted input and hard limits

| Property | Value |
| --- | --- |
| Formats | `.txt`, `.md` / `.markdown`, `.json`, `.docx`, `.pdf` |
| Max size | 15 MiB (`MAX_BYTES`), rejected before parsing with `DOCUMENT_ERROR` |
| Storage | none — memory only, never written to disk, `source.stored` is always `false` |
| Network / AI | none. Extraction is deterministic local pattern matching |
| DOCX text | `mammoth` → raw text |
| PDF text | `pdf-parse` text layer only. A scanned PDF has no text layer and is reported as such; **no OCR is claimed** |
| JSON | project fields from a structured object; unsupported keys are reported, not stored |

Parsing, character normalisation and size checks live in `backend/src/lib/import/parse.ts`.

---

## B. Project fields the importer can fill

Discovered from Prisma DMMF. `required` is marked `*`.

| field | kind | enum |
| --- | --- | --- |
| name | string | |
| description | string | |
| problem | string | |
| motivation | string | |
| targetUsers | string | |
| expectedValue | string | |
| assumptions | string | |
| initialQuestions | string | |
| inspiration | string | |
| v1Scope | string | |
| stage | enum | IDLE · IDEA · RESEARCH · PLANNING · BUILDING · TESTING · DEPLOYED · ITERATING · COMPLETED · ARCHIVED |
| repositoryUrl | string | |

`name` is the only field the importer refuses to invent. Without it the create is
rejected `422 EXTRACTION_ERROR`.

The writer builds its insert from this discovered list rather than a hand-written
list, so a column added to the schema later is stored instead of silently dropped.
`backend/tests/import.test.ts` pins this with a test that maps `repositoryUrl` and
`targetUsers` and asserts both arrive.

---

## C. Child entities the importer can create

The importer creates records for exactly these **12** concepts. This list is the
allowlist enforced at create time (`EXTRACTABLE_ENTITIES` in `extract.ts`, checked in
`mapping.ts`).

| entity | model → table | project FK | nested FK (never from text) | code prefix | taggable |
| --- | --- | --- | --- | --- | --- |
| research | ResearchEntry → research_entries | projectId | — | — | yes |
| research-questions | ResearchQuestion → research_questions | projectId | — | — | no |
| requirements | Requirement → requirements | projectId | — | REQ | no |
| features | Feature → features | projectId | — | — | no |
| tech-stack | TechStackItem → tech_stack | projectId | — | — | no |
| decisions | ArchitectureDecision → architecture_decisions | projectId | supersededById | ADR | no |
| database-tables | DatabaseTable → database_tables | projectId | — | — | no |
| api-endpoints | ApiEndpoint → api_endpoints | projectId | — | — | no |
| milestones | Milestone → milestones | projectId | — | — | no |
| tasks | Task → tasks | projectId | milestoneId | TASK | yes |
| issues | Issue → issues | projectId | — | ISSUE | yes |
| notes | Note → notes | projectId | — | — | yes |

---

## D. What the importer never writes

Present in the schema, deliberately unreachable from a document import:

| kind | fields | why |
| --- | --- | --- |
| Project system fields | `slug`, `isArchived`, `archivedAt`, `createdAt`, `updatedAt` | slug is generated and de-duplicated; the rest are the app's |
| Project provenance | `originalIdea` | written by the importer itself with the source metadata, not from document text |
| Child system fields | `id`, `createdAt`, `updatedAt` | database-managed |
| Child relation FKs | `projectId`, and all nested `milestoneId` / `taskId` / `featureId` / `requirementId` / `supersededById` / `finalVersionId` | resolved from the parent record, never parsed out of prose |
| Non-extractable tables | `PromptVersion`, `ProjectDocumentVersion`, `FeatureRequirement`, `Attachment`, `PromptGeneration` | schema has them, extraction never produces them |

**Attachments are the sharpest case.** `Attachment.storagePath` would point at a file
on disk, and no file is ever stored. The create endpoint takes a client-supplied draft,
so a hand-edited draft could have asked for `attachments` with an arbitrary
`storagePath`. The allowlist in C closes this: `attachments` is not extractable, so it
is refused with a reason and no row is written. Pinned by
*"refuses entities the importer never extracts, even in a hand-edited draft"*.

---

## E. Provenance, confidence, evidence and horizon

Every extracted field and record carries:

- `provenance` — `explicit` (the document states it) or `inferred` (derived from a heading or convention)
- `confidence` — 0..1
- `evidence` — the exact source line, shown in the review UI
- `horizon` — `v1`, `future`, or `unscoped`

Defaults applied when a document is silent are marked `inferred`, never `explicit`:
requirement `status`/`priority`, task `status`, issue `status`, milestone `status`.

V1 vs future is decided from the section heading (`V1 Scope`, `MVP`, `Phase 1` → v1;
`Future`, `Later`, `Roadmap`, `Phase 2+` → future) **and** from leading phrases on the
line itself. A `future`-marked line inside a V1 section is dropped rather than stored as
V1. "Not in V1" statements are recognised as exclusions, not as V1 content.

`missingRequired` lists project fields the document never mentioned, so the review
screen can show gaps rather than presenting a sparse form as complete.

---

## F. Duplicates, unsupported concepts, and honest reporting

**Duplicates are document-local only.** Two requirements in the same upload that say
the same thing collapse; an identical requirement in a *different, pre-existing* project
is never touched and never consulted. Detection normalises case and punctuation, drops
stop words, and matches on token overlap (≥0.82, or ≥0.90 containment with ≥3 shared
tokens, so a short item is never merged on one common word). Collapsed rows are kept in
the draft marked `duplicateOf` and shown greyed out, not deleted.

**Unsupported concepts are reported, never invented.** Concepts a PRD often contains
that Project Hub has no structure for (personas, competitors, business model, KPIs,
monetisation, compliance, screenshots, wireframes) are returned in `unsupported` with
the reason. The importer does not create a table, a column, or a free-text dumping
ground to absorb them.

**Values the schema cannot hold** are reported instead of coerced into something wrong:
an unknown column becomes an `unmapped` entry, an undeclared enum value becomes an
`unmapped` entry. If a schema default then fills the column, the review screen shows
what was dropped and why — the value the user typed is not what gets stored, and they
are told.

---

## G. Validation, error categories and transaction behaviour

| category | status | when |
| --- | --- | --- |
| `DOCUMENT_ERROR` | 400 / 415 | unsupported extension, empty file, over 15 MiB, unreadable DOCX/PDF, no text layer in a PDF |
| `EXTRACTION_ERROR` | 422 | no project name could be found; draft has no usable content |
| `MAPPING_ERROR` | 422 | draft shape is not what the importer expects |
| `DATABASE_ERROR` | 500 | the write failed; nothing was committed |

`analyze` performs **no database writes at all**. `create` wraps the project, every
child, tags, resource hooks and the activity row in a single `prisma.$transaction`.
The response is built from the transaction's own returned project, so it can never
describe a different project than the one written. Any failure rolls the whole import
back and surfaces as `DATABASE_ERROR` with no partial project.

`create` accepts **no `projectId`**. It cannot target an existing project, so there is
no code path by which an import modifies one. The activity row records filename,
format, sha256, byte size, record count and per-entity counts, so an import is always
traceable afterwards.

---

## H. API surface, review UI, and manual creation

| route | purpose |
| --- | --- |
| `GET /api/import/capabilities` | accepted formats, max size, entity list, limits |
| `POST /api/import/analyze` | multipart upload → review draft. No writes |
| `POST /api/import/create` | validated draft → one new project |

The review screen is three steps: choose/upload → review and edit → created. Every field
is editable, every record can be included or excluded, and excluded rows stay visible
and can be restored. Records keep their position for the whole review, so `duplicateOf`
pointers stay correct after an edit. A rejection closes the wizard and writes nothing.

Manual project creation is unchanged. The chooser sits beside it as a sibling action;
the import modal is never nested inside the manual modal.

---

## I. Database safety evidence

Baseline `backend/baseline-before.json`, captured before any importer code existed:
6 projects (IDs 166–171), 90 project field values, per-project child counts for 6
projects across 24 tables, and 27 global child totals.

Comparison performed after the full test suite (82 tests: 46 pre-existing + 36 importer):

```
projects: 6 (baseline 6), 0 new
project fields compared:      90
per-project child counts:     144
global child counts:          27
import artefacts:             0
DRIFT: none
```

| check | result |
| --- | --- |
| Existing projects still present | 6 / 6, IDs and slugs unchanged |
| Existing project field values | 90 / 90 identical, including `updatedAt` timestamps |
| Per-project child counts | 144 / 144 identical |
| Global child counts | 27 / 27 identical |
| Records modified or deleted | 0 |
| Projects created by tests and left behind | 0 |
| Schema migrations added by this feature | 0 |

**Additive, non-project row worth stating plainly:** the `tag` table holds 17 rows
against a baseline of 15. The 2 extra rows are `alpha` and `beta`, created by the
**pre-existing** `tests/api.test.ts:101`, not by the importer — the importer's own tests
pass `tags: []`. Both rows are unreferenced: no `TagAssignment` points at them, and no
existing project or record was changed. `TagAssignment` count is unchanged at 25. Six
unreferenced tag rows exist in total (`flask`, `android`, `bluetooth`, `postgres`,
`alpha`, `beta`); four of them predate this feature.

---

## Test coverage added — `backend/tests/import.test.ts`, 36 tests

- **discovery** reads the live schema: project fields, entity list, enum values, no relation FKs offered as content fields
- **parsing**: txt, markdown, json, docx, pdf path, size limit, unsupported extension, empty file
- **extraction**: name recovery, explicit vs inferred provenance, evidence lines, v1/future split, "not in V1", document-local dedup, unsupported-concept reporting, missing-required reporting
- **mapping**: rejects an unknown project field, an unknown child column, an undeclared enum value, an entity the importer never extracts; applies limits; keeps values the schema really declares
- **API**: analyze writes nothing; a missing name is `422 EXTRACTION_ERROR`; create makes exactly one project with coded children and sha256 provenance; a Postgres-invalid value rolls the entire import back with `DATABASE_ERROR` and no partial project; the entity allowlist holds against a hand-edited draft; pre-existing projects are byte-identical afterwards
