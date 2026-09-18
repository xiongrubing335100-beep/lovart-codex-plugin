import path from 'node:path';
import os from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createProbeServer } from './server.js';
const directory = process.env.LOVART_PROBE_STATE_DIR || path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'lovart-ui-probe');
const { server } = createProbeServer(directory);
await server.connect(new StdioServerTransport());
