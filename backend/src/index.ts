import { startServer } from './server.js';

const port = Number(process.env.BACKEND_PORT || 4000);
startServer(port);