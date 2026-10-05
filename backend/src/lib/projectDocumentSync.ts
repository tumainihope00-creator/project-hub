import { createHash } from 'node:crypto';
import {
  Prisma,
  Priority,
  RequirementType,
  RequirementStatus,
  FeatureStatus,
  ResearchType,
  ResearchQuestionStatus,
  ADRStatus,
  TechCategory,
  MilestoneStatus,
  TaskStatus,
  IssueSeverity,
  IssueStatus
} from '@prisma/client';
import { prisma } from './prisma.js';
import { loadProjectDocumentData, renderProjectDocument } from './projectDocument.js';
import {
  ParsedProjectDocument,
  ParsedRecord,
  splitCodeAndTitle,
  splitEndpointTitle,
  attributeValue,
  bareAttributes,
  enumToken,
  isTruncated
} from './projectDocumentParser.js';

/**
 * Phase 6, part two: turn a parsed PROJECT.md into a deterministic change set and
 * apply it inside one transaction.
 *
 * The rules this file exists to enforce, in order of importance:
 *
 *  1. Nothing is applied unless the front matter proved the file belongs to this
 *     project and uses a document version this build understands.
 *  2. A child record is identified by a *stable key*, never by its position in the
 *     list: the `code` for requirements, tasks, issues and ADRs; the name for
 *     features, notes, milestones, tech stack items and database tables; the
 *     question for research questions; the title for research entries; and
 *     `METHOD + path` for API endpoints. Reordering a document changes nothing.
 *  3. Only fields the document actually expresses are written. A missing section
 *     or field leaves the database exactly as it is: absence is never a request to
 *     clear a value.
 *  4. Database records with no counterpart in the document are reported, never
 *     deleted. This document format has no way to say "delete me", so Phase 6 does
 *     not delete. See DELETION SAFETY below.
 *  5. A title the generator shortened (it ends in the ellipsis) is a display value.
 *     It can match a record but is never written back, so a round trip cannot
 *     replace a full title with a truncated one.
 *
 * DELETION SAFETY. The Phase 4 format lists records that exist; it has no marker
 * for a record the author intends to remove. Deleting every database record missing
 * from the file would let a truncated or hand-edited document silently destroy
 * years of history. So `unmatchedDatabaseRecords` is a report, and there is no
 * delete code path in this module at all.
 *
 * FIELD FIDELITY. Some sections concatenate several database columns into one
 * indented detail block (ADRs join decision/context/reasoning/consequences; API
 * endpoints join description/requestBody/response/notes; issues join
 * description/expectedBehavior/actualBehavior/solution). Those joins are not
 * reversible: there is no delimiter that survives free text. Those entities
 * therefore synchronize their structured attributes only, and their detail block
 * is reported as preserved-but-not-synchronized. Writing the joined blob into a
 * single column would overwrite four columns with one, which is data loss.
 */

/** sha256 of a UTF-8 string: the single hashing primitive used everywhere here. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface SyncIssue {
  code: string;
  message: string;
}

export interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

export type EntityKey =
  | 'research'
  | 'researchQuestions'
  | 'requirements'
  | 'features'
  | 'decisions'
  | 'techStack'
  | 'tables'
  | 'endpoints'
  | 'milestones'
  | 'tasks'
  | 'issues'
  | 'notes';

export interface ChildChange {
  entity: EntityKey;
  action: 'create' | 'update';
  key: string;
  label: string;
  changes: { field: string; from: unknown; to: unknown }[];
}

export interface UnmatchedRecord {
  entity: EntityKey;
  key: string;
  label: string;
}

export interface ChangeSet {
  projectId: number;
  projectName: string;
  /** sha256 of the file bytes read from disk. */
  documentHash: string;
  /** The document version the file declares. */
  documentVersion: number | null;
  /** True when the file is byte-identical to the last generate/sync. */
  unchanged: boolean;
  /** True when this is the first time this project has been synchronized. */
  firstSynchronization: boolean;
  /** True when the database changed after the last sync. */
  conflict: boolean;
  projectChanges: FieldChange[];
  childChanges: ChildChange[];
  unmatchedDatabaseRecords: UnmatchedRecord[];
  warnings: SyncIssue[];
  errors: SyncIssue[];
  unsupportedSections: string[];
  unknownSections: string[];
  /** Section content deliberately not synchronized, with the reason. */
  preservedDetailSections: { section: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s;
}

/** Equality that ignores trailing whitespace only. Blank vs null is a real change. */
function sameValue(a: unknown, b: unknown): boolean {
  const na = asText(a);
  const nb = asText(b);
  const ta = na === null ? null : na.replace(/\s+$/, '');
  const tb = nb === null ? null : nb.replace(/\s+$/, '');
  return ta === tb;
}

function asDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Entity specifications
// ---------------------------------------------------------------------------

