import { z } from 'zod';
import { RESOURCES } from '../../resources.js';
import { discoveredModel, importableEntities, importableProjectFields } from './discovery.js';
import { EXTRACTABLE_ENTITIES } from './extract.js';
import { extractionError, mappingError } from '../errors.js';

/**
 * Validation of a user-reviewed import draft against the REAL schema.
 *
 * The draft that comes back from the browser is untrusted input. Nothing in it
 * is written because it "looks right": every project field, every child field
 * and every enum value is checked against the Prisma data model and against the
 * same Zod schema the ordinary CRUD endpoints use. Anything Project Hub has no
 * structure for is reported as unmapped instead of being invented, dropped
 * silently, or forced into a neighbouring field.
 */

export interface DraftField {
  field: string;
  value: string;
  provenance: 'explicit' | 'inferred';
  confidence: number;
  evidence: string;
  /** The user can untick anything the extractor proposed. */
  include: boolean;
}

export interface DraftRecord {
  entity: string;
  values: Record<string, string>;
  provenance: 'explicit' | 'inferred';
  confidence: number;
  horizon: 'v1' | 'future' | 'unscoped';
  evidence: string;
  include: boolean;
  /** Set by the extractor when this repeats another record in the same file. */
  duplicateOf?: number;
}

export interface DraftSource {
  filename: string;
  format: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  characters: number;
  /** Text is not stored; only this provenance summary is. */
  stored: false;
}

export interface ImportDraft {
  project: DraftField[];
  records: DraftRecord[];
  tags: string[];
  source: DraftSource;
  unsupported: { concept: string; value: string; evidence: string; reason: string }[];
}

/** A draft that has passed every schema check, ready to be written. */
export interface MappedDraft {
  project: Record<string, unknown>;
  tags: string[];
  records: { entity: string; values: Record<string, unknown>; provenance: DraftRecord['provenance']; evidence: string; horizon: DraftRecord['horizon'] }[];
  source: DraftSource;
  unsupported: ImportDraft['unsupported'];
}

export interface UnmappedItem {
  where: string;
  key: string;
  value: string;
  reason: string;
}

/** Safety limits: one document must not be able to flood a project. */
export const LIMITS = {
  maxRecordsPerEntity: 200,
  maxRecordsTotal: 1000,
  maxTags: 25,
  maxValueLength: 8000
} as const;

const resourceFor = (path: string) => RESOURCES.find(r => r.path === path);

const enums = (): Record<string, string[]> => discoveredModel().enums;

/** Coerce a text value to the column's real Prisma type, or report why not. */
function coerce(
  field: { name: string; kind: string; required: boolean; values?: string[] },
  raw: string,
  where: string,
  unmapped: UnmappedItem[]
): { ok: true; value: unknown } | { ok: false } {
  const value = raw.trim();
  if (value === '') return { ok: false };

  if (value.length > LIMITS.maxValueLength) {
    unmapped.push({ where, key: field.name, value: `${value.slice(0, 60)}…`, reason: `Longer than the ${LIMITS.maxValueLength} character limit.` });
    return { ok: false };
  }

  switch (field.kind) {
    case 'enum': {
      const allowed = field.values ?? [];
      const up = value.toUpperCase();
      if (!allowed.includes(up)) {
        unmapped.push({
          where,
          key: field.name,
          value,
          reason: `"${value}" is not a value the schema's enum allows. Allowed: ${allowed.join(', ')}.`
        });
        return { ok: false };
      }
      return { ok: true, value: up };
    }
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        unmapped.push({ where, key: field.name, value, reason: `"${value}" is not a number.` });
        return { ok: false };
      }
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (/^(true|yes|y|1)$/i.test(value)) return { ok: true, value: true };
      if (/^(false|no|n|0)$/i.test(value)) return { ok: true, value: false };
      unmapped.push({ where, key: field.name, value, reason: `"${value}" is not a boolean.` });
      return { ok: false };
    }
    case 'datetime': {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) {
        unmapped.push({ where, key: field.name, value, reason: `"${value}" is not a date the database accepts.` });
        return { ok: false };
      }
      return { ok: true, value: d };
    }
    default:
      return { ok: true, value };
  }
}

const draftFieldSchema = z.object({
  field: z.string().min(1),
  value: z.string(),
  provenance: z.enum(['explicit', 'inferred']),
  confidence: z.number().min(0).max(1),
  evidence: z.string().default(''),
  include: z.boolean().default(true)
});

const draftRecordSchema = z.object({
  entity: z.string().min(1),
  values: z.record(z.string(), z.string()),
  provenance: z.enum(['explicit', 'inferred']).default('explicit'),
  confidence: z.number().min(0).max(1).default(0.5),
  horizon: z.enum(['v1', 'future', 'unscoped']).default('unscoped'),
  evidence: z.string().default(''),
  include: z.boolean().default(true),
  duplicateOf: z.number().int().nonnegative().optional()
});

const draftSchema = z.object({
  project: z.array(draftFieldSchema).default([]),
  records: z.array(draftRecordSchema).default([]),
  tags: z.array(z.string()).default([]),
  source: z.object({
    filename: z.string().min(1),
    format: z.string().min(1),
    mimeType: z.string().default('application/octet-stream'),
    sizeBytes: z.number().int().nonnegative().default(0),
    sha256: z.string().min(1),
    characters: z.number().int().nonnegative().default(0),
    stored: z.literal(false)
  }),
  unsupported: z
    .array(z.object({ concept: z.string(), value: z.string(), evidence: z.string(), reason: z.string() }))
    .default([])
});

export interface ValidationResult {
  mapped: MappedDraft;
  unmapped: UnmappedItem[];
  /** Records the user unticked or the extractor marked as duplicates. */
  skipped: { entity: string; reason: string; evidence: string }[];
}

