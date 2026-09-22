import { createApp, prisma } from './app.js';
import type { Server } from 'http';

let server: Server | null = null;

export function startServer(port: number): Server {
  const app = createApp();
  server = app.listen(port, () => {
    console.log(`Project Hub API listening on http://localhost:${port}`);
  });
  return server;
}

export async function closeServer(): Promise<void> {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
  }
  await prisma.$disconnect();
}