interface ChildSpec {
  entity: EntityKey;
  /** Human name used in messages and the preview UI. */
  label: string;
  /** Stable identity from a parsed record, or null when it has none. */
  key(rec: ParsedRecord): string | null;
  /** Stable identity from a database row. */
  rowKey(row: any): string;
  /** DB column holding the display title/identity text, when the document can set it. */
  titleColumn: 'title' | 'name' | 'question' | 'technology' | null;
  /**
   * The columns this entity synchronizes from the document, as document-derived
   * values keyed by column name. Omitted columns are left untouched.
   */
  values(rec: ParsedRecord, warnings: SyncIssue[]): Record<string, string | Date | null>;
  /** Columns whose value must be one of a Prisma enum's members. */
  enums?: Record<string, readonly string[]>;
  /** Prisma relation name / delegate for writes. */
  delegate: 'researchEntry' | 'researchQuestion' | 'requirement' | 'feature' | 'architectureDecision' | 'techStackItem' | 'databaseTable' | 'apiEndpoint' | 'milestone' | 'task' | 'issue' | 'note';
}

function enumOr(
  raw: string | null | undefined,
  allowed: readonly string[],
  fallback: string,
  entityLabel: string,
  field: string,
  warnings: SyncIssue[]
): string {
  const token = enumToken(raw ?? '');
  if (allowed.includes(token)) return token;
  if (raw == null || raw.trim() === '') return fallback;
  warnings.push({
    code: 'UNRECOGNISED_ENUM_VALUE',
    message: `${entityLabel} ${field} value ${JSON.stringify(raw)} is not one of ${allowed.join(', ')}. It was left unchanged.`
  });
  // Return a sentinel the caller must not write: an empty string means "skip".
  return '';
}

/** Strip the generator's `**CODE**` prefix and surrounding markdown emphasis. */
function plainTitle(rec: ParsedRecord): string {
  const { title } = splitCodeAndTitle(rec.title);
  return title.replace(/^[`*_]+|[`*_]+$/g, '').trim();
}

const PRIORITIES = Object.values(Priority) as string[];

