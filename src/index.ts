import { startMcpServer } from './mcp-server';
import { startRestApi } from './rest-api';

console.log('[nanofleet-tasks] Starting...');

await Promise.all([
  startMcpServer(),
  startRestApi(),
]);

console.log('[nanofleet-tasks] Ready');
