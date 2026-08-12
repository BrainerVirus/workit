import { assetRoot, packageRoot } from "./package-root";

export const PLUGIN_ROOT = packageRoot();
export const ASSET_ROOT = assetRoot();

export const resolveWorkspaceRoot = (explicit?: string) => explicit || process.cwd();