const SPECS: ChildSpec[] = [
  {
    entity: 'research',
    label: 'Research entry',
    delegate: 'researchEntry',
    titleColumn: 'title',
    key: (rec) => plainTitle(rec) || null,
    rowKey: (row) => row.title,
    enums: { type: Object.values(ResearchType) as string[] },
    values: (rec, warnings) => {
      const [type, date] = bareAttributes(rec.attributes, ['Priority']);
      const out: Record<string, string | Date | null> = {};
      // The generator writes `r.summary || r.findings`, so the detail block holds
      // whichever one is set. It is stored as `summary`; `findings` is left alone.
      const detailType = enumOr(type, Object.values(ResearchType) as string[], 'OTHER', 'Research entry', 'type', warnings);
      if (detailType) out.type = detailType;
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        warnings.push({
          code: 'UNPARSEABLE_DATE',
          message: `Research entry date ${JSON.stringify(date)} is not YYYY-MM-DD and was ignored.`
        });
      } else if (date) {
        out.date = asDate(date);
      }
      if (rec.detail != null) out.summary = rec.detail;
      return out;
    }
  },
  {
    entity: 'researchQuestions',
    label: 'Research question',
    delegate: 'researchQuestion',
    titleColumn: 'question',
    key: (rec) => plainTitle(rec) || null,
    rowKey: (row) => row.question,
    enums: { status: Object.values(ResearchQuestionStatus) as string[] },
    values: (rec, warnings) => {
      const [status, category] = rec.attributes;
      const out: Record<string, string | Date | null> = {};
      const s = enumOr(status, Object.values(ResearchQuestionStatus) as string[], 'OPEN', 'Research question', 'status', warnings);
      if (s) out.status = s;
      if (category) out.category = category;
      if (rec.detail != null) out.answer = rec.detail;
      return out;
    }
  },
  {
    entity: 'requirements',
    label: 'Requirement',
    delegate: 'requirement',
    titleColumn: 'title',
    key: (rec) => splitCodeAndTitle(rec.title).code,
    rowKey: (row) => row.code,
    enums: {
      type: Object.values(RequirementType) as string[],
      priority: PRIORITIES,
      status: Object.values(RequirementStatus) as string[]
    },
    values: (rec, warnings) => {
      const out: Record<string, string | Date | null> = {};
      const type = enumOr(bareAttributes(rec.attributes, ['Priority'])[0], Object.values(RequirementType) as string[], 'FUNCTIONAL', 'Requirement', 'type', warnings);
      const priority = enumOr(attributeValue(rec.attributes, 'Priority'), PRIORITIES, 'MEDIUM', 'Requirement', 'priority', warnings);
      const status = enumOr(bareAttributes(rec.attributes, ['Priority'])[1], Object.values(RequirementStatus) as string[], 'PROPOSED', 'Requirement', 'status', warnings);
      if (type) out.type = type;
      if (priority) out.priority = priority;
      if (status) out.status = status;
      if (rec.detail != null) out.description = rec.detail;
      return out;
    }
  },
  {
    entity: 'features',
    label: 'Feature',
    delegate: 'feature',
    titleColumn: 'name',
    key: (rec) => plainTitle(rec) || null,
    rowKey: (row) => row.name,
    enums: { priority: PRIORITIES, status: Object.values(FeatureStatus) as string[] },
    values: (rec, warnings) => {
      const out: Record<string, string | Date | null> = {};
      const priority = enumOr(attributeValue(rec.attributes, 'Priority'), PRIORITIES, 'MEDIUM', 'Feature', 'priority', warnings);
      const status = enumOr(bareAttributes(rec.attributes, ['Priority'])[0], Object.values(FeatureStatus) as string[], 'PLANNED', 'Feature', 'status', warnings);
      if (priority) out.priority = priority;
      if (status) out.status = status;
      if (rec.detail != null) out.description = rec.detail;
      return out;
    }
  },
  {
    entity: 'decisions',
    label: 'Architecture decision',
    delegate: 'architectureDecision',
    titleColumn: 'title',
    key: (rec) => splitCodeAndTitle(rec.title).code,
    rowKey: (row) => row.code,
    enums: { status: Object.values(ADRStatus) as string[] },
    values: (rec, warnings) => {
      const out: Record<string, string | Date | null> = {};
      const status = enumOr(rec.attributes[0], Object.values(ADRStatus) as string[], 'PROPOSED', 'Architecture decision', 'status', warnings);
      if (status) out.status = status;
      // decision/context/reasoning/consequences are joined into one block and are
      // NOT synchronized. See FIELD FIDELITY above.
      return out;
    }
  },
  {
    entity: 'techStack',
    label: 'Technology stack item',
    delegate: 'techStackItem',
    titleColumn: 'technology',
    key: (rec) => plainTitle(rec) || null,
    rowKey: (row) => row.technology,
    enums: { category: Object.values(TechCategory) as string[] },
    values: (rec, warnings) => {
      const out: Record<string, string | Date | null> = {};
      const category = enumOr(bareAttributes(rec.attributes, ['Priority'])[0], Object.values(TechCategory) as string[], 'OTHER', 'Technology stack item', 'category', warnings);
      if (category) out.category = category;
      const version = bareAttributes(rec.attributes, ['Priority'])[1];
      if (version) out.version = version;
      if (rec.detail != null) out.notes = rec.detail;
      return out;
    }
  },
  {
    entity: 'tables',
    label: 'Database table',
    delegate: 'databaseTable',
    titleColumn: 'name',
    key: (rec) => plainTitle(rec) || null,
    rowKey: (row) => row.name,
    values: (rec): Record<string, string | Date | null> =>
      rec.detail != null ? { purpose: rec.detail } : {}
  },
  {
    entity: 'endpoints',
    label: 'API endpoint',
    delegate: 'apiEndpoint',
    titleColumn: null,
    key: (rec) => {
      const ep = splitEndpointTitle(rec.title);
      return ep ? `${ep.method} ${ep.path}` : null;
    },
    rowKey: (row) => `${row.method} ${row.path}`,
    values: () => ({
      // description/requestBody/response/notes are joined into one block and are
      // NOT synchronized. See FIELD FIDELITY above.
    })
  },
  {
    entity: 'milestones',
    label: 'Milestone',
    delegate: 'milestone',
    titleColumn: 'name',
    key: (rec) => plainTitle(rec) || null,
    rowKey: (row) => row.name,
    enums: { status: Object.values(MilestoneStatus) as string[] },
    values: (rec, warnings) => {
      const out: Record<string, string | Date | null> = {};
      const status = enumOr(bareAttributes(rec.attributes, ['Priority'])[0], Object.values(MilestoneStatus) as string[], 'PLANNED', 'Milestone', 'status', warnings);
      if (status) out.status = status;
      const target = attributeValue(rec.attributes, 'Target');
      if (target) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
          warnings.push({ code: 'UNPARSEABLE_DATE', message: `Milestone target ${JSON.stringify(target)} is not YYYY-MM-DD and was ignored.` });
        } else {
          out.targetDate = asDate(target);
        }
      }
      if (rec.detail != null) out.description = rec.detail;
      return out;
    }
  },
  {
    entity: 'tasks',
    label: 'Task',
    delegate: 'task',
    titleColumn: 'title',
    key: (rec) => splitCodeAndTitle(rec.title).code,
    rowKey: (row) => row.code,
    enums: {
      status: Object.values(TaskStatus) as string[],
      priority: PRIORITIES
    },
    values: (rec, warnings) => {
      const out: Record<string, string | Date | null> = {};
      const status = enumOr(bareAttributes(rec.attributes, ['Priority'])[0], Object.values(TaskStatus) as string[], 'TODO', 'Task', 'status', warnings);
      const priority = enumOr(attributeValue(rec.attributes, 'Priority'), PRIORITIES, 'MEDIUM', 'Task', 'priority', warnings);
      if (status) out.status = status;
      if (priority) out.priority = priority;
      const due = attributeValue(rec.attributes, 'Due');
      if (due) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
          warnings.push({ code: 'UNPARSEABLE_DATE', message: `Task due date ${JSON.stringify(due)} is not YYYY-MM-DD and was ignored.` });
        } else {
          out.dueDate = asDate(due);
        }
      }
      if (rec.detail != null) out.description = rec.detail;
      return out;
    }
  },
  {
    entity: 'issues',
    label: 'Issue',
    delegate: 'issue',
    titleColumn: 'title',
    key: (rec) => splitCodeAndTitle(rec.title).code,
    rowKey: (row) => row.code,
    enums: {
      status: Object.values(IssueStatus) as string[],
      severity: Object.values(IssueSeverity) as string[],
      priority: PRIORITIES
    },
    values: (rec, warnings) => {
      const out: Record<string, string | Date | null> = {};
      const status = enumOr(bareAttributes(rec.attributes, ['Priority'])[0], Object.values(IssueStatus) as string[], 'OPEN', 'Issue', 'status', warnings);
      const severity = enumOr(attributeValue(rec.attributes, 'Severity'), Object.values(IssueSeverity) as string[], 'MEDIUM', 'Issue', 'severity', warnings);
      if (status) out.status = status;
      if (severity) out.severity = severity;
      // description/expectedBehavior/actualBehavior/solution are joined into one
      // block and are NOT synchronized. See FIELD FIDELITY above.
      return out;
    }
  },
  {
    entity: 'notes',
    label: 'Note',
    delegate: 'note',
    titleColumn: 'title',
    key: (rec) => plainTitle(rec) || null,
    rowKey: (row) => row.title ?? '',
    values: (rec): Record<string, string | Date | null> =>
      rec.detail != null ? { content: rec.detail } : {}
  }
];

