import type { EntityKey } from './projectDocumentSync.js';

/**
 * Phase 7: the synchronization baseline, and the three-way comparison built on it.
 *
 * WHY THIS FILE EXISTS. Phase 6 could tell *that* the database had moved, using
 * one hash over the document Project Hub would generate. That is enough to refuse a
 * synchronization, and not enough to describe one: "the database moved" says
 * nothing about which field moved, so a single unrelated edit made the whole
 * project a conflict and the only remedy was to overwrite everything.
 *
 * THE MODEL. Three values per field, never two:
 *
 *     baseline   the value in the last state where the document and the database
 *                agreed
 *     database   the value the database holds right now
 *     markdown   the value PROJECT.md expresses right now
 *
 * Comparing all three is what makes the five cases separable:
 *
 *     database == baseline,  markdown == baseline  ->  nothing happened
 *     database == baseline,  markdown != baseline  ->  the document changed; the
 *                                                        document may be applied
 *     database != baseline,  markdown == baseline  ->  the database changed; it
 *                                                        wins, because nothing
 *                                                        newer says otherwise
 *     database != baseline,  markdown != baseline,
 *       and database == markdown                  ->  both arrived at the same
 *                                                        value; nothing to do but
 *                                                        move the baseline forward
 *     database != baseline,  markdown != baseline,
 *       and database != markdown                  ->  a true conflict on this one
 *                                                        field, reported and
 *                                                        withheld
 *
 * The important consequence is that "both sides changed" is not a conflict. Two
 * people editing two different fields is the normal case in a shared project, and
 * the merge above produces the union of both edits without asking anyone. A
 * conflict is one field that both sides changed to different values.
 *
 * WHAT THE BASELINE IS. A snapshot of the synchronized values, taken from the
 * document that was synchronized - not from the database, and not from a hash. It
 * has to be the document, because "the document did not express this field" is
 * itself information: a field the document stays silent about cannot conflict, so
 * the baseline records its absence rather than inventing a value for it.
 *
 * WHY NOT A HASH PER FIELD. A per-field hash would detect *that* a field changed
 * but could not say what it changed from, and a conflict report that cannot show
 * the previous value is not something a user can resolve. The snapshot is a few
 * kilobytes of jsonb per project, written once per successful synchronization.
 *
 * ABSENCE IS NOT A CLEAR. `markdown: null` means "the document expressed nothing
 * here". It never means "empty the database value". That rule is Phase 6's and it
 * is unchanged: the verdict for an unexpressed field is only ever `unchanged` or
 * `database_changed`, and neither writes anything.
 */

/** Bumped when the stored shape changes; an older baseline is rebuilt, never guessed at. */
export const BASELINE_VERSION = 1;

/**
 * The classified synchronization state.
 *
 * `error` is not a state of the data but of the document: a missing file, an
 * unreadable file or one that cannot be parsed. It is kept in the same vocabulary
 * as the others so the UI has one field to render, and it is never a reason to
 * write anything.
 */
export type SyncState =
  | 'synchronized'
  | 'markdown_changed'
  | 'database_changed'
  | 'both_changed'
  | 'conflict'
  | 'error';

/** The per-field outcome of the three-way comparison. */
export type FieldVerdictState =
  | 'unchanged'
  | 'markdown_changed'
  | 'database_changed'
  | 'both_changed'
  | 'conflict';

export interface SyncBaseline {
  version: number;
  /** When this baseline was captured (ISO 8601). */
  capturedAt: string;
  /** The hash of the document bytes this baseline was taken from. */
  documentHash: string;
  /** Column name -> value, for the project columns the document can express. */
  project: Record<string, string | null>;
  /** entity -> stable key -> column name -> value. */
  records: Record<string, Record<string, Record<string, string | null>>>;
}

