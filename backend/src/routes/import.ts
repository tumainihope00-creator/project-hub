import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { createHash } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { badRequest, documentError, extractionError } from '../lib/errors.js';
import { importableEntities, importableProjectFields, discoveredModel } from '../lib/import/discovery.js';
import { parseDocument, SUPPORTED_FORMATS, MAX_BYTES } from '../lib/import/parse.js';
import { extractDocument } from '../lib/import/extract.js';
import { validateDraft, LIMITS, type DraftField, type DraftRecord } from '../lib/import/mapping.js';
import { importProject } from '../lib/import/write.js';

/**
 * Document import.
 *
 * POST /analyze  - multipart upload. Parses and extracts only. Performs NO
 *                  database write of any kind, and never touches an existing
 *                  project.
 * POST /create   - takes the draft the user reviewed, re-validates it against
 *                  the live schema, and creates exactly one new project inside a
 *                  single transaction.
 *
 * There is deliberately no route that imports into an existing project.
 */

export const importRouter: Router = Router();

/** In-memory only: the uploaded bytes are never written to disk or the database. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 20 }
});

/** Wraps multer so its own errors become categorized document errors. */
const receiveFile = (req: Request, res: Response, next: NextFunction): void => {
  upload.single('document')(req, res, (err: unknown) => {
    if (!err) return next();
    const code = (err as { code?: string })?.code;
    if (code === 'LIMIT_FILE_SIZE') {
      return next(
        documentError(
          `That file is larger than the ${Math.round(MAX_BYTES / (1024 * 1024))} MB import limit.`,
          req.file?.originalname ?? 'the uploaded file',
          'accept the uploaded file'
        )
      );
    }
    if (code === 'LIMIT_UNEXPECTED_FILE') {
      return next(
        documentError(
          'The upload must contain exactly one file, in a field named "document".',
          'the upload',
          'accept the uploaded file'
        )
      );
    }
    return next(
      documentError('The upload could not be received.', req.file?.originalname ?? 'the uploaded file', 'receive the upload')
    );
  });
};

/** Everything the frontend needs to know before it offers an upload. */
importRouter.get('/capabilities', (_req, res) => {
  const model = discoveredModel();
  res.json({
    data: {
      formats: SUPPORTED_FORMATS.map(f => ({
        format: f.format,
        label: f.label,
        extensions: f.extensions,
        mimeTypes: f.mimeTypes,
        reliable: f.reliable,
        note: f.note
      })),
      limits: LIMITS,
      maxBytes: MAX_BYTES,
      /** Real project columns an import may fill. */
      projectFields: importableProjectFields().map(f => ({
        name: f.name,
        kind: f.kind,
        required: f.required,
        values: f.values
      })),
      /** Real child entities an import may create, with their columns. */
      entities: importableEntities().map(e => ({
        path: e.path,
        label: e.label,
        model: e.model,
        table: e.table,
        codePrefix: e.codePrefix,
        fields: e.fields.map(f => ({ name: f.name, kind: f.kind, required: f.required, values: f.values }))
      })),
      enums: model.enums,
      /** Things this importer will not do, stated up front. */
      guarantees: {
        createsNewProjectOnly: true,
        modifiesExistingProjects: false,
        storesUploadedFile: false,
        usesExternalServices: false,
        requiresNetwork: false
      }
    }
  });
});

/** Parse + extract. No database access at all. */
importRouter.post('/analyze', receiveFile, async (req, res, next) => {
  try {
    const file = req.file;
    if (!file) {
      throw documentError(
        'No file was received. Choose a document to import and try again.',
        'the upload',
        'accept the uploaded file'
      );
    }

    const parsed = await parseDocument({
      buffer: file.buffer,
      filename: file.originalname,
      mimetype: file.mimetype
    });

    const extraction = extractDocument({ filename: file.originalname, text: parsed.text });

    if (extraction.projectFields.length === 0 && extraction.records.length === 0) {
      throw extractionError(
        'No project information could be read from that document.',
        'extract project information from the document',
        'Check that the file contains a project description, requirements or feature list, then try again.',
        { stats: extraction.stats, appliedRules: extraction.appliedRules }
      );
    }

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    const project: DraftField[] = extraction.projectFields.map(f => ({
      field: f.field,
      value: f.value,
      provenance: f.provenance,
      confidence: f.confidence,
      evidence: f.evidence,
      include: true
    }));

    // Order is preserved 1:1 with the extractor's output, so a `duplicateOf`
    // index still points at the same record in the draft the user reviews.
    const records: DraftRecord[] = extraction.records.map(r => ({
      entity: r.entity,
      values: r.values,
      provenance: r.provenance,
      confidence: r.confidence,
      horizon: r.horizon,
      evidence: r.evidence,
      include: true,
      ...(r.duplicateOf !== undefined ? { duplicateOf: r.duplicateOf } : {})
    }));

    /** Fields the document did not provide, so the UI can show them as empty. */
    const notFound = importableProjectFields()
      .filter(f => !extraction.projectFields.some(p => p.field === f.name))
      .map(f => f.name);

    res.json({
      data: {
        draft: {
          project,
          records,
          tags: [],
          source: {
            filename: file.originalname,
            format: parsed.format,
            mimeType: file.mimetype,
            sizeBytes: file.size,
            sha256,
            characters: parsed.text.length,
            stored: false as const
          },
          unsupported: extraction.unsupported
        },
        stats: extraction.stats,
        warnings: parsed.warnings,
        appliedRules: extraction.appliedRules,
        counts: {
          projectFields: project.length,
          records: records.length,
          duplicates: records.filter(r => r.duplicateOf !== undefined).length,
          inferred: [...project, ...records].filter(x => x.provenance === 'inferred').length,
          unsupportedConcepts: new Set(extraction.unsupported.map(u => u.concept)).size
        },
        notFound
      }
    });
  } catch (e) {
    next(e);
  }
});

/** Create the reviewed draft as one new project, in a single transaction. */
importRouter.post('/create', async (req, res, next) => {
  try {
    // An import always creates a new project. A projectId here would mean the
    // caller wanted to modify existing data, which this feature never does.
    if (req.body?.projectId !== undefined) {
      throw badRequest('Import always creates a new project and cannot target an existing one.', {
        received: 'projectId',
        allowed: 'none'
      });
    }

    const { mapped, unmapped, skipped } = validateDraft(req.body?.draft ?? req.body);

    const result = await importProject(prisma, mapped);

    res.status(201).json({
      data: {
        projectId: result.projectId,
        slug: result.slug,
        created: result.created,
        totalRecords: result.totalRecords
      },
      meta: {
        unmapped,
        skipped,
        source: mapped.source
      }
    });
  } catch (e) {
    next(e);
  }
});
