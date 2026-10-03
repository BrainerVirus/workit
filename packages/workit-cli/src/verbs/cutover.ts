// `workit cutover preview|apply|rollback`.
import { runCutoverCommand } from "../cutover-cli";

export const run = (argv: string[]): Promise<number> => runCutoverCommand(argv);
