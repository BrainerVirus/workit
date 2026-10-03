// `workit uninstall`: interactive host picker, ink/react loaded lazily.
import { emit, fail, type Io } from "../output";

export async function run(_argv: string[], io: Io): Promise<number> {
  if (io.json)
    return emit(
      io,
      fail("invalid_input", "workit uninstall is interactive and has no --json output", {
        unblock: "run `workit uninstall` in a terminal without --json",
      }),
    );
  const { runUninstall } = await import("../index");
  await runUninstall();
  return 0;
}