/** Sections whose detail block joins several columns and is therefore not written. */
const PRESERVED_DETAIL: { section: string; reason: string }[] = [
  {
    section: 'Architecture Decisions',
    reason: 'The decision, context, reasoning and consequences are written into one block with no separator that survives free text, so this block is shown but never written back.'
  },
  {
    section: 'API Endpoints',
    reason: 'Description, request body, response and notes are written into one block with no reversible separator, so this block is shown but never written back.'
  },
  {
    section: 'Issues',
    reason: 'Description, expected behaviour, actual behaviour and solution are written into one block with no reversible separator, so this block is shown but never written back.'
  }
];

/** Sections that exist in the format but are out of scope for Phase 6. */
const OUT_OF_SCOPE_SECTIONS: Record<string, string> = {
  'Project Status': 'Status is owned by STATUS.md and projects.stage. This phase never changes a lifecycle stage.',
  Deployment: 'Deployment history is written by the app, not from this document.',
  'Development Sessions': 'Session history is recorded by Project Hub.',
  'Git References': 'Git references are recorded by Project Hub.',
  Tags: 'Tags are managed on the project record.'
};

// ---------------------------------------------------------------------------
// Core field mapping
// ---------------------------------------------------------------------------

const CORE_COLUMNS: { key: string; column: string }[] = [
  { key: 'description', column: 'description' },
  { key: 'problem', column: 'problem' },
  { key: 'motivation', column: 'motivation' },
  { key: 'targetUsers', column: 'targetUsers' },
  { key: 'expectedValue', column: 'expectedValue' }
];

const PROSE_COLUMNS: { heading: string; column: string }[] = [
  { heading: 'V1 Scope', column: 'v1Scope' },
  { heading: 'Assumptions', column: 'assumptions' },
  { heading: 'Initial Questions', column: 'initialQuestions' },
  { heading: 'Inspiration', column: 'inspiration' }
];

/** Columns the document is never allowed to write, whatever it contains. */
const PROTECTED_PROJECT_COLUMNS = new Set([
  'id',
  'slug',
  'name',
  'originalIdea',
  'stage',
  'isArchived',
  'archivedAt',
  'folderName',
  'folderPath',
  'createdAt',
  'projectDocumentHash',
  'projectDocumentStateHash',
  'projectDocumentSyncedAt'
]);

// ---------------------------------------------------------------------------
// Change-set construction
// ---------------------------------------------------------------------------

export interface SyncProjectRow {
  id: number;
  name: string;
  projectDocumentHash: string | null;
  projectDocumentStateHash: string | null;
  projectDocumentSyncedAt: Date | null;
}

/**
 * Compare one parsed record against its database row.
 *
 * `spec.values` yields only the columns the document expresses. A column is
 * reported as changed when the document's value differs from the row's. An empty
 * string in the derived values means "the document said something we could not
 * use" (an unknown enum) and is skipped rather than written.
 */
