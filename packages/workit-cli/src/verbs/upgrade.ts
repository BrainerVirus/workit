// `workit upgrade`. A person's upgrade at their terminal ends with the
// one-time seal offer when workspaces.json was never sealed (#819). The
// upgrade that installs a new CLI hands off to it: the older CLI re-executes
// the new one with --yes and WORKIT_UPGRADE_CONTINUE, so that half offers at
// the user's terminal whatever --yes says (it is the user's own run).
import pkg from "../../package.json" with { type: "json" };
import { type Io } from "../output";
import { runUpgradeCommand } from "../upgrade";
import { offerFirstSeal } from "../upgrade/seal-offer";
import { cliVersionOnDisk } from "../update-settings";
import { type GrantDeps } from "./grant";

/** Read-only or settings runs: no offer. */
const READ_ONLY = new Set(["--check", "--preview", "--json", "--apply"]);

/** Test seams: the upgrade itself, the terminal, the CLI version now on disk. */
export type UpgradeVerbDeps = {
  upgrade?: (argv: string[]) => Promise<number>;
  terminal?: GrantDeps;
  versionOnDisk?: () => string | undefined;
};

/** Whether this run ends with the first-seal offer (offerFirstSeal still needs a terminal). */
export const sealOfferDue = (
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  versionOnDisk: () => string | undefined = cliVersionOnDisk,
): boolean => {
  if (argv.some((arg) => READ_ONLY.has(arg) || arg.startsWith("--set-updates"))) return false;
  // The new CLI finishing the user's upgrade: it offers, --yes or not.
  if (env.WORKIT_UPGRADE_CONTINUE !== undefined) return true;
  if (argv.includes("--yes")) return false;
  // A newer CLI this run handed off to has made the offer already.
  const onDisk = versionOnDisk();
  return onDisk === undefined || onDisk === pkg.version;
};

export const run = async (argv: string[], io?: Io, deps: UpgradeVerbDeps = {}): Promise<number> => {
  const code = await (deps.upgrade ?? runUpgradeCommand)(argv);
  if (io && code === 0 && sealOfferDue(argv, io.env, deps.versionOnDisk))
    await offerFirstSeal(io, deps.terminal);
  return code;
};
