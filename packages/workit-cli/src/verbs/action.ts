// `workit action <operation> --payload <JSON>`: one approved external action.
import { emit, ok, type Io } from "../output";

export async function run(argv: string[], io: Io): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    const { externalActionHelp } =
      await import("@brainervirus/workit-core/src/core/external-action");
    const usage =
      "usage: workit action <operation> --payload <JSON> [--task <id>] [--preview] [--json]";
    return emit(io, ok({ usage, payloads: externalActionHelp }), () => [
      usage,
      `action payloads: ${externalActionHelp}`,
    ]);
  }
  const { runActionCommand } = await import("../task");
  return runActionCommand(argv);
}
