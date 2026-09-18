import path from 'node:path';
import os from 'node:os';

const dataRoot = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
// Share the already validated store. Existing Probe cards survive plugin updates.
export const cardStateDir = process.env.LOVART_CARD_STATE_DIR || process.env.LOVART_PROBE_STATE_DIR || path.join(dataRoot, 'lovart-ui-probe');
export const mediaOutputDir = process.env.LOVART_OUTPUT_DIR || path.join(dataRoot, 'lovart', 'downloads');
