export function resolveWorkspaceRoot(explicit) {
  return explicit || process.cwd();
}
