// `workit handoff`: `--task <id>` keeps the existing task export until S15;
// the bare resume brief is a stub until S13 replaces it (design §2.1).
import type { Io } from "../output";
import { notImplemented } from "./stub";

const brief = notImplemented("handoff", "S13");

export async function run(argv: string[], io: Io): Promise<number> {
  if (!argv.includes("--task")) return brief(argv, io);
  const { runTaskCommand } = await import("../task");
  return runTaskCommand(["handoff", ...argv]);
}
