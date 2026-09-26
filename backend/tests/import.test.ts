import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, prisma } from './helpers';
import { extractDocument, splitSections, documentTitle } from '../src/lib/import/extract';
import { parseDocument, MAX_BYTES } from '../src/lib/import/parse';
import { validateDraft, LIMITS } from '../src/lib/import/mapping';
import { entityByPath, importableEntities, importableProjectFields, discoveredModel } from '../src/lib/import/discovery';
import type { ImportDraft } from '../src/lib/import/mapping';

interface AnalyzeResult {
  draft: ImportDraft;
  counts: { projectFields: number; records: number; duplicates: number; inferred: number; unsupportedConcepts: number };
  stats: { characters: number; lines: number; headings: number; bulletLines: number; listSections: number };
  warnings: string[];
  notFound: string[];
}

const PRD = `# Library Laptop Tracking

## Description
A system that lets librarians record which laptops have been checked out, and which
ones are overdue, across every branch.

## Problem
Librarians currently track laptop loans on paper spreadsheets, so staff cannot see
which devices are out at a glance.

## Target Users
University librarians and circulation staff.

## Expected Value
Every loan is visible within seconds instead of a full day.

## Requirements
- The system must let staff register a new laptop with an asset tag.
- The system must let staff check a laptop out to a student.
- The system must show a list of overdue laptops on the dashboard.
- The dashboard must load in under 2 seconds with 5000 loans.

## Features
- Barcode scanning to check items in and out
- Email reminders 3 days before a loan is due

## Tech Stack
- Built using React and TypeScript
- PostgreSQL for storage

## Architecture Decisions
- We will use JWT auth rather than server sessions.

## API Endpoints
- GET /api/laptops
- POST /api/loans

## Milestones
- Phase 1: Core checkout flow
- Phase 2: Barcode scanning

## Tasks
- Design the loan database tables
- Write the checkout API

## Known Issues
- The current system has no audit log of who returned a device
`;

const created: number[] = [];

function setName(draft: ImportDraft, name: string) {
  const field = draft.project.find(f => f.field === 'name');
  if (field) field.value = name;
}

function importDraft(draft: ImportDraft) {
  return api.post('/api/import/create').send({ draft });
}

async function cleanup() {
  if (created.length === 0) return;
  for (const id of created) {
    await prisma.projectRelationship.deleteMany({ where: { fromProjectId: id } });
    await prisma.projectRelationship.deleteMany({ where: { toProjectId: id } });
  }
  await prisma.project.deleteMany({ where: { id: { in: created } } });
  created.length = 0;
}

