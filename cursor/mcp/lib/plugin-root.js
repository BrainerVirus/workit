import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PLUGIN_ROOT =
  process.env.WORKFLOW_TOOLKIT_ROOT ||
  path.resolve(__dirname, '../../..');