function diffRecord(
  spec: ChildSpec,
  rec: ParsedRecord,
  row: any | null,
  warnings: SyncIssue[]
): ChildChange | null {
  const key = spec.key(rec);
  if (key === null) {
    warnings.push({
      code: 'RECORD_NOT_IDENTIFIABLE',
      message: `A ${spec.label.toLowerCase()} entry could not be matched to a stable identifier and was skipped: ${JSON.stringify(rec.title)}`
    });
    return null;
  }

  const label = plainTitle(rec) || key;
  const values = spec.values(rec, warnings);

  // Creating: every expressed value is a change from nothing.
  if (!row) {
    const changes = Object.entries(values)
      .filter(([, v]) => v !== '' && v != null)
      .map(([field, to]) => ({ field, from: null as unknown, to }));
    // The identity column is mandatory on insert and is not one of `values` for
    // code-keyed entities, so it is added from the key itself. Without it Prisma
    // rejects the insert ("Argument `code` is missing") and the whole transaction
    // rolls back.
    if (!changes.some(c => c.field === IDENTITY_COLUMN[spec.entity])) {
      changes.push({ field: IDENTITY_COLUMN[spec.entity], from: null, to: key });
    }
    if (spec.titleColumn && values.title === undefined) {
      // Name-keyed entities: the key IS the title, so it is the same string and the
      // column still has to be set. Code-keyed entities: the title is a separate,
      // genuinely expressed column, so it is written too, except when the generator
      // truncated it.
      if (spec.key(rec) === plainTitle(rec) || !isTruncated(plainTitle(rec))) {
        changes.push({ field: spec.titleColumn, from: null, to: label });
      }
    }
    if (changes.length === 0) return null;
    return { entity: spec.entity, action: 'create', key, label, changes };
  }

  const changes: { field: string; from: unknown; to: unknown }[] = [];

  for (const [field, value] of Object.entries(values)) {
    if (value === '' || value === null) continue; // not expressed / unusable
    if (field === 'title' || field === spec.titleColumn) {
      // A truncated title is display-only. Writing it would shorten a real title.
      if (isTruncated(String(value))) continue;
    }
    if (field === 'date' || field === 'targetDate' || field === 'dueDate') {
      const current = row[field] ? new Date(row[field]).getTime() : null;
      const next = (value as Date).getTime();
      if (current !== next) {
        changes.push({ field, from: row[field] ? new Date(row[field]).toISOString() : null, to: new Date(next).toISOString() });
      }
      continue;
    }
    if (!sameValue(row[field], value)) {
      changes.push({ field, from: asText(row[field]), to: asText(value) });
    }
  }

  if (changes.length === 0) return null;
  return { entity: spec.entity, action: 'update', key, label, changes };
}

/**
 * Build the deterministic change set for a document against the current database.
 *
 * `content` must be the exact bytes read from disk; it is what gets hashed.
 * Nothing here writes to the database, so it is safe to call for a preview.
 */