beforeAll(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

describe('discovery reflects the live schema', () => {
  it('exposes the real Project columns and none that do not exist', () => {
    const names = importableProjectFields().map(f => f.name);
    expect(names).toContain('name');
    expect(names).toContain('v1Scope');
    // never writable from a document
    expect(names).not.toContain('slug');
    expect(names).not.toContain('originalIdea');
    expect(names).not.toContain('createdAt');
  });

  it('never offers a foreign key or a relation as a writable field', () => {
    for (const entity of importableEntities()) {
      const fields = entity.fields.map(f => f.name);
      expect(fields, entity.path).not.toContain('projectId');
      expect(fields, entity.path).not.toContain('id');
      expect(fields, entity.path).not.toContain('createdAt');
      expect(fields, entity.path).not.toContain('updatedAt');
    }
  });

  it('knows the project foreign key for every entity', () => {
    for (const entity of importableEntities()) {
      expect(entity.projectForeignKey, entity.path).toBe('projectId');
    }
  });

  it('reports the real enum values rather than a hardcoded list', () => {
    const enums = discoveredModel().enums;
    expect(enums.Priority).toContain('HIGH');
    expect(enums.RequirementType).toContain('NON_FUNCTIONAL');
    expect(enums.MilestoneStatus).toContain('PLANNED');
  });

  it('matches the entity paths the CRUD API actually serves', async () => {
    const caps = await api.get('/api/import/capabilities').expect(200);
    const paths = caps.body.data.entities.map((e: any) => e.path);
    for (const p of ['requirements', 'features', 'milestones', 'tasks', 'notes']) {
      expect(paths).toContain(p);
    }
  });
});

describe('parsing', () => {
  it('reads a markdown document', async () => {
    const res = await parseDocument({ buffer: Buffer.from(PRD), filename: 'prd.md' });
    expect(res.format).toBe('md');
    expect(res.text).toContain('Library Laptop Tracking');
  });

  it('reads a plain text document', async () => {
    const res = await parseDocument({ buffer: Buffer.from(PRD), filename: 'prd.txt' });
    expect(res.format).toBe('txt');
    expect(res.text).toContain('Requirements');
  });

  it('reads a JSON document by flattening it', async () => {
    const json = JSON.stringify({ project: { name: 'JSON App', features: ['One', 'Two'] } }, null, 2);
    const res = await parseDocument({ buffer: Buffer.from(json), filename: 'data.json' });
    expect(res.format).toBe('json');
    expect(res.text).toContain('JSON App');
  });

  it('rejects an unsupported extension by name', async () => {
    await expect(
      parseDocument({ buffer: Buffer.from('x'), filename: 'spreadsheet.xlsx' })
    ).rejects.toMatchObject({ category: 'DOCUMENT_ERROR' });
  });

  it('rejects a file over the size limit', async () => {
    const big = Buffer.alloc(MAX_BYTES + 1024, 0x61);
    await expect(parseDocument({ buffer: big, filename: 'big.md' })).rejects.toMatchObject({
      category: 'DOCUMENT_ERROR'
    });
  });

  it('rejects a file that is not the format it claims to be', async () => {
    const notAPdf = Buffer.from('this is plain text pretending to be a pdf');
    await expect(parseDocument({ buffer: notAPdf, filename: 'fake.pdf' })).rejects.toMatchObject({
      category: 'DOCUMENT_ERROR'
    });
  });
});

describe('extraction', () => {
  it('splits a document into sections and finds its title', () => {
    const sections = splitSections(PRD);
    expect(documentTitle(sections)).toBe('Library Laptop Tracking');
    expect(sections.some(s => s.heading === 'Requirements')).toBe(true);
  });

  it('separates what the document states from what it does not', () => {
    const result = extractDocument({ filename: 'prd.md', text: PRD });
    const name = result.projectFields.find(f => f.field === 'name');
    expect(name?.value).toBe('Library Laptop Tracking');
    expect(name?.provenance).toBe('explicit');
    // motivation is nowhere in the document, so it is not invented
    expect(result.projectFields.some(f => f.field === 'motivation')).toBe(false);
    expect(result.missingRequired).toEqual([]);
  });

  it('marks derived values as inferred, not explicit', () => {
    const result = extractDocument({ filename: 'prd.md', text: PRD });
    const scope = result.projectFields.find(f => f.field === 'v1Scope');
    expect(scope?.provenance).toBe('inferred');
  });

  it('separates V1 from future phases', () => {
    const result = extractDocument({ filename: 'prd.md', text: PRD });
    const milestones = result.records.filter(r => r.entity === 'milestones');
    expect(milestones.find(m => m.values.name?.includes('Core checkout'))?.horizon).toBe('v1');
    expect(milestones.find(m => m.values.name?.includes('Barcode'))?.horizon).toBe('future');
  });

  it('only assigns enum values the schema declares', () => {
    const result = extractDocument({ filename: 'prd.md', text: PRD });
    let checked = 0;
    for (const r of result.records) {
      for (const [key, value] of Object.entries(r.values)) {
        const field = entityByPath(r.entity)?.fields.find(f => f.name === key);
        if (field?.kind === 'enum') {
          expect(field.values, `${r.entity}.${key}`).toContain(value);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('collapses duplicates inside the one document', () => {
    const doc = `# Dupes

## Requirements
- The system must let staff register a laptop
- Staff must be able to register a laptop
- The system must let staff check a laptop out
`;
    const result = extractDocument({ filename: 'dupes.md', text: doc });
    const reqs = result.records.filter(r => r.entity === 'requirements');
    expect(reqs.length).toBe(3);
    expect(reqs.filter(r => r.duplicateOf !== undefined).length).toBe(1);
  });

  it('reports concepts Project Hub cannot store instead of inventing a home', () => {
    const doc = `# Budget App

## Description
Tracks spending.

## Budget
Estimated cost is 4000 per year with a monthly price of 20.

## Timeline
Delivery date is March and the launch deadline is tight.
`;
    const result = extractDocument({ filename: 'budget.md', text: doc });
    const concepts = result.unsupported.map(u => u.concept);
    expect(concepts).toContain('Budget / cost');
    expect(concepts).toContain('Timeline / schedule');
  });

  it('returns nothing usable for a document with no project content', () => {
    const result = extractDocument({ filename: 'blank.md', text: 'hello\n\njust a greeting\n' });
    expect(result.projectFields).toHaveLength(0);
    expect(result.records).toHaveLength(0);
  });
});

const baseDraft = (): ImportDraft => ({
  project: [{ field: 'name', value: 'Mapping probe', provenance: 'explicit', confidence: 1, evidence: '', include: true }],
  records: [],
  tags: [],
  source: { filename: 'x.md', format: 'md', mimeType: 'text/markdown', sizeBytes: 10, sha256: 'abc', characters: 10, stored: false },
  unsupported: []
});

describe('mapping refuses anything the schema cannot hold', () => {


  it('rejects a project field that does not exist', () => {
    const draft = baseDraft();
    draft.project.push({ field: 'budget', value: '4000', provenance: 'explicit', confidence: 1, evidence: '', include: true });
    const out = validateDraft(draft);
    expect(out.unmapped.some(u => u.key === 'budget')).toBe(true);
    expect(out.mapped.project.budget).toBeUndefined();
  });

  it('rejects a child column that does not exist', () => {
    const draft = baseDraft();
    draft.records.push({
      entity: 'requirements',
      values: { title: 'A real title', inventedColumn: 'nope' },
      provenance: 'explicit',
      confidence: 1,
      horizon: 'unscoped',
      evidence: '',
      include: true
    });
    const out = validateDraft(draft);
    expect(out.unmapped.some(u => u.key === 'inventedColumn')).toBe(true);
    const written = out.mapped.records[0].values;
    expect(written.title).toBe('A real title');
    expect(Object.keys(written)).not.toContain('inventedColumn');
  });

  it('rejects an enum value the schema does not declare', () => {
    const draft = baseDraft();
    draft.records.push({
      entity: 'requirements',
      values: { title: 'Perf', priority: 'URGENT' },
      provenance: 'explicit',
      confidence: 1,
      horizon: 'unscoped',
      evidence: '',
      include: true
    });
    const out = validateDraft(draft);
    // the bad value is reported, and never written
    expect(out.unmapped.some(u => u.key === 'priority' && /URGENT/.test(u.value))).toBe(true);
    const priority = out.mapped.records[0].values.priority;
    expect(priority).not.toBe('URGENT');
    // whatever takes its place is a value the schema really declares
    if (priority !== undefined) expect(discoveredModel().enums.Priority).toContain(priority as string);
  });

  it('skips a record the user unticked', () => {
    const draft = baseDraft();
    draft.records.push({
      entity: 'requirements',
      values: { title: 'Not wanted' },
      provenance: 'explicit',
      confidence: 1,
      horizon: 'unscoped',
      evidence: '',
      include: false
    });
    const out = validateDraft(draft);
    expect(out.mapped.records).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
  });

  it('skips a record the extractor marked as a duplicate', () => {
    const draft = baseDraft();
    draft.records.push({
      entity: 'requirements',
      values: { title: 'Same thing' },
      provenance: 'explicit',
      confidence: 1,
      horizon: 'unscoped',
      evidence: '',
      include: true,
      duplicateOf: 0
    });
    expect(validateDraft(draft).mapped.records).toHaveLength(0);
  });

  it('refuses a draft with no project name', () => {
    const draft = baseDraft();
    draft.project[0].value = '   ';
    expect(() => validateDraft(draft)).toThrow();
  });

  it('caps runaway record counts', () => {
    const draft = baseDraft();
    draft.records = Array.from({ length: LIMITS.maxRecordsPerEntity + 50 }, (_, i) => ({
      entity: 'requirements',
      values: { title: `Requirement ${i}` },
      provenance: 'explicit' as const,
      confidence: 1,
      horizon: 'unscoped' as const,
      evidence: '',
      include: true
    }));
    const out = validateDraft(draft);
    expect(out.mapped.records.length).toBeLessThanOrEqual(LIMITS.maxRecordsPerEntity);
  });
});

describe('the import API', () => {
  it('advertises what it will and will not do', async () => {
    const res = await api.get('/api/import/capabilities').expect(200);
    expect(res.body.data.guarantees.createsNewProjectOnly).toBe(true);
    expect(res.body.data.guarantees.modifiesExistingProjects).toBe(false);
    expect(res.body.data.guarantees.storesUploadedFile).toBe(false);
  });

  it('analyzes a document without writing anything', async () => {
    const before = await prisma.project.count();
    const res = await api
      .post('/api/import/analyze')
      .attach('document', Buffer.from(PRD), 'library.md')
      .expect(200);
    const data = res.body.data as AnalyzeResult;
    expect(data.draft.project.find(f => f.field === 'name')?.value).toBe('Library Laptop Tracking');
    expect(data.counts.records).toBeGreaterThan(0);
    expect(data.draft.source.stored).toBe(false);
    expect(await prisma.project.count()).toBe(before);
  });

  it('rejects an unsupported file with a specific, actionable error', async () => {
    const res = await api
      .post('/api/import/analyze')
      .attach('document', Buffer.from('col1,col2\n1,2'), 'sheet.csv')
      .expect(422);
    expect(res.body.error.category).toBe('DOCUMENT_ERROR');
    expect(res.body.error.message).toMatch(/csv/i);
    expect(res.body.error.possibleAction).toBeTruthy();
  });

  it('rejects a request with no file at all', async () => {
    const res = await api.post('/api/import/analyze').expect(422);
    expect(res.body.error.category).toBe('DOCUMENT_ERROR');
  });

  it('refuses to target an existing project', async () => {
    const res = await api.post('/api/import/create').send({ projectId: 1, draft: {} }).expect(400);
    expect(res.body.error.message).toMatch(/new project/i);
  });

  it('creates one new project with its records', async () => {
    const analyzed = await api.post('/api/import/analyze').attach('document', Buffer.from(PRD), 'library.md').expect(200);
    const draft = analyzed.body.data.draft as ImportDraft;
    setName(draft, `__TEST__ Imported ${Date.now()}`);

    const res = await importDraft(draft).expect(201);
    created.push(res.body.data.projectId);

    const project = await prisma.project.findUnique({
      where: { id: res.body.data.projectId },
      include: { requirements: true, milestones: true, techStack: true }
    });
    expect(project!.name).toContain('__TEST__');
    expect(project!.requirements.length).toBeGreaterThan(0);
    expect(project!.requirements[0].code).toMatch(/^REQ-\d+$/);
    // provenance is recorded without storing the file
    const idea = JSON.parse(project!.originalIdea!);
    expect(idea.importedFrom.filename).toBe('library.md');
    expect(idea.importedFrom.sha256).toHaveLength(64);
  });

  it('stores every importable project field, not a hand-picked subset', async () => {
    // Guards against a field being dropped on the way to Postgres: the writer
    // builds its insert from the discovered schema, so anything the schema
    // exposes and the user approved has to arrive.
    const analyzed = await api.post('/api/import/analyze').attach('document', Buffer.from(PRD), 'library.md').expect(200);
    const draft = analyzed.body.data.draft as ImportDraft;
    setName(draft, `__TEST__ Fields ${Date.now()}`);
    draft.project.push({ field: 'repositoryUrl', value: 'https://example.test/repo', provenance: 'explicit', confidence: 1, evidence: '', include: true });
    draft.project.push({ field: 'targetUsers', value: 'library staff', provenance: 'explicit', confidence: 1, evidence: '', include: true });

    const res = await importDraft(draft).expect(201);
    created.push(res.body.data.projectId);

    const project = await prisma.project.findUnique({ where: { id: res.body.data.projectId } });
    expect(project!.repositoryUrl).toBe('https://example.test/repo');
    expect(project!.targetUsers).toBe('library staff');
  });

  it('rolls the whole import back when one record cannot be written', async () => {
    const analyzed = await api.post('/api/import/analyze').attach('document', Buffer.from(PRD), 'library.md').expect(200);
    const draft = analyzed.body.data.draft as ImportDraft;
    setName(draft, `__TEST__ Rollback ${Date.now()}`);
    // a NUL byte is a valid JS string and a valid Zod string, but Postgres
    // refuses to store it - so the failure can only surface inside the
    // transaction, which is exactly what this asserts
    draft.records.push({
      entity: 'notes',
      values: { title: 'unwritable', content: 'before\u0000after' },
      provenance: 'explicit',
      confidence: 1,
      horizon: 'unscoped',
      evidence: 'deliberately unwritable',
      include: true
    });

    const before = await prisma.project.count();
    const res = await importDraft(draft).expect(500);
    expect(res.body.error.category).toBe('DATABASE_ERROR');
    expect(await prisma.project.count()).toBe(before);
  });

  it('refuses entities the importer never extracts, even in a hand-edited draft', async () => {
    // The draft is client-supplied, so a caller could try to write any table the
    // schema has. Attachments in particular carry a storagePath, and nothing
    // here uploaded a file.
    const draft = baseDraft();
    draft.records.push({
      entity: 'attachments',
      values: { recordType: 'note', recordId: '1', filename: 'passwd', mimeType: 'text/plain', storagePath: '/etc/passwd', uploadedAt: new Date().toISOString() },
      provenance: 'explicit',
      confidence: 1,
      horizon: 'unscoped',
      evidence: 'hand written',
      include: true
    });
    const out = validateDraft(draft);
    expect(out.mapped.records.some(r => r.entity === 'attachments')).toBe(false);
    expect(out.unmapped.some(u => u.where === 'attachments')).toBe(true);

    setName(draft, `__TEST__ Allowlist ${Date.now()}`);
    const res = await importDraft(draft).expect(201);
    created.push(res.body.data.projectId);
    expect(await prisma.attachment.count({ where: { projectId: res.body.data.projectId } })).toBe(0);
  });

  it('never modifies a pre-existing project', async () => {
    const existing = await prisma.project.findMany({
      where: { id: { notIn: created } },
      orderBy: { id: 'asc' }
    });
    const fingerprint = (p: (typeof existing)[number]) =>
      JSON.stringify({
        name: p.name,
        slug: p.slug,
        stage: p.stage,
        description: p.description,
        problem: p.problem,
        v1Scope: p.v1Scope,
        originalIdea: p.originalIdea,
        isArchived: p.isArchived,
        updatedAt: p.updatedAt.toISOString()
      });
    const before = existing.map(fingerprint);

    const analyzed = await api.post('/api/import/analyze').attach('document', Buffer.from(PRD), 'library.md').expect(200);
    const draft = analyzed.body.data.draft as ImportDraft;
    setName(draft, `__TEST__ Isolation ${Date.now()}`);
    const res = await importDraft(draft).expect(201);
    created.push(res.body.data.projectId);

    const after = await prisma.project.findMany({
      where: { id: { notIn: created } },
      orderBy: { id: 'asc' }
    });
    expect(after.map(fingerprint)).toEqual(before);
  });
});

