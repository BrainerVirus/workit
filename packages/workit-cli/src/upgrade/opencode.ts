// OpenCode v2 forwards `opencode plugin …` to its shared background service. A
// location there builds a baseline first and activates package plugins in a
// background PluginBoot fiber, so a plugin command that arrives before that
// fails with `Plugin is not configured`. Workit asks the service itself
// (`opencode api plugin.list`) and waits until it lists the Workit package.
import { OPENCODE_PACKAGE, type CommandResult, type UpgradeDeps } from "./shared";

type AsyncRun = (command: string, args: string[]) => Promise<CommandResult>;

const PLUGIN_API = ["api", "plugin.list"];
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

/**
 * The Workit entry from `opencode api plugin.list` JSON
 * (`{location, data:[{id, source:{type,target,version,outdated}, state:{status}}]}`),
 * or null when the output is not that shape (the api operation is unavailable).
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

/** The Workit row of `opencode plugin list` (`ID  VERSION  SOURCE`), for an OpenCode without the api. */
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

/** One reading: the api when OpenCode has it, else the text listing. */
export const readOpencodePlugin = async (run: AsyncRun): Promise<OpencodePlugin> =>
  parsePluginApi(await run("opencode", PLUGIN_API)) ??
  parsePluginList(await run("opencode", ["plugin", "list"]));

type ReadyOptions = NonNullable<UpgradeDeps["opencodeReady"]>;

/**
 * Poll `opencode api plugin.list` until the service lists the Workit package,
 * bounded by `timeoutMs`. Returns the reading, or null when it never appeared.
 * An OpenCode without the api operation falls back to one text listing.
 */
export const waitForOpencodePlugin = async (
  run: AsyncRun,
  options: ReadyOptions = {},
): Promise<OpencodePlugin | null> => {
  const timeoutMs = options.timeoutMs ?? OPENCODE_READY_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? READY_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  for (;;) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- a readiness poll: each reading decides whether to wait for the next one.
    const reading = parsePluginApi(await run("opencode", PLUGIN_API));
    if (!reading) return parsePluginList(await run("opencode", ["plugin", "list"]));
    if (reading.listed) return reading;
    if (now() >= deadline) return null;
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- the poll interval between readings.
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
};