export function buildChangeSet(
  project: SyncProjectRow,
  parsed: ParsedProjectDocument,
  content: string,
  data: Awaited<ReturnType<typeof loadProjectDocumentData>>
): ChangeSet {
  const warnings: SyncIssue[] = [];
  const errors: SyncIssue[] = [];

  for (const w of parsed.warnings) warnings.push({ code: 'PARSE_WARNING', message: w });
  for (const e of parsed.errors) errors.push({ code: 'PARSE_ERROR', message: e });

  // Ownership check. A document belonging to another project is refused outright:
  // this is what stops one project's file from being applied to another.
  if (parsed.projectIdFromDocument != null && parsed.projectIdFromDocument !== project.id) {
    errors.push({
      code: 'PROJECT_ID_MISMATCH',
      message: `This PROJECT.md belongs to project ${parsed.projectIdFromDocument}, not project ${project.id} (${project.name}). Nothing was applied.`
    });
  }

  const documentHash = hashContent(content);
  const unchanged = project.projectDocumentHash === documentHash;
  const firstSynchronization = project.projectDocumentHash == null;

  // Conflict detection: has the database moved since the last sync?
  const renderedNow = renderProjectDocument(data);
  const currentStateHash = hashContent(renderedNow);
  const conflict =
    !firstSynchronization &&
    project.projectDocumentStateHash != null &&
    project.projectDocumentStateHash !== currentStateHash;

  // ---- project row ----
  const projectChanges: FieldChange[] = [];
  const dbProject = data.project as unknown as Record<string, unknown>;
  for (const { key, column } of CORE_COLUMNS) {
    if (!(key in parsed.coreFields)) continue;
    const next = parsed.coreFields[key];
    if (!sameValue(dbProject[column], next)) {
      projectChanges.push({ field: column, from: asText(dbProject[column]), to: next });
    }
  }
  for (const { heading, column } of PROSE_COLUMNS) {
    const value = parsed.proseFields[heading];
    if (value === undefined || value === '') continue;
    if (!sameValue(dbProject[column], value)) {
      projectChanges.push({ field: column, from: asText(dbProject[column]), to: value });
    }
  }
  if (parsed.repositoryUrl != null && !sameValue(dbProject.repositoryUrl, parsed.repositoryUrl)) {
    projectChanges.push({
      field: 'repositoryUrl',
      from: asText(dbProject.repositoryUrl as string),
      to: parsed.repositoryUrl
    });
  }
  for (const c of projectChanges) {
    if (PROTECTED_PROJECT_COLUMNS.has(c.field)) {
      errors.push({ code: 'PROTECTED_FIELD', message: `Refusing to write the protected column ${c.field}.` });
    }
  }
  projectChanges.sort((a, b) => a.field.localeCompare(b.field));

  // ---- child records ----
  const childChanges: ChildChange[] = [];
  const unmatchedDatabaseRecords: UnmatchedRecord[] = [];
  const seenKeys = new Map<string, Set<string>>();

  for (const spec of SPECS) {
    const sectionName = SECTION_FOR_ENTITY[spec.entity];
    const records = parsed.records[sectionName];
    if (records === undefined) continue; // section absent: leave the entity alone

    const rows: any[] = (data as any)[spec.entity === 'decisions' ? 'decisions' : spec.entity] ?? [];
    const rowsByKey = new Map<string, any>();
    for (const row of rows) {
      const k = spec.rowKey(row);
      if (!rowsByKey.has(k)) rowsByKey.set(k, row);
      else {
        warnings.push({
          code: 'DUPLICATE_DATABASE_IDENTITY',
          message: `The database has more than one ${spec.label.toLowerCase()} with the key ${JSON.stringify(k)}. Only the first was matched.`
        });
      }
    }

    const matched = new Set<string>();
    for (const rec of records) {
      const key = spec.key(rec);
      if (key !== null) {
        const bucket = seenKeys.get(spec.entity) ?? new Set<string>();
        if (bucket.has(key)) {
          errors.push({
            code: 'DUPLICATE_DOCUMENT_IDENTITY',
            message: `The document lists ${spec.label.toLowerCase()} ${JSON.stringify(key)} more than once. Remove the duplicate before synchronizing; nothing was applied.`
          });
          continue;
        }
        bucket.add(key);
        seenKeys.set(spec.entity, bucket);
      }
      const row = key !== null ? rowsByKey.get(key) ?? null : null;
      const change = diffRecord(spec, rec, row, warnings);
      if (change) childChanges.push(change);
      if (key !== null) matched.add(key);
    }

    // Records in the database with no counterpart in the document: reported only.
    for (const [k, row] of rowsByKey) {
      if (!matched.has(k)) {
        unmatchedDatabaseRecords.push({
          entity: spec.entity,
          key: k,
          label: spec.titleColumn ? String(row[spec.titleColumn] ?? k) : k
        });
      }
    }
  }

  if (unmatchedDatabaseRecords.length > 0) {
    warnings.push({
      code: 'UNMATCHED_DATABASE_RECORDS',
      message: `${unmatchedDatabaseRecords.length} database record(s) have no counterpart in the document. They were left untouched: this document format cannot express a deletion, so Project Hub never deletes from it.`
    });
  }

  const unsupportedSections = [...parsed.unsupportedSections];
  for (const s of parsed.unknownSections) {
    warnings.push({ code: 'UNKNOWN_SECTION', message: `Section "## ${s}" is not part of the PROJECT.md format and was ignored.` });
  }
  for (const s of parsed.unsupportedSections) {
    warnings.push({
      code: 'UNSUPPORTED_SECTION',
      message: `"## ${s}" was ignored. ${OUT_OF_SCOPE_SECTIONS[s] ?? 'This section is not synchronized in this phase.'}`
    });
  }

  return {
    projectId: project.id,
    projectName: project.name,
    documentHash,
    documentVersion: parsed.documentVersion,
    unchanged,
    firstSynchronization,
    conflict,
    projectChanges,
    childChanges,
    unmatchedDatabaseRecords,
    warnings,
    errors,
    unsupportedSections,
    unknownSections: parsed.unknownSections,
    preservedDetailSections: PRESERVED_DETAIL
  };
}

/** Entity -> the section heading it is read from. */
const SECTION_FOR_ENTITY: Record<EntityKey, string> = {
  research: 'Research',
  researchQuestions: 'Research Questions',
  requirements: 'Requirements',
  features: 'Features',
  decisions: 'Architecture Decisions',
  techStack: 'Technology Stack',
  tables: 'Database Tables',
  endpoints: 'API Endpoints',
  milestones: 'Milestones',
  tasks: 'Tasks',
  issues: 'Issues',
  notes: 'Notes'
};

