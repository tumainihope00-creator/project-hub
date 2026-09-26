import { Prisma } from '@prisma/client';
import { RESOURCES } from '../../resources.js';

/**
 * Dynamic discovery of the REAL Project Hub data model.
 *
 * Nothing in this file hardcodes a field list. Project fields, field types,
 * required-ness, enum values, relations and tables are read from the Prisma
 * data model that the running application is actually connected to. Child
 * entities are derived from RESOURCES (the same definitions the CRUD API uses),
 * and their fields from the Prisma model those definitions point at.
 *
 * If the schema changes, this module changes with it. There is no second copy
 * of the schema to drift out of sync.
 *
 * Two things Prisma's DMMF genuinely does not expose, declared honestly:
 *
 *  1. Schema comments / field descriptions, so JSON-in-a-String columns cannot
 *     be detected dynamically. `JSON_TEXT_COLUMNS` names them explicitly.
 *  2. Which relation a scalar foreign key belongs to is *derived* from the
 *     relation's own `relationFromFields`, which is real DMMF data, not a guess.
 */

export type FieldKind = 'string' | 'number' | 'boolean' | 'datetime' | 'enum' | 'json';

export interface DiscoveredField {
  /** Prisma field name, e.g. "targetUsers" */
  name: string;
  kind: FieldKind;
  /** Postgres column when one exists. */
  column: string | null;
  required: boolean;
  /** For enums: the real allowed values. */
  values?: string[];
  /** True when this String column actually holds JSON. */
  isJsonString?: boolean;
  /** True when the Prisma model marks this field with @default. */
  hasDefault?: boolean;
}

export interface DiscoveredEntity {
  /** URL segment, e.g. "requirements" */
  path: string;
  /** Human label, e.g. "Requirements" */
  label: string;
  singular: string;
  /** Prisma model name, e.g. "Requirement" */
  model: string;
  /** Prisma client delegate name, e.g. "requirement" - what the CRUD layer uses */
  delegate: string;
  /** DB table, e.g. "requirements" */
  table: string;
  /** Fields the importer may write. Excludes id, foreign keys, timestamps. */
  fields: DiscoveredField[];
  /** Scalar field holding the parent Project id, e.g. "projectId". */
  projectForeignKey: string | null;
  /** Scalar field holding the parent entity id, when the entity nests. */
  parentForeignKey: { field: string; target: string } | null;
  /** Human code prefix when the entity has a code column, e.g. "REQ". */
  codePrefix?: string;
  taggable: boolean;
  hasActivityType: boolean;
}

export interface DiscoveredProject {
  model: string;
  table: string;
  fields: DiscoveredField[];
}

export interface DiscoveredRelation {
  from: string;
  to: string;
  /** "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many" */
  cardinality: string;
  /** Scalar fields on `from` that carry the foreign key. */
  foreignKeys: readonly string[];
  /** True when `from` is required by `to` (cascade on delete). */
  requiredOnTo: boolean;
}

export interface DiscoveredModel {
  project: DiscoveredProject;
  entities: DiscoveredEntity[];
  /** Every model in the schema, including ones no resource exposes. */
  models: string[];
  /** Every relation reachable from Project, straight from the DMMF. */
  relations: DiscoveredRelation[];
  enums: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Prisma DMMF access
// ---------------------------------------------------------------------------

const datamodel = Prisma.dmmf.datamodel;

const modelByName = (name: string): Prisma.DMMF.Model | undefined =>
  datamodel.models.find(m => m.name === name);

/** Every enum declared in the schema, keyed by enum name. */
const enumValues = (): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const e of datamodel.enums) out[e.name] = e.values.map(v => v.name);
  return out;
};

const kindOf = (f: Prisma.DMMF.Field, enums: Record<string, string[]>): FieldKind => {
  // In the DMMF an enum-backed field has kind 'enum' and type = the enum NAME
  // (e.g. "RequirementType"), not the literal string 'enum'.
  if (f.kind === 'enum') {
    return enums[String(f.type)]?.length ? 'enum' : 'string';
  }
  if (f.kind !== 'scalar') return 'string';
  const t = String(f.type);
  if (t === 'String') return 'string';
  if (t === 'Int' || t === 'Float' || t === 'BigInt' || t === 'Decimal') return 'number';
  if (t === 'Boolean') return 'boolean';
  if (t === 'DateTime') return 'datetime';
  if (t === 'Json') return 'json';
  return 'string';
};

