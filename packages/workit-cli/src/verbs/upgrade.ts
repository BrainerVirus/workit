// `workit upgrade`. A person's plain upgrade at their terminal ends with the
// one-time seal offer when workspaces.json was never sealed (#819).
import { type Io } from "../output";
import { runUpgradeCommand } from "../upgrade";
import { offerFirstSeal } from "../upgrade/seal-offer";

/** Flags of a scripted, read-only or settings run: no offer. */
const QUIET = new Set(["--check", "--preview", "--yes", "--json", "--apply"]);

export const run = async (argv: string[], io?: Io): Promise<number> => {
  const code = await runUpgradeCommand(argv);
  const plain = !argv.some((arg) => QUIET.has(arg) || arg.startsWith("--set-updates"));
  // The half an older CLI re-executes leaves the offer to the run the user started.
  if (io && code === 0 && plain && io.env.WORKIT_UPGRADE_CONTINUE === undefined)
    await offerFirstSeal(io);
  return code;
};