export interface FieldVerdict {
  scope: 'project' | 'record';
  /** The column this verdict is about. */
  field: string;
  entity: EntityKey | null;
  /** The record's stable key, for a record verdict. */
  key: string | null;
  /** A display label for a record verdict. Never used for identity. */
  label: string | null;
  state: FieldVerdictState;
  /** The value at the last successful synchronization, when it is known. */
  baseline: string | null;
  /** What the database holds now. */
  databaseValue: string | null;
  /** What PROJECT.md expresses now. `null` means the document is silent. */
  markdownValue: string | null;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Reduce a value to the form used for comparison and for the baseline.
 *
 * Only differences that cannot mean anything to a reader are removed: line-ending
 * style, trailing whitespace on a line, runs of blank lines, and leading/trailing
 * blank space. Nothing inside the text is touched, and no case folding, no
 * punctuation stripping and no whitespace collapsing inside a line - a user who
 * rewrote a sentence must still be detected as having rewritten it.
 *
 * Values that mean "nothing" collapse to a single `null`, so an absent value, an
 * empty string and a blank section compare equal to each other and never to a
 * value with content in it.
 */
export function normalizeCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const text = typeof value === 'string' ? value : String(value);
  const normalized = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized === '' ? null : normalized;
}

// ---------------------------------------------------------------------------
// Reading a stored baseline
// ---------------------------------------------------------------------------

/**
 * Read a stored baseline.
 *
 * Returns null for anything that is not a baseline this build understands: a
 * missing column, a value written by a future version, or malformed json. A
 * project whose baseline cannot be read is treated as having none, which is the
 * safe direction - it re-derives one instead of comparing against nonsense.
 */
export function parseBaseline(raw: unknown): SyncBaseline | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<SyncBaseline>;
  if (candidate.version !== BASELINE_VERSION) return null;
  if (typeof candidate.documentHash !== 'string') return null;
  return {
    version: BASELINE_VERSION,
    capturedAt: typeof candidate.capturedAt === 'string' ? candidate.capturedAt : '',
    documentHash: candidate.documentHash,
    project: isStringRecord(candidate.project) ? (candidate.project as Record<string, string | null>) : {},
    records: isRecordOfRecords(candidate.records) ? (candidate.records as SyncBaseline['records']) : {}
  };
}

function isStringRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecordOfRecords(value: unknown): boolean {
  if (!isStringRecord(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isStringRecord);
}

// ---------------------------------------------------------------------------
// The three-way comparison
// ---------------------------------------------------------------------------

/**
 * Compare one field across the baseline, the database and the document.
 *
 * `markdown === undefined` means the document does not express this field. That is
 * not a request to clear it: the field is reported as unchanged, or as a database
 * change the document has no opinion about, and in neither case is anything
 * written.
 *
 * `baselineKnown: false` is the Phase 7 answer for a project that has no baseline
 * yet - typically one that existed before this phase. There is then no "last
 * agreed value" to compare against, so the only two honest verdicts are:
 *
 *   - the two sides already agree: nothing to do, and this is a safe moment to
 *     capture a baseline from;
 *   - the two sides disagree: nobody can say which is newer, so it is reported as
 *     a conflict and the user decides. Treating the document as the winner here
 *     would be exactly the blind overwrite this phase exists to stop.
 */
export function classifyField(input: {
  scope: 'project' | 'record';
  field: string;
  entity?: EntityKey | null;
  key?: string | null;
  label?: string | null;
  baselineKnown: boolean;
  baseline: string | null;
  databaseValue: unknown;
  /** `undefined` when the document does not express the field at all. */
  markdownValue?: unknown;
}): FieldVerdict {
  const b = normalizeCell(input.baseline);
  const d = normalizeCell(input.databaseValue);
  const expressed = input.markdownValue !== undefined;
  const m = expressed ? normalizeCell(input.markdownValue) : null;

  let state: FieldVerdictState;
  if (!input.baselineKnown) {
    state = !expressed || d === m ? 'unchanged' : 'conflict';
  } else if (!expressed) {
    // The document is silent. A database that moved since the baseline is still a
    // database change worth reporting, and it is never overwritten.
    state = d === b ? 'unchanged' : 'database_changed';
  } else if (d === b && m === b) {
    state = 'unchanged';
  } else if (d === b) {
    state = 'markdown_changed';
  } else if (m === b) {
    state = 'database_changed';
  } else if (d === m) {
    state = 'both_changed';
  } else {
    state = 'conflict';
  }

  return {
    scope: input.scope,
    field: input.field,
    entity: input.entity ?? null,
    key: input.key ?? null,
    label: input.label ?? null,
    state,
    baseline: b,
    databaseValue: d,
    markdownValue: expressed ? m : null
  };
}

/**
 * Roll per-field verdicts up into one state for the project.
 *
 * The order matters only in that a conflict outranks everything: a project that
 * has one conflicting field is a conflict project, and the merge it also contains
 * is still applied.
 */
export function rollUpState(verdicts: readonly FieldVerdict[]): SyncState {
  let markdown = false;
  let database = false;
  let both = false;
  let conflict = false;

  for (const v of verdicts) {
    if (v.state === 'conflict') conflict = true;
    else if (v.state === 'both_changed') both = true;
    else if (v.state === 'markdown_changed') markdown = true;
    else if (v.state === 'database_changed') database = true;
  }

  if (conflict) return 'conflict';
  if (markdown && database) return 'both_changed';
  if (both && (markdown || database)) return 'both_changed';
  if (markdown) return 'markdown_changed';
  if (database) return 'database_changed';
  // Both sides agreeing on a new value with no other difference is still a change
  // to record, and the project is otherwise in step.
  if (both) return 'both_changed';
  return 'synchronized';
}

/** The states in which a field may be written from the document without asking. */
export function isSafeToApply(verdict: FieldVerdict): boolean {
  return verdict.state === 'markdown_changed';
}

// ---------------------------------------------------------------------------
// Baseline maintenance
// ---------------------------------------------------------------------------

/**
 * Move the baseline forward for the fields that were synchronized.
 *
 * Called with the document that was applied. Two rules keep the baseline honest:
 *
 *  - a field the document did not express is carried over from the previous
 *    baseline rather than dropped, so its "no opinion" status survives;
 *  - a field that is still in conflict is NOT advanced, because the two sides have
 *    not agreed on it yet. That is what makes an unresolved conflict stay visible
 *    on the next page load instead of quietly disappearing.
 */
export function advanceBaseline(
  previous: SyncBaseline | null,
  next: SyncBaseline,
  conflictedFields: readonly { entity: EntityKey | null; key: string | null; field: string }[]
): SyncBaseline {
  if (previous === null) return next;

  const conflicted = new Set(
    conflictedFields.map((c) => `${c.entity ?? ''}|${c.key ?? ''}|${c.field}`)
  );

  const project: Record<string, string | null> = { ...previous.project };
  for (const [column, value] of Object.entries(next.project)) {
    if (!conflicted.has(`||${column}`)) project[column] = value;
  }

  const records: SyncBaseline['records'] = {};
  for (const entity of new Set([...Object.keys(previous.records), ...Object.keys(next.records)])) {
    const before = previous.records[entity] ?? {};
    const after = next.records[entity] ?? {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const bucket: Record<string, Record<string, string | null>> = {};
    for (const key of keys) {
      const fields: Record<string, string | null> = { ...(before[key] ?? {}) };
      for (const [field, value] of Object.entries(after[key] ?? {})) {
        if (!conflicted.has(`${entity}|${key}|${field}`)) fields[field] = value;
      }
      bucket[key] = fields;
    }
    records[entity] = bucket;
  }

  return {
    version: BASELINE_VERSION,
    capturedAt: next.capturedAt,
    // The document this baseline describes. Only a project that just synchronized
    // or regenerated moves this; a baseline that keeps the old hash would make
    // every later read look like an edit.
    documentHash: next.documentHash,
    project,
    records
  };
}

/**
 * The field names currently in conflict, for the project row.
 *
 * Names only. The values live in the baseline and in the live data, and duplicating
 * them into a column that the dashboard reads would be a copy that can go stale.
 */
export function conflictFieldNames(conflicts: readonly FieldVerdict[]): string[] {
  return [
    ...new Set(
      conflicts.map((c) => (c.scope === 'project' ? c.field : `${c.entity}:${c.key}.${c.field}`))
    )
  ].sort();
}
