// `workit init`: the only verbs that load ink/react do it here, lazily.
import { emit, fail, type Io } from "../output";

export async function run(_argv: string[], io: Io): Promise<number> {
  if (io.json)
    return emit(
      io,
      fail("invalid_input", "workit init is an interactive wizard and has no --json output", {
        unblock: "run `workit init` in a terminal without --json",
      }),
    );
  const { runInit } = await import("../index");
  await runInit();
  return 0;
}
