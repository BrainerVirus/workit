// `workit upgrade`.
import { runUpgradeCommand } from "../upgrade";

export const run = (argv: string[]): Promise<number> => runUpgradeCommand(argv);
