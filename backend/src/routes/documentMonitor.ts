import { Router } from 'express';
import {
  countPendingChanges,
  getMonitorStatus,
  listPendingChanges,
  listSkippedProjects,
  monitorSubscriberCount,
  resyncDocumentMonitor,
  subscribeToMonitor,
  type DocumentChangeNotification,
  type MonitorStatus
} from '../lib/projectDocumentMonitor.js';

/**
 * Phase 7: the application-wide document monitor API.
 *
 * Two things live here:
 *
 *   GET  /api/document-monitor          the service status and every pending change
 *   POST /api/document-monitor/resync   re-read the project list and rebuild watches
 *   GET  /api/document-monitor/stream   server-sent events, so the dashboard learns
 *                                       about a change the moment it is detected
 *
 * The stream exists because this project has no WebSocket infrastructure and no
 * frontend push library, and adding one for a single event type would be a much
 * larger change than the feature warrants. Server-sent events are already part of
 * HTTP, need no dependency on either side, and are one-directional - which is
 * exactly the shape of this problem. The client still re-fetches the status on
 * open and on reconnect, so a missed frame is a stale dashboard for a moment, not
 * a wrong one.
 *
 * Nothing here writes project data. `resync` rebuilds in-memory watches and reads
 * the project list; the only database writes in the whole feature are the four
 * monitoring columns, and they happen in the service, not in this router.
 */

const router = Router();

/**
 * The full monitor state for the dashboard.
 *
 * `pendingCount` is the badge number, counting only undismissed changes, so a
 * dismissed change disappears from the dashboard but not from `pending`.
 */
router.get('/', async (_req, res) => {
  const pending = listPendingChanges();
  res.json({
    data: {
      status: getMonitorStatus(),
      pending,
      pendingCount: countPendingChanges(),
      skipped: listSkippedProjects(),
      streamClients: monitorSubscriberCount()
    }
  });
});

/**
 * Rebuild the registrations from the current project list.
 *
 * Called after the Projects Root changes, and available to the UI for the same
 * reason. Tear-down and rebuild, so a project that was deleted elsewhere stops
 * being watched and a project that gained a folder starts being watched.
 */
router.post('/resync', async (_req, res) => {
  const status = await resyncDocumentMonitor();
  res.json({ data: { status, pending: listPendingChanges(), pendingCount: countPendingChanges() } });
});

/**
 * The change event stream.
 *
 * Server-sent events rather than WebSockets: this feature pushes one kind of
 * message and never needs to receive one, which is precisely what SSE is for. The
 * first frame is always a full snapshot so a client that connects late, or
 * reconnects after a dropped connection, is immediately correct.
 *
 * The keep-alive comment matters in practice: without it, proxies and the browser
 * can close an idle connection and the client would silently stop receiving
 * changes.
 */
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Defeats response buffering in nginx-style proxies.
    'X-Accel-Buffering': 'no'
  });
  // Ask the browser to wait a little before reconnecting rather than hot-looping.
  res.write('retry: 3000\n\n');

  const send = (event: string, id: string, payload: unknown) => {
    res.write(`event: ${event}\n`);
    if (id) res.write(`id: ${id}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send('snapshot', '', {
    status: getMonitorStatus(),
    pending: listPendingChanges(),
    pendingCount: countPendingChanges()
  });

  const unsubscribe = subscribeToMonitor(({ kind, payload }) => {
    if (kind === 'notification') {
      const notification = payload as DocumentChangeNotification;
      send('change', notification.id, {
        notification,
        status: getMonitorStatus(),
        pendingCount: countPendingChanges()
      });
    } else if (kind === 'dismissed') {
      send('dismissed', (payload as DocumentChangeNotification).id, {
        projectId: (payload as DocumentChangeNotification).projectId,
        status: getMonitorStatus(),
        pendingCount: countPendingChanges()
      });
    } else if (kind === 'synchronized') {
      const { projectId } = payload as { projectId: number };
      send('synchronized', '', {
        projectId,
        status: getMonitorStatus(),
        pendingCount: countPendingChanges()
      });
    }
  });

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
  keepAlive.unref?.();

  // Express does not know about this handler being long-lived, so the response
  // must be closed explicitly on every exit path or the request leaks.
  const close = () => {
    clearInterval(keepAlive);
    unsubscribe();
    res.end();
  };

  req.on('close', close);
  req.on('error', close);
  res.on('error', close);
});

export default router;

/** Re-exported so the Settings page can render the same status shape. */
export type { MonitorStatus };