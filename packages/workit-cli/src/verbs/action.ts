// `workit action <operation> --payload <JSON>`: one approved external action.
import type { Io } from "../output";

export async function run(argv: string[], io: Io): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    const { externalActionHelp } =
      await import("@brainervirus/workit-core/src/core/external-action");
    io.stdout(
      `usage: workit action <operation> --payload <JSON> [--task <id>] [--preview] [--json]\n`,
    );
    io.stdout(`action payloads: ${externalActionHelp}\n`);
    return 0;
  }
  const { runActionCommand } = await import("../task");
  return runActionCommand(argv);
}