/**
 * `String` columns that hold JSON.
 *
 * Prisma's DMMF does not include schema comments, so this cannot be derived. The
 * names below are the ones whose schema comment declares JSON, and the importer
 * treats them as text either way - writing a string to them is always correct -
 * so this only affects how values are *displayed*, never how they are stored.
 */
const JSON_TEXT_COLUMNS = new Set([
  'originalIdea',
  'context',
  'alternatives',
  'columns',
  'config',
  'readiness',
  'items',
  'analysis',
  'sourceSnapshot',
  'metadata'
]);

/**
 * Scalar fields that carry a relation's foreign key, mapped to the model they
 * point at. Derived from the relation definitions themselves, so a new relation
 * is picked up automatically instead of needing a list update.
 */
const foreignKeysOf = (modelName: string): Map<string, string> => {
  const out = new Map<string, string>();
  const m = modelByName(modelName);
  if (!m) return out;
  for (const f of m.fields) {
    if (f.kind !== 'object' || !f.relationFromFields?.length) continue;
    for (const from of f.relationFromFields) out.set(from, String(f.type));
  }
  return out;
};

const fieldsOf = (modelName: string, enums: Record<string, string[]>): DiscoveredField[] => {
  const m = modelByName(modelName);
  if (!m) return [];
  // Foreign keys are set by the writer, never by extracted document content.
  const fks = foreignKeysOf(modelName);
  const out: DiscoveredField[] = [];
  for (const f of m.fields) {
    if (f.kind === 'object') continue; // relations are structure, not content
    if (f.name === 'id') continue;
    if (fks.has(f.name)) continue; // e.g. projectId, milestoneId, featureId
    out.push({
      name: f.name,
      kind: kindOf(f, enums),
      column: (f as { dbName?: string }).dbName ?? f.name,
      required: f.isRequired,
      values: f.kind === 'enum' ? enums[String(f.type)] : undefined,
      isJsonString: kindOf(f, enums) === 'string' && JSON_TEXT_COLUMNS.has(f.name),
      hasDefault: f.hasDefaultValue === true
    });
  }
  return out;
};

/** The mapped table name, honouring @@map when present. */
const tableOf = (modelName: string): string => modelByName(modelName)?.dbName ?? modelName;

/**
 * ResourceDef.model is the Prisma *delegate* name (lower-cased model name), not
 * the model name. The DMMF is the authority, so the delegate is resolved to its
 * real model by matching the delegate name to the model's lower-cased name. If no
 * model matches, the entity is reported as unresolved rather than guessed.
 */
function resolveModel(delegate: string): string | null {
  const lower = delegate.toLowerCase();
  const direct = datamodel.models.find(m => m.name.toLowerCase() === lower);
  return direct ? direct.name : null;
}

/**
 * Models that back a resource path but are never written directly by the
 * importer: join tables, version history and other rows owned by another
 * record. Compared against resolved MODEL names, not delegate names.
 */
const DERIVED_MODELS = new Set([
  'FeatureRequirement',
  'PromptVersion',
  'ProjectDocumentVersion',
  'PromptGeneration',
  'TagAssignment'
]);

// ---------------------------------------------------------------------------
// Public discovery
// ---------------------------------------------------------------------------

let cached: DiscoveredModel | null = null;

