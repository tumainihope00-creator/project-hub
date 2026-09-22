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

  // Generic project-scoped resource routes
  for (const def of RESOURCES) {
    const base = `/api/projects/:projectId/${def.path}`;
    app.use(base, resourceRouter(def));
    if (def.path === 'prompts') app.use(base, promptVersionRouter());
    if (def.path === 'documents') app.use(base, documentVersionRouter());
    if (def.path === 'features') app.use(base, featureRequirementsRouter());
  }

  app.use((_req, res) => {
    res.status(404).json({ error: { message: 'Not found' } });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { message: err.message, details: err.details } });
    }
    if (err && typeof err === 'object' && (err as any).code === 'P2025') {
      return res.status(404).json({ error: { message: 'Record not found' } });
    }
    if (err && typeof err === 'object' && (err as any).code === 'P2002') {
      return res.status(409).json({ error: { message: 'Unique constraint violation' } });
    }
    if (err && typeof err === 'object' && (err as any).code === 'P2003') {
      return res.status(409).json({ error: { message: 'Foreign key constraint violation', details: (err as any).meta } });
    }
    console.error(err);
    res.status(500).json({ error: { message: 'Internal server error' } });
  });

  return app;
}

export { prisma };