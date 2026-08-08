import { initStatus } from "./init";

export const ALL_ITEM_IDS = ["youtrack_json", "youtrack_token", "vcs_json", "gitlab_token", "github_token"];
export const CONFIG_GAP_MARKER = "workflow config missing";

export function describeConfigGaps(scope?: string[]): { missing: string[]; ok: boolean } {
  let status: Record<string, any>;
  try {
    status = initStatus();
  } catch {
    return { missing: scope ?? ALL_ITEM_IDS, ok: false };
  }
  if (status.error) return { missing: scope ?? ALL_ITEM_IDS, ok: false };
  const items = status.items;
  if (!Array.isArray(items) || items.length === 0) return { missing: scope ?? ALL_ITEM_IDS, ok: false };
  const known = scope && scope.length > 0 ? scope : ALL_ITEM_IDS;
  const missing = items
    .filter((item) => item && item.ok === false)
    .map((item) => String(item.id))
    .filter((id) => known.includes(id));
  return { missing, ok: missing.length === 0 };
}

export function configGuardError(missing: string[]): string {
  return `${CONFIG_GAP_MARKER}: ${missing.join(", ")}. Run \`npx flowkit init\` or \`/wf-init\` to configure.`;
}
