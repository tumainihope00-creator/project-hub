import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { resyncDocumentMonitor } from '../lib/projectDocumentMonitor.js';
import {
  clearProjectsRoot,
  getProjectsRoot,
  initializeProjectsRoot,
  PROJECTS_ROOT_KEY,
  saveProjectsRoot,
  testProjectsRoot
} from '../lib/settings.js';

/**
 * Application settings API.
 *
 * Only one setting exists in this phase: the Projects Root, the folder that
 * will contain every project folder Project Hub manages.
 *
 * Path validation is deliberately split into separate operations so that
 * checking something never changes it:
 *
 *   GET    the stored value, plus a read-only check that creates nothing
 *   PUT    save a new value. Validates, reads, and stores. Creates nothing.
 *   POST /test       full connection test, including a real write probe
 *   POST /initialize  create the folder, only because the user asked
 *   DELETE  forget the value. Never touches the folder on disk.
 *
 * There is no endpoint that deletes, moves, cleans, overwrites or lists folder
 * contents, and no endpoint that runs a shell command. A supplied path is only
 * ever passed to the safe filesystem calls in lib/paths.ts.
 */
const router = Router();

/**
 * `path` is deliberately optional here: a missing key and an empty string are
 * the same user mistake, so both fall through to the normalizer in
 * lib/paths.ts and come back with the same `PATH_EMPTY` code rather than two
 * different error shapes. Length and shape checks live there too, so every
 * caller gets identical structured error codes. `.strict()` still rejects any
 * field that is not part of this API.
 */
const optionalBodySchema = z.object({ path: z.string().optional().nullable() }).strict();

router.get('/projects-root', async (_req, res, next) => {
  try {
    res.json({ data: await getProjectsRoot() });
  } catch (e) {
    next(e);
  }
});

router.put('/projects-root', async (req, res, next) => {
  try {
    const parsed = optionalBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('Invalid input', parsed.error.flatten());
    const saved = await saveProjectsRoot(parsed.data.path ?? undefined);
    // Phase 7: the Projects Root decides where every PROJECT.md may be read from,
    // so changing it invalidates every watcher. Rebuild them immediately instead
    // of leaving watches on folders that are no longer inside the root, or on
    // nothing at all when the root was previously unset.
    //
    // Best-effort and non-fatal: the setting is already saved, and a monitor that
    // cannot rebuild is a degraded monitor, not a failed save.
    const monitor = await resyncDocumentMonitor().catch(err => {
      console.warn(
        '[document-monitor] could not rebuild watches after the Projects Root changed:',
        err instanceof Error ? err.message : err
      );
      return null;
    });
    res.json({ data: { ...saved, documentMonitor: monitor } });
  } catch (e) {
    next(e);
  }
});

router.post('/projects-root/test', async (req, res, next) => {
  try {
    const parsed = optionalBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('Invalid input', parsed.error.flatten());
    res.json({ data: await testProjectsRoot(parsed.data.path ?? undefined) });
  } catch (e) {
    next(e);
  }
});

router.post('/projects-root/initialize', async (req, res, next) => {
  try {
    const parsed = optionalBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('Invalid input', parsed.error.flatten());
    res.json({ data: await initializeProjectsRoot(parsed.data.path ?? undefined) });
  } catch (e) {
    next(e);
  }
});

router.delete('/projects-root', async (_req, res, next) => {
  try {
    const cleared = await clearProjectsRoot();
    // Nothing can be resolved without a root, so stop every watcher rather than
    // leaving them pointed at folders Project Hub can no longer vouch for.
    const monitor = await resyncDocumentMonitor().catch(err => {
      console.warn(
        '[document-monitor] could not stop watches after clearing the Projects Root:',
        err instanceof Error ? err.message : err
      );
      return null;
    });
    res.json({ data: { ...cleared, documentMonitor: monitor } });
  } catch (e) {
    next(e);
  }
});

/** Which setting keys this build understands, for the Settings page. */
router.get('/', async (_req, res) => {
  res.json({ data: { keys: [PROJECTS_ROOT_KEY] } });
});

export default router;