// ---------------------------------------------------------------------------
// Applying a change set
// ---------------------------------------------------------------------------

export interface SyncResult {
  projectId: number;
  documentHash: string;
  /** Hash of the document as re-rendered from the database after the sync. */
  resultingStateHash: string;
  appliedProjectChanges: FieldChange[];
  appliedChildChanges: { entity: EntityKey; action: 'create' | 'update'; key: string; label: string }[];
  unmatchedDatabaseRecords: UnmatchedRecord[];
  warnings: SyncIssue[];
  syncedAt: string;
}

/**
 * Apply a change set inside a single transaction.
 *
 * Every write for one synchronization runs inside one `prisma.$transaction`, so a
 * failure on any record rolls the whole thing back: there is no state where half
 * the document landed. The activity row is written inside the same transaction, so
 * the log can never claim a synchronization that did not happen.
 *
 * The caller is responsible for having refused to build a change set with errors,
 * and for having forced `conflict` to be acknowledged. This function does not
 * second-guess that, but it does re-check ownership: the change set's project id
 * must match the row it is applied to.
 */
export async function applyChangeSet(
  projectId: number,
  changeSet: ChangeSet,
  options: { actor: string }
): Promise<SyncResult> {
  if (changeSet.projectId !== projectId) {
    throw new Error(
      `Refusing to apply a change set built for project ${changeSet.projectId} to project ${projectId}.`
    );
  }
  if (changeSet.errors.length > 0) {
    throw new Error(
      `Refusing to apply a change set with ${changeSet.errors.length} error(s). Resolve them and preview again.`
    );
  }

  const appliedProjectChanges = [...changeSet.projectChanges];
  const appliedChildChanges: SyncResult['appliedChildChanges'] = [];

  await prisma.$transaction(async (tx) => {
    // 1. Project row.
    if (appliedProjectChanges.length > 0) {
      const data: Record<string, unknown> = {};
      for (const c of appliedProjectChanges) {
        if (PROTECTED_PROJECT_COLUMNS.has(c.field)) {
          throw new Error(`Refusing to write the protected column ${c.field}.`);
        }
        data[c.field] = c.to;
      }
      await tx.project.update({ where: { id: projectId }, data });
    }

    // 2. Child records.
    for (const change of changeSet.childChanges) {
      const spec = SPECS.find((s) => s.entity === change.entity)!;
      const delegate = (tx as any)[spec.delegate];

      if (change.action === 'create') {
        const createData: Record<string, unknown> = { projectId };
        for (const c of change.changes) createData[c.field] = c.to;
        await delegate.create({ data: createData });
        appliedChildChanges.push({
          entity: change.entity,
          action: 'create',
          key: change.key,
          label: change.label
        });
      } else {
        // Locate the existing row by its stable key, then update only the columns
        // the document expressed. The identity column is never rewritten.
        const where = identityWhere(spec, projectId, change.key);
        const updateData: Record<string, unknown> = {};
        for (const c of change.changes) {
          if (c.field === IDENTITY_COLUMN[spec.entity]) continue; // never rewrite identity
          updateData[c.field] = c.to;
        }
        const res = await delegate.updateMany({ where, data: updateData });
        if (res.count === 0) {
          throw new Error(`Could not locate the ${spec.label.toLowerCase()} with key ${change.key} to update it.`);
        }
        appliedChildChanges.push({
          entity: change.entity,
          action: 'update',
          key: change.key,
          label: change.label
        });
      }
    }

    // 3. Record the resulting state. The state hash is recomputed after the
    //    writes so that a subsequent conflict check compares like with like.
    const after = await loadProjectDocumentDataWithClient(tx, projectId);
    const resultingStateHash = hashContent(renderProjectDocument(after));
    await tx.project.update({
      where: { id: projectId },
      data: {
        projectDocumentHash: changeSet.documentHash,
        projectDocumentStateHash: resultingStateHash,
        projectDocumentSyncedAt: new Date()
      }
    });

    // 4. One activity row describing the synchronization, inside the transaction.
    await tx.activityEvent.create({
      data: {
        projectId,
        type: 'PROJECT_UPDATED',
        description:
          `Synchronized PROJECT.md into the project record: ${appliedProjectChanges.length} field(s), ` +
          `${appliedChildChanges.filter((c) => c.action === 'create').length} created, ` +
          `${appliedChildChanges.filter((c) => c.action === 'update').length} updated.`,
        metadata: JSON.stringify({
          source: 'PROJECT.md',
          documentHash: changeSet.documentHash,
          resultingStateHash,
          projectFields: appliedProjectChanges.map((c) => c.field),
          created: appliedChildChanges.filter((c) => c.action === 'create').map((c) => `${c.entity}:${c.key}`),
          updated: appliedChildChanges.filter((c) => c.action === 'update').map((c) => `${c.entity}:${c.key}`),
          warnings: changeSet.warnings.length,
          actor: options.actor
        })
      }
    });
  });

  const after = await loadProjectDocumentData(projectId);
  const resultingStateHash = hashContent(renderProjectDocument(after));

  return {
    projectId,
    documentHash: changeSet.documentHash,
    resultingStateHash,
    appliedProjectChanges,
    appliedChildChanges,
    unmatchedDatabaseRecords: changeSet.unmatchedDatabaseRecords,
    warnings: changeSet.warnings,
    syncedAt: new Date().toISOString()
  };
}

