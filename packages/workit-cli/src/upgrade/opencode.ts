// OpenCode v2 forwards `opencode plugin …` to its shared background service. A
// location there builds a baseline first and activates package plugins in a
// background PluginBoot fiber, so a plugin command that arrives before that
// fails with `Plugin is not configured`. `opencode api plugin.list` answers for
// the service's default location (HOME) whatever the cwd, while `plugin list`
// and `plugin update` act on the cwd's location. So every OpenCode plugin
// command runs in ONE location, the user's HOME (the service default, the warm
// one; package plugins are global, so the location does not change what is
// updated), the api call names it with `x-opencode-directory`, and readiness
// needs both the api and `plugin list` in that location to list Workit.
import { OPENCODE_PACKAGE, type CommandResult, type RunOptions, type UpgradeDeps } from "./shared";

type AsyncRun = (command: string, args: string[], options?: RunOptions) => Promise<CommandResult>;

/** `opencode api plugin.list` for the location at `home`. */
const pluginApiArgs = (home: string): string[] => [
  "api",
  "plugin.list",
  "-H",
  `x-opencode-directory:${home}`,
];
const PLUGIN_LIST = ["plugin", "list"];
const OPENCODE_READY_TIMEOUT_MS = 20_000;
const READY_INTERVAL_MS = 500;
export const OPENCODE_NOT_READY = `OpenCode did not finish loading its plugins (opencode api plugin.list never listed ${OPENCODE_PACKAGE})`;

/** What OpenCode reports for the Workit plugin. */
export type OpencodePlugin = {
  /** "api": `opencode api plugin.list` answered; "list": the text fallback for an older 2.x. */
  via: "api" | "list";
  /** The service listed the Workit package (any status). */
  listed: boolean;
  version?: string;
  outdated?: boolean;
  status?: string;
};

const isWorkitTarget = (target: unknown): boolean =>
  typeof target === "string" &&
  /^(?:npm:)?@brainervirus\/workit-opencode(?:@[^/\s]+)?$/.test(target);

/** An `opencode api` that does not know the operation (an older 2.x), not a service still starting. */
const lacksApi = (result: CommandResult): boolean =>
  result.status !== 0 &&
  !result.timedOut &&
  /\b(?:unknown|unrecognized|unsupported) (?:command|operation|argument)|\bno such (?:command|operation)/i.test(
    `${result.stdout}\n${result.stderr ?? ""}`,
  );

/**
 * The Workit entry from `opencode api plugin.list` JSON
 * (`{location, data:[{id, source:{type,target,version,outdated}, state:{status}}]}`),
 * or null when the call failed or printed something else (not ready yet).
 */
const parsePluginApi = (result: CommandResult): OpencodePlugin | null => {
  if (result.status !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const data = (parsed as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const entry = data.find((item) => isWorkitTarget(item?.source?.target));
  if (!entry) return { via: "api", listed: false };
  const version = entry.source?.version;
  return {
    via: "api",
    listed: true,
    ...(typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) ? { version } : {}),
    ...(typeof entry.source?.outdated === "boolean" ? { outdated: entry.source.outdated } : {}),
    ...(typeof entry.state?.status === "string" ? { status: entry.state.status } : {}),
  };
};

/** The Workit row of `opencode plugin list` (`ID  VERSION  SOURCE`); `No plugins found` is not listed. */
const parsePluginList = (result: CommandResult): OpencodePlugin => {
  if (result.status === 0)
    for (const line of result.stdout.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 3) continue;
      const source = fields[fields.length - 1].replace(/^file:\/\//, "");
      const version = fields[fields.length - 2];
      if (isWorkitTarget(source) && /^\d+\.\d+\.\d+$/.test(version))
        return { via: "list", listed: true, version };
    }
  return { via: "list", listed: false };
};

/** One reading in HOME's location: the api when it answers, else the text listing. */
export const readOpencodePlugin = async (run: AsyncRun, home: string): Promise<OpencodePlugin> =>
  parsePluginApi(await run("opencode", pluginApiArgs(home), { cwd: home })) ??
  parsePluginList(await run("opencode", PLUGIN_LIST, { cwd: home }));

type ReadyOptions = NonNullable<UpgradeDeps["opencodeReady"]>;

/**
 * Poll until OpenCode lists the Workit package in HOME's location, bounded by
 * `timeoutMs`; null when it never did. Ready needs `plugin list` (the location
 * the update runs in) to list Workit, and the api to list it too unless this
 * OpenCode lacks the api operation. A failed or erroring api call, or `No
 * plugins found`, is not ready yet: the poll goes on.
 */
export const waitForOpencodePlugin = async (
  run: AsyncRun,
  home: string,
  options: ReadyOptions = {},
): Promise<OpencodePlugin | null> => {
  const timeoutMs = options.timeoutMs ?? OPENCODE_READY_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? READY_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let textOnly = false;
  for (;;) {
    let api: OpencodePlugin | null = null;
    if (!textOnly) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- a readiness poll: each reading decides whether to wait for the next one.
      const result = await run("opencode", pluginApiArgs(home), { cwd: home });
      api = parsePluginApi(result);
      textOnly = !api && lacksApi(result);
    }
    if (textOnly || api?.listed) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- the location the update runs in must list Workit too.
      const text = parsePluginList(await run("opencode", PLUGIN_LIST, { cwd: home }));
      if (text.listed) return api?.listed ? { ...api, version: api.version ?? text.version } : text;
    }
    if (now() >= deadline) return null;
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- the poll interval between readings.
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
};
