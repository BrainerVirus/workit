// Placeholder for a verb whose slice has not landed. It answers with the
// shared envelope (`not_implemented`, exit 2) so agents and scripts get a
// structured answer instead of the help text.
import { emit, fail, type Verb } from "../output";

export const notImplemented =
  (verb: string, slice: string): Verb["run"] =>
  async (argv, io) =>
    emit(
      io,
      fail("not_implemented", `${verb} is not implemented yet (planned in ${slice})`, {
        data: { verb, subcommand: argv.find((arg) => !arg.startsWith("-")) ?? null, slice },
      }),
    );
