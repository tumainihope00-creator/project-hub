import { closeServer, startServer } from './server.js';

const port = Number(process.env.BACKEND_PORT || 4000);
startServer(port);

/**
 * Shut down on a termination signal.
 *
 * Phase 7 adds persistent filesystem watchers and intervals, so the process now
 * has handles that would otherwise keep it alive. Handling SIGINT and SIGTERM
 * means Ctrl+C in the server console closes the watchers and the database
 * connection instead of leaving them to be reclaimed by the OS. The Project Hub
 * stop script force-kills its process tree and never reaches this path; this is
 * for the interactive console and for anything that terminates politely.
 */
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[project-hub] ${signal} received, shutting down.`);
    closeServer()
      .then(() => process.exit(0))
      .catch(err => {
        console.error('[project-hub] Shutdown failed:', err);
        process.exit(1);
      });
  });
}