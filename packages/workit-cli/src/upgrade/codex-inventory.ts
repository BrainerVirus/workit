import type { CommandResult } from "./shared";

// An unscoped `codex plugin list --json` also fetches OpenAI's remote plugin
// catalog (30 s or more on a cold cache), though Workit only needs the rows of
// the marketplaces configured on this machine. So the inventory lists those
// marketplaces (local, instant) and asks each for its own plugins.

const UNSCOPED = ["plugin", "list", "--json"];
const MARKETPLACES = ["plugin", "marketplace", "list", "--json"];

/** Codex's remote marketplaces: listing one of them is the network fetch. */
const REMOTE_MARKETPLACES = new Set([
  "openai-curated-remote",
  "created-by-me-remote",
  "workspace-directory",
  "workspace-shared-with-me",
  "workspace-shared-with-me-private",
  "workspace-shared-with-me-unlisted",
]);

/** The probe-cache key of the merged inventory (it is one probe made of several commands). */
export const CODEX_INVENTORY_ARGS = [...UNSCOPED, "--marketplace", "<configured>"];
export const CODEX_INVENTORY_KEY = ["codex", ...CODEX_INVENTORY_ARGS].join(" ");

const scoped = (name: string) => [...UNSCOPED, "--marketplace", name];

/** The local marketplace names, or a failed result when the listing is not JSON. */
const marketplaceNames = (listing: CommandResult): string[] | CommandResult => {
  try {
    // Codex 0.166 prints {"marketplaces": [...]}; accept a bare array too.
    const parsed: unknown = JSON.parse(listing.stdout);
    const rows = Array.isArray(parsed)
      ? parsed
      : (parsed as { marketplaces?: unknown })?.marketplaces;
    if (!Array.isArray(rows)) throw new Error("not an array");
    return rows
      .map((row: { name?: unknown }) => row?.name)
      .filter((name): name is string => typeof name === "string" && !REMOTE_MARKETPLACES.has(name));
  } catch {
    return {
      status: 1,
      stdout: "",
      stderr: "`codex plugin marketplace list --json` returned output that is not JSON",
    };
  }
};

/** The `installed` rows of every marketplace's listing, as one `plugin list --json` answer. */
const merge = (results: CommandResult[]): CommandResult => {
  const installed: unknown[] = [];
  for (const result of results) {
    try {
      const rows = JSON.parse(result.stdout)?.installed ?? [];
      if (!Array.isArray(rows)) return result;
      installed.push(...rows);
    } catch {
      return result;
    }
  }
  return { status: 0, stdout: JSON.stringify({ installed }) };
};

const timedOut = (...results: CommandResult[]) => results.find((result) => result.timedOut);

/**
 * Plugin inventory without the remote catalog. A Codex that cannot list
 * marketplaces or scope the listing (an older one) falls back to the unscoped
 * list; a timeout is returned as is.
 */
export const codexInventory = async (
  run: (command: string, args: string[]) => Promise<CommandResult>,
): Promise<CommandResult> => {
  const marketplaces = await run("codex", MARKETPLACES);
  if (marketplaces.timedOut) return marketplaces;
  if (marketplaces.status !== 0) return run("codex", UNSCOPED);
  const names = marketplaceNames(marketplaces);
  if (!Array.isArray(names)) return names;
  const results = await Promise.all(names.map((name) => run("codex", scoped(name))));
  return (
    timedOut(...results) ??
    (results.some((result) => result.status !== 0) ? run("codex", UNSCOPED) : merge(results))
  );
};

/** `codexInventory` for the synchronous planner. */
export const codexInventorySync = (
  run: (command: string, args: string[]) => CommandResult,
): CommandResult => {
  const marketplaces = run("codex", MARKETPLACES);
  if (marketplaces.timedOut) return marketplaces;
  if (marketplaces.status !== 0) return run("codex", UNSCOPED);
  const names = marketplaceNames(marketplaces);
  if (!Array.isArray(names)) return names;
  const results = names.map((name) => run("codex", scoped(name)));
  return (
    timedOut(...results) ??
    (results.some((result) => result.status !== 0) ? run("codex", UNSCOPED) : merge(results))
  );
};