/**
 * Validate an edited draft. Throws a categorized error rather than writing
 * anything when the draft cannot be represented in the existing schema.
 */
export function validateDraft(input: unknown): ValidationResult {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) {
    throw mappingError(
      'The import draft is not in the shape the importer expects.',
      'validate the reviewed import draft',
      'Reload the analysis and try again. Your uploaded file was not modified.',
      parsed.error.flatten()
    );
  }
  const draft = parsed.data as ImportDraft;

  const projectFields = importableProjectFields();
  const projectByName = new Map(projectFields.map(f => [f.name, f]));
  const entities = importableEntities();
  const entityByPath = new Map(entities.map(e => [e.path, e]));
  const EXTRACTABLE = new Set(EXTRACTABLE_ENTITIES);

  const unmapped: UnmappedItem[] = [];
  const skipped: { entity: string; reason: string; evidence: string }[] = [];

  // --- Project ------------------------------------------------------------
  const project: Record<string, unknown> = {};
  for (const f of draft.project) {
    if (!f.include) continue;
    if (!projectByName.has(f.field)) {
      unmapped.push({
        where: 'project',
        key: f.field,
        value: f.value,
        reason: 'Project Hub has no such field on the Project model.'
      });
      continue;
    }
    const def = projectByName.get(f.field)!;
    const coerced = coerce(def, f.value, 'project', unmapped);
    if (coerced.ok) project[def.name] = coerced.value;
  }

  if (typeof project.name !== 'string' || String(project.name).trim() === '') {
    throw extractionError(
      'A project name is required, and the document did not provide one.',
      'build the project from the reviewed draft',
      'Type a name in the review screen and confirm again. Nothing has been saved yet.'
    );
  }

  // --- Child records ------------------------------------------------------
  const perEntity = new Map<string, number>();
  const mappedRecords: MappedDraft['records'] = [];

  for (const r of draft.records) {
    if (!r.include) {
      skipped.push({ entity: r.entity, reason: 'Excluded during review.', evidence: r.evidence });
      continue;
    }
    if (r.duplicateOf !== undefined) {
      skipped.push({ entity: r.entity, reason: 'Duplicate of an earlier item in the same document.', evidence: r.evidence });
      continue;
    }
    const entity = entityByPath.get(r.entity);
    const def = resourceFor(r.entity);
    if (!entity || !def) {
      unmapped.push({
        where: r.entity,
        key: '(record)',
        value: r.evidence.slice(0, 80),
        reason: 'Project Hub exposes no such child entity.'
      });
      continue;
    }
    if (!EXTRACTABLE.has(r.entity)) {
      // The schema has this table, but a document import never creates one, so
      // a hand-edited draft cannot smuggle records in through the importer.
      unmapped.push({
        where: r.entity,
        key: '(record)',
        value: r.evidence.slice(0, 80),
        reason: 'The importer does not create records of this kind.'
      });
      continue;
    }

    const count = perEntity.get(r.entity) ?? 0;
    if (count >= LIMITS.maxRecordsPerEntity) {
      skipped.push({ entity: r.entity, reason: `Over the ${LIMITS.maxRecordsPerEntity} record limit for one entity.`, evidence: r.evidence });
      continue;
    }
    if (mappedRecords.length >= LIMITS.maxRecordsTotal) {
      skipped.push({ entity: r.entity, reason: `Over the ${LIMITS.maxRecordsTotal} total record limit.`, evidence: r.evidence });
      continue;
    }

    // Coerce the user's text to each column's real type first. The review screen
    // sends strings from text inputs, and the existing Zod schemas expect real
    // numbers, so parsing before coercion would reject every numeric field.
    const prepared: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(r.values)) {
      const field = entity.fields.find(f => f.name === key);
      if (!field) {
        unmapped.push({ where: r.entity, key, value: String(raw ?? ''), reason: 'No such column on this entity.' });
        continue;
      }
      if (raw === null || raw === undefined || raw === '') continue;
      const coerced = coerce(field, typeof raw === 'string' ? raw : String(raw), r.entity, unmapped);
      if (coerced.ok) prepared[field.name] = coerced.value;
    }

    // The same Zod schema the CRUD API uses decides what a valid row is, so an
    // import cannot create a row the ordinary UI would refuse.
    const schemaCheck = def.createSchema.safeParse(prepared);
    if (!schemaCheck.success) {
      unmapped.push({
        where: r.entity,
        key: Object.keys(prepared).join(', '),
        value: r.evidence.slice(0, 80),
        reason: `Does not satisfy the existing ${entity.label} schema: ${schemaCheck.error.issues
          .map(i => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`
      });
      continue;
    }

    const values: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(schemaCheck.data as Record<string, unknown>)) {
      if (raw === null || raw === undefined || raw === '') continue;
      values[key] = raw;
    }

    // A row with nothing in it is not worth writing.
    if (Object.keys(values).length === 0) {
      skipped.push({ entity: r.entity, reason: 'No usable values after schema validation.', evidence: r.evidence });
      continue;
    }

    perEntity.set(r.entity, count + 1);
    mappedRecords.push({ entity: r.entity, values, provenance: r.provenance, evidence: r.evidence, horizon: r.horizon });
  }

  // --- Tags ---------------------------------------------------------------
  const tags = [...new Set(draft.tags.map(t => t.trim()).filter(Boolean))]
    .slice(0, LIMITS.maxTags)
    .map(t => t.toLowerCase().replace(/\s+/g, '-'));

  return {
    mapped: { project, tags, records: mappedRecords, source: draft.source, unsupported: draft.unsupported },
    unmapped,
    skipped
  };
}

/** Enum values the schema really declares, for the review screen's dropdowns. */
export function enumOptions(): Record<string, string[]> {
  return enums();
}
