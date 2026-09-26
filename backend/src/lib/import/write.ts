import { PrismaClient, Prisma, type LifecycleStage } from '@prisma/client';
import { RESOURCES, type Ctx, type ResourceDef } from '../../resources.js';
import { taggableKeyFor } from '../tags.js';
import { databaseError } from '../errors.js';
import { discoveredModel, importableProjectFields } from './discovery.js';
import type { MappedDraft } from './mapping.js';

/**
 * The one and only place the importer writes to the database.
 *
 * Rules this module enforces by construction:
 *
 *  - It creates exactly ONE new project. There is no code path here that takes
 *    an existing project id, so an import can never modify an existing project
 *    or any of its child records.
 *  - Everything happens inside a single transaction. If one child record fails,
 *    the project and every record created before it are rolled back.
 *  - Child rows go through the same code/number/hook/activity conventions the
 *    ordinary CRUD endpoints use, so imported records look like hand-made ones.
 */

export interface ImportResult {
  projectId: number;
  slug: string;
  created: Record<string, number>;
  totalRecords: number;
}

const pad = (n: number, width = 3): string => String(n).padStart(width, '0');

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Same rule as the manual project endpoint: append -2, -3, ... until free. */
async function uniqueSlug(tx: Prisma.TransactionClient, name: string): Promise<string> {
  const base = slugify(name) || 'project';
  let slug = base;
  let n = 2;
  while (await tx.project.findFirst({ where: { slug }, select: { id: true } })) {
    slug = `${base}-${n}`;
    n++;
  }
  return slug;
}

