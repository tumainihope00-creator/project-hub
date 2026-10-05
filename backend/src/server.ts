import { createApp, prisma } from './app.js';
import { startDocumentMonitor, stopDocumentMonitor } from './lib/projectDocumentMonitor.js';
import type { Server } from 'http';

let server: Server | null = null;

/**
 * Start the HTTP server, then the document monitor.
 *
 * The monitor starts after the listener is up but is deliberately not allowed to
 * fail the startup: a machine where filesystem watching is unavailable, or a
 * database that is briefly unreachable, should still give the user a working
 * Project Hub with the monitor reporting itself as degraded, rather than a server
 * that refuses to boot. `startDocumentMonitor` never throws for an individual
 * project either.
 */
export function startServer(port: number): Server {
  const app = createApp();
  server = app.listen(port, () => {
    console.log(`Project Hub API listening on http://localhost:${port}`);
  });

  void startDocumentMonitor().catch(err => {
    console.warn('[project-hub] The document monitor did not start:', err instanceof Error ? err.message : err);
  });

  return server;
}

/**
 * Shut down cleanly.
 *
 * Order matters: the monitor's watchers and timers are closed first, so nothing
 * can fire a database call after the Prisma client has been disconnected, and so
 * the process is not held open by a `persistent` watcher or an interval.
 * Idempotent, and safe when the server was never started.
 */
export async function closeServer(): Promise<void> {
  await stopDocumentMonitor();
  if (server) {
    const closing = server;
    server = null;
    // Open SSE responses keep the server from closing on its own; end them so
    // shutdown is not waiting on a browser that may already be gone.
    closing.closeAllConnections?.();
    await new Promise<void>(resolve => closing.close(() => resolve()));
  }
  await prisma.$disconnect();
}