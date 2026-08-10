import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(dirname, "../..");

export const resolveWorkspaceRoot = (explicit?: string) => explicit || process.cwd();
