// `workit launch <host>`.
import { runLaunchCommand } from "../upgrade";

export const run = (argv: string[]): Promise<number> => runLaunchCommand(argv);