async function nextCode(tx: Prisma.TransactionClient, def: ResourceDef, projectId: number): Promise<string | undefined> {
  if (!def.codePrefix) return undefined;
  const rows = (await (tx as any)[def.model].findMany({
    where: { projectId },
    select: { code: true }
  })) as Array<{ code: string | null }>;
  const prefix = def.codePrefix.toUpperCase();
  let max = 0;
  for (const r of rows) {
    const m = /(\d+)$/.exec(r.code ?? '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${pad(max + 1)}`;
}

async function nextNumber(tx: Prisma.TransactionClient, def: ResourceDef, projectId: number): Promise<number | undefined> {
  if (!def.numbered) return undefined;
  const rows = (await (tx as any)[def.model].findMany({
    where: { projectId },
    select: { number: true }
  })) as Array<{ number: number | null }>;
  return rows.reduce((m, r) => Math.max(m, r.number ?? 0), 0) + 1;
}

/** Same derived fields the CRUD layer sets, so imported rows behave identically. */
function applyDerived(model: string, data: Record<string, unknown>): void {
  if (model === 'task' && data.status === 'COMPLETED') data.completedAt = new Date();
  if (model === 'issue' && ['RESOLVED', 'CLOSED', 'WONT_FIX'].includes(String(data.status)) && !data.resolvedAt) {
    data.resolvedAt = new Date();
  }
}

/** Tag rows are global; assignments belong to the new project only. */
async function applyTags(tx: Prisma.TransactionClient, taggableType: string, taggableId: number, names: string[]): Promise<void> {
  const cleaned = [...new Set(names.map(n => n.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean))];
  for (const name of cleaned) {
    const tag = (await tx.tag.findUnique({ where: { name } })) ?? (await tx.tag.create({ data: { name } }));
    const existing = await tx.tagAssignment.findUnique({
      where: { tagId_taggableType_taggableId: { tagId: tag.id, taggableType, taggableId } }
    });
    if (!existing) {
      await tx.tagAssignment.create({ data: { tagId: tag.id, taggableType, taggableId } });
    }
  }
}

export async function importProject(prisma: PrismaClient, mapped: MappedDraft): Promise<ImportResult> {
  const { project, records, tags, source, unsupported } = mapped;
  const created: Record<string, number> = {};

  // The transaction returns the project it created, so the response can never
  // describe a different project than the one this import wrote.
  let result: { id: number; slug: string };
  try {
    result = await prisma.$transaction(
    async tx => {
      // ---- the single new project ---------------------------------------
      const name = String(project.name);
      const slug = await uniqueSlug(tx, name);

      // originalIdea is the app's own snapshot field: it keeps the imported
      // document's identity and what the user approved, without storing the file.
      const originalIdea = JSON.stringify({
        ...project,
        capturedAt: new Date().toISOString(),
        importedFrom: {
          filename: source.filename,
          format: source.format,
          sizeBytes: source.sizeBytes,
          sha256: source.sha256,
          characters: source.characters
        },
        v1Scope: project.v1Scope ?? null,
        importedRecords: records.length,
        unsupportedConcepts: unsupported.map(u => u.concept)
      });

      // Build the row from the fields the schema actually exposes, so every
      // importable column is stored rather than silently dropped, and a column
      // added to the schema later is picked up without touching this file.
      const projectData: Record<string, unknown> = { name, slug, originalIdea, isArchived: false };
      for (const f of importableProjectFields()) {
        const value = project[f.name];
        if (value === undefined || value === null || value === '') continue;
        projectData[f.name] = value;
      }
      projectData.stage = (project.stage as LifecycleStage) ?? 'IDEA';

      const created0 = await tx.project.create({
        data: projectData as Prisma.ProjectCreateInput
      });
      const projectId = created0.id;

    if (tags.length) await applyTags(tx, 'project', projectId, tags);

    await tx.activityEvent.create({
      data: {
        projectId,
        type: 'PROJECT_CREATED',
        description: `Project "${name}" created by importing "${source.filename}"`,
        metadata: JSON.stringify({
          import: {
            filename: source.filename,
            format: source.format,
            sha256: source.sha256,
            sizeBytes: source.sizeBytes,
            records: records.length,
            byEntity: records.reduce<Record<string, number>>((acc, r) => {
              acc[r.entity] = (acc[r.entity] ?? 0) + 1;
              return acc;
            }, {}),
            unsupported: unsupported.map(u => u.concept)
          }
        }),
        relatedType: 'project',
        relatedId: projectId
      }
    });

    // ---- children --------------------------------------------------------
    // Hooks receive the transaction client so any row they write joins this
    // transaction instead of escaping it.
    const ctx: Ctx = { projectId, client: tx };

    for (const record of records) {
      const def = RESOURCES.find(r => r.path === record.entity);
      if (!def) continue;
      const entity = discoveredModel().entities.find(e => e.path === record.entity);
      if (!entity) continue;

      const input: Record<string, unknown> = { ...record.values };
      const code = await nextCode(tx, def, projectId);
      const number = await nextNumber(tx, def, projectId);
      if (code !== undefined) input.code = code;
      if (number !== undefined) input.number = number;
      applyDerived(def.model, input);

      if (def.hooks?.beforeCreate) {
        const hookResult = await def.hooks.beforeCreate(input, ctx);
        if (hookResult !== undefined) Object.assign(input, hookResult);
      }

      const row = (await (tx as any)[def.model].create({
        data: { projectId, ...input }
      })) as { id: number };

      if (def.hooks?.afterCreate) await def.hooks.afterCreate(row, input, ctx);
      if (def.hooks?.afterSave) await def.hooks.afterSave(row, input, ctx);

      if (def.taggable) {
        const taggableType = taggableKeyFor(def.model);
        if (taggableType) await applyTags(tx, taggableType, row.id, tags);
      }

      if (def.activity.create) {
        await tx.activityEvent.create({
          data: {
            projectId,
            type: def.activity.create,
            description: `${def.label} created: ${def.describe ? def.describe(row) : def.label}`,
            metadata: JSON.stringify({
              import: {
                source: source.filename,
                entity: record.entity,
                provenance: record.provenance,
                horizon: record.horizon,
                evidence: record.evidence
              }
            }),
            relatedType: def.model,
            relatedId: row.id
          }
        });
      }

      created[record.entity] = (created[record.entity] ?? 0) + 1;
    }

      return { id: projectId, slug };
    },
    { timeout: 60_000, maxWait: 10_000 }
    );
  } catch (err) {
    // Nothing was written: the whole transaction was rolled back.
    const cause = err instanceof Error ? err.message : String(err);
    throw databaseError(
      'The database refused to write the imported project, so nothing was saved.',
      'write the imported project and its records in one transaction',
      'Adjust the flagged values in the review screen and confirm again. No partial project was created.',
      { cause }
    );
  }

  return {
    projectId: result.id,
    slug: result.slug,
    created,
    totalRecords: records.length
  };
}
