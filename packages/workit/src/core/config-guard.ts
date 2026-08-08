import { initStatus } from "./init";

export const ALL_ITEM_IDS = ["youtrack_json", "youtrack_token", "vcs_json", "gitlab_token", "github_token"];
export const CONFIG_GAP_MARKER = "workflow config missing";

export function describeConfigGaps(scope?: string[]): { missing: string[]; ok: boolean } {
  const all = scope ?? ALL_ITEM_IDS;
  try {
    const status: unknown = initStatus();
    if (!status || typeof status !== "object" || (status as Record<string, unknown>).error) return { missing: all, ok: false };
    const items = (status as Record<string, unknown>).items;
    if (!Array.isArray(items) || items.length === 0) return { missing: all, ok: false };
    const known = all;
    const missing = items
      .filter((item) => item && (item as Record<string, unknown>).ok === false)
      .map((item) => String((item as Record<string, unknown>).id))
      .filter((id) => known.includes(id));
    return { missing, ok: missing.length === 0 };
  } catch {
    return { missing: all, ok: false };
  }
}

export function configGuardError(missing: string[]): string {
  return `${CONFIG_GAP_MARKER}: ${missing.join(", ")}. Run \`npx workit init\` or \`/wk-init\` to configure.`;
}
