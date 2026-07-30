import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(__dirname, '../..');
const marker = path.join(pluginDir, '.workflow-toolkit-root');
const share = path.join(os.homedir(), '.local/share/workflow-toolkit');

function resolveRoot() {
  if (process.env.WORKFLOW_TOOLKIT_ROOT) return process.env.WORKFLOW_TOOLKIT_ROOT;
  try {
    const fromMarker = fs.readFileSync(marker, 'utf8').trim();
    if (fromMarker && fs.existsSync(path.join(fromMarker, 'scripts'))) return fromMarker;
  } catch {
    // ponytail: marker only present on Cursor local installs
  }
  if (fs.existsSync(path.join(share, 'scripts'))) return share;
  // Live monorepo: cursor/mcp/lib → repo root
  return path.resolve(__dirname, '../../..');
}

export const PLUGIN_ROOT = resolveRoot();