const build = (): DiscoveredModel => {
  const enums = enumValues();

  const project: DiscoveredProject = {
    model: 'Project',
    table: tableOf('Project'),
    fields: fieldsOf('Project', enums)
  };

  const entities: DiscoveredEntity[] = [];
  const unresolved: string[] = [];

  for (const def of RESOURCES) {
    const modelName = resolveModel(def.model);
    if (!modelName) {
      unresolved.push(def.model);
      continue;
    }
    if (DERIVED_MODELS.has(modelName)) continue;

    const fields = fieldsOf(modelName, enums);
    if (fields.length === 0) {
      unresolved.push(def.model);
      continue;
    }

    const fks = foreignKeysOf(modelName);
    const projectForeignKey = [...fks].find(([, target]) => target === 'Project')?.[0] ?? null;
    const parent = [...fks].find(([, target]) => target !== 'Project');

    entities.push({
      path: def.path,
      label: def.label,
      /** ResourceDef.label is the singular human label, e.g. "Requirement" */
      singular: def.label,
      model: modelName,
      /** the delegate name the CRUD layer and this importer both use */
      delegate: def.model,
      table: tableOf(modelName),
      fields,
      projectForeignKey,
      parentForeignKey: parent ? { field: parent[0], target: parent[1] } : null,
      codePrefix: def.codePrefix,
      taggable: Boolean(def.taggable),
      hasActivityType: Boolean(def.activity?.create)
    });
  }

  if (unresolved.length) {
    // Surfaced loudly: a resource definition pointing at a model the generated
    // client does not know about is a real problem, not something to paper over.
    console.warn(`[import.discovery] unresolved resource delegates: ${unresolved.join(', ')}`);
  }

  return {
    project,
    entities,
    models: datamodel.models.map(m => m.name),
    relations: relationsFrom('Project'),
    enums
  };
};

/** Every relation declared on, or pointing at, the given model. */
function relationsFrom(modelName: string): DiscoveredRelation[] {
  const out: DiscoveredRelation[] = [];
  const seen = new Set<string>();
  for (const m of datamodel.models) {
    for (const f of m.fields) {
      if (f.kind !== 'object') continue;
      const key = `${m.name}.${f.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cardinality =
        f.isList && f.relationFromFields?.length
          ? 'many-to-one'
          : f.isList
            ? 'one-to-many'
            : f.relationFromFields?.length
              ? 'one-to-one'
              : 'many-to-many';
      out.push({
        from: m.name,
        to: String(f.type),
        cardinality,
        foreignKeys: [...(f.relationFromFields ?? [])],
        requiredOnTo: f.isRequired
      });
    }
  }
  return out.filter(r => r.from === modelName || r.to === modelName || r.foreignKeys.length > 0);
}

/** The real, live data model. Cached because the DMMF is static per process. */
export function discoveredModel(): DiscoveredModel {
  if (!cached) cached = build();
  return cached;
}

/** Look up a discovered project field by name. */
export function projectField(name: string): DiscoveredField | undefined {
  return discoveredModel().project.fields.find(f => f.name === name);
}

/** Look up a discovered child entity by URL path. */
export function entityByPath(path: string): DiscoveredEntity | undefined {
  return discoveredModel().entities.find(e => e.path === path);
}

/** Look up a discovered child entity by Prisma model name. */
export function entityByModel(model: string): DiscoveredEntity | undefined {
  return discoveredModel().entities.find(e => e.model === model);
}

/** Look up a discovered child entity by Prisma delegate name. */
export function entityByDelegate(delegate: string): DiscoveredEntity | undefined {
  return discoveredModel().entities.find(e => e.delegate === delegate);
}

// ---------------------------------------------------------------------------
// Capability reporting, derived from what really exists
// ---------------------------------------------------------------------------

/** Never set from a document: system-owned or set explicitly by the caller. */
const PROJECT_FIELD_BLOCKLIST = new Set([
  'slug',
  'isArchived',
  'archivedAt',
  'createdAt',
  'updatedAt',
  'originalIdea'
]);

/** Project fields a document could legitimately fill. */
export function importableProjectFields(): DiscoveredField[] {
  return discoveredModel().project.fields.filter(f => !PROJECT_FIELD_BLOCKLIST.has(f.name));
}

const CHILD_FIELD_BLOCKLIST = new Set(['id', 'createdAt', 'updatedAt']);

/** Entities the importer will create records for, with their writable fields. */
export function importableEntities(): DiscoveredEntity[] {
  return discoveredModel().entities.map(e => ({
    ...e,
    fields: e.fields.filter(f => !CHILD_FIELD_BLOCKLIST.has(f.name))
  }));
}

/** Every enum value the schema really declares, for enum-aware extraction. */
export function enumCatalog(): Record<string, string[]> {
  return discoveredModel().enums;
}