/** Build the `where` clause that finds one row by its stable key. */
function identityWhere(spec: ChildSpec, projectId: number, key: string) {
  const uniqueColumn = UNIQUE_IDENTITY_COLUMN[spec.entity];
  if (uniqueColumn) {
    return { projectId, [uniqueColumn]: key };
  }
  // API endpoints are identified by method *and* path. Keying the write on `path`
  // alone would let `POST /widgets` overwrite the `GET /widgets` row that shares
  // the path, because updateMany would match both.
  if (spec.entity === 'endpoints') {
    const parsed = splitEndpointKey(key);
    if (parsed) return { projectId, method: parsed.method, path: parsed.path };
    // An unparsable key can only be matched on path; that is all the document
    // expressed, and it is the conservative choice.
  }
  // For name/title-keyed entities there is no unique index on the key, so match on
  // the identity column the rowKey() reads. Every such entity has exactly one
  // obvious identity column.
  return { projectId, [IDENTITY_COLUMN[spec.entity]]: key };
}

/** Split the document's `METHOD /path` endpoint identity back into its parts. */
function splitEndpointKey(key: string): { method: string; path: string } | null {
  const parsed = splitEndpointTitle(key);
  return parsed ? { method: parsed.method, path: parsed.path } : null;
}

/** The column holding each entity's stable key. */
const IDENTITY_COLUMN: Record<EntityKey, string> = {
  research: 'title',
  researchQuestions: 'question',
  requirements: 'code',
  features: 'name',
  decisions: 'code',
  techStack: 'technology',
  tables: 'name',
  endpoints: 'path',
  milestones: 'name',
  tasks: 'code',
  issues: 'code',
  notes: 'title'
};

/** Entities whose identity column is enforced unique in the database. */
const UNIQUE_IDENTITY_COLUMN: Partial<Record<EntityKey, string>> = {
  requirements: 'code',
  tasks: 'code',
  issues: 'code',
  decisions: 'code'
};


/**
 * Load the document data using a transaction client, so post-write rendering sees
 * the writes.
 *
 * This mirrors `CHILD_ORDER` in `projectDocument.ts` and must include *every*
 * collection `renderProjectDocument` maps over, including the ones this phase never
 * synchronizes (deployments, development sessions, git references). They are read
 * only so the document can be re-rendered exactly as it would be outside the
 * transaction; omitting one makes the renderer throw.
 */
async function loadProjectDocumentDataWithClient(tx: Prisma.TransactionClient, projectId: number) {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    include: {
      requirements: { orderBy: { code: 'asc' } },
      features: { orderBy: [{ name: 'asc' }, { id: 'asc' }] },
      decisions: { orderBy: { code: 'asc' } },
      techStack: { orderBy: [{ category: 'asc' }, { technology: 'asc' }, { id: 'asc' }] },
      tables: { orderBy: [{ name: 'asc' }, { id: 'asc' }] },
      endpoints: { orderBy: [{ path: 'asc' }, { method: 'asc' }, { id: 'asc' }] },
      research: { orderBy: [{ date: 'desc' }, { id: 'asc' }] },
      researchQuestions: { orderBy: { id: 'asc' } },
      milestones: { orderBy: [{ targetDate: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }, { id: 'asc' }] },
      tasks: { orderBy: { code: 'asc' } },
      issues: { orderBy: { code: 'asc' } },
      notes: { orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] },
      deployments: { orderBy: [{ date: 'desc' }, { id: 'asc' }] },
      gitReferences: { orderBy: [{ date: 'desc' }, { id: 'asc' }] },
      developmentSessions: { orderBy: { number: 'asc' } }
    }
  });
  if (!project) throw new Error(`Project ${projectId} vanished during synchronization.`);
  const rest = project as any;
  return {
    project: rest,
    ...Object.fromEntries(
      [
        'requirements',
        'features',
        'decisions',
        'techStack',
        'tables',
        'endpoints',
        'research',
        'researchQuestions',
        'milestones',
        'tasks',
        'issues',
        'notes',
        'deployments',
        'gitReferences',
        'developmentSessions'
      ].map((k) => [k, rest[k] ?? []])
    ),
    tags: []
  } as unknown as Awaited<ReturnType<typeof loadProjectDocumentData>>;
}


