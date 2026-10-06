import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { ApiError } from './lib/errors.js';
import { prisma } from './lib/prisma.js';
import { RESOURCES } from './resources.js';
import { resourceRouter, promptVersionRouter, documentVersionRouter, featureRequirementsRouter } from './routes/generic.js';
import projectsRouter from './routes/projects.js';
import miscRouter from './routes/misc.js';
import { generatorRouter } from './routes/generator.js';
import { importRouter } from './routes/import.js';
import settingsRouter from './routes/settings.js';
import documentMonitorRouter from './routes/documentMonitor.js';
import { globalPromptsRouter, projectPromptsRouter } from './routes/prompts.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  const origin = process.env.CORS_ORIGIN || 'http://localhost:5173';
  app.use(cors({ origin: origin.split(','), credentials: false }));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    rateLimit({
      windowMs: 60_000,
      max: 600,
      standardHeaders: true,
      legacyHeaders: false
    })
  );

  app.get('/api/health', (_req, res) => {
    res.json({ data: { status: 'ok', time: new Date().toISOString() } });
  });

  app.get('/api/meta', (_req, res) => {
    res.json({
      data: {
        stages: RESOURCES.length ? 'see /api/projects' : null,
        resources: RESOURCES.map(r => r.path)
      }
    });
  });

  app.use('/api/projects', projectsRouter);
  app.use('/api', miscRouter);

  // Application settings (Projects Root). Application-wide, not project data.
  app.use('/api/settings', settingsRouter);

  // Application-wide PROJECT.md monitoring (Phase 7). One centralized service
  // behind this router, never one per client.
  app.use('/api/document-monitor', documentMonitorRouter);

  // Document import (creates new projects only; never modifies existing data)
  app.use('/api/import', importRouter);

  // V1 Prompt Generator (project-scoped)
  app.use('/api/projects/:projectId/generator', generatorRouter());

  // Phase 8: prompt generation, copy and archive. Mounted before the generic
  // resource routes below so `prompts/generate` and `prompts/:id/copy` are read
  // as named paths rather than as prompt ids. The global prompt search sits
  // outside any project scope.
  app.use('/api/projects/:projectId/prompts', projectPromptsRouter());
  app.use('/api/prompts', globalPromptsRouter());

  // Generic project-scoped resource routes
  for (const def of RESOURCES) {
    const base = `/api/projects/:projectId/${def.path}`;
    app.use(base, resourceRouter(def));
    if (def.path === 'prompts') app.use(base, promptVersionRouter());
    if (def.path === 'documents') app.use(base, documentVersionRouter());
    if (def.path === 'features') app.use(base, featureRequirementsRouter());
  }

  // Any unmatched route: say what was wrong, never a bare "Not found".
  app.use((req, res) => {
    res.status(404).json({
      error: {
        message: `No API route matches ${req.method} ${req.path}.`,
        category: 'NOT_FOUND',
        operation: 'route the request to an API handler',
        possibleAction:
          'This is an internal link or client bug, not missing project data. Check the URL, or reload the Project Hub page.'
      }
    });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: err.toBody() });
    }
    const code = err && typeof err === 'object' ? (err as any).code : undefined;
    if (code === 'P2025') {
      return res.status(404).json({
        error: {
          message: 'The requested record no longer exists.',
          category: 'NOT_FOUND',
          operation: 'load a record by id',
          possibleAction: 'It may have been deleted. Reload the page to see the current data.'
        }
      });
    }
    if (code === 'P2002') {
      return res.status(409).json({
        error: {
          message: 'A record with the same unique key already exists.',
          category: 'VALIDATION_FAILED',
          operation: 'write a record with a unique constraint',
          details: (err as any).meta,
          possibleAction: 'Use a different value for the duplicated field.'
        }
      });
    }
    if (code === 'P2003') {
      return res.status(409).json({
        error: {
          message: 'This change would break a reference to a record that does not exist.',
          category: 'VALIDATION_FAILED',
          operation: 'write a record with a foreign key',
          details: (err as any).meta,
          possibleAction: 'Create the referenced record first, or clear the reference.'
        }
      });
    }
    // Prisma/connection failures: a system problem, not missing information.
    const message = err instanceof Error ? err.message : String(err);
    const isDbProblem =
      code?.startsWith?.('P') === true ||
      /prisma|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|timeout|socket|pool/i.test(message);
    console.error(err);
    return res.status(500).json({
      error: {
        message: isDbProblem
          ? 'Project Hub could not reach its database, so the project data could not be read.'
          : 'Project Hub hit an unexpected internal error while handling this request.',
        category: isDbProblem ? 'SYSTEM_ERROR' : 'SYSTEM_ERROR',
        operation: `${req.method} ${req.path}`,
        possibleAction: isDbProblem
          ? 'Check that the database is running and DATABASE_URL is correct, then retry.'
          : 'Retry. If it keeps failing, check the backend logs for the stack trace.',
        details: { cause: message }
      }
    });
  });

  return app;
}

export { prisma };