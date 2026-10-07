// `workit knowledge lint`: deterministic checks over the repository's agent
// knowledge files (AGENTS.md byte budget, broken local links and pointers,
// scaffold-only need-based files, rules duplicated between AGENTS.md and
// CODING_STANDARDS.md). Read-only; exit 1 when anything is found, so a repo
// can register it as a configured check:
//
//   workit knowledge lint [--json]
//   workit.checks.json: {"checks":{"knowledge":"workit knowledge lint"}}
import { checkRoot } from "@brainervirus/workit-core/src/check-config";
import { lintKnowledge } from "@brainervirus/workit-core/src/knowledge";
import { emit, fail, ok, type Io } from "../output";

const USAGE = "workit knowledge lint [--json]";

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv.filter((arg) => arg !== "--json");
  if (sub !== "lint" || rest.length > 0) return emit(io, fail("invalid_input", `usage: ${USAGE}`));
  const report = lintKnowledge(checkRoot(io.cwd));
  const summary = `knowledge lint: ${report.findings.length} finding${report.findings.length === 1 ? "" : "s"} in ${report.files.length} file${report.files.length === 1 ? "" : "s"} (${report.files.map((file) => `${file.file} ${file.bytes} B`).join(", ") || "no knowledge files"}; AGENTS.md budget ${report.budget} B)`;
  if (io.json)
    return emit(
      io,
      report.findings.length === 0 ? ok(report) : fail("failed", summary, { data: report }),
    );
  for (const finding of report.findings)
    io.stdout(
      `${finding.file}${finding.line === null ? "" : `:${finding.line}`} [${finding.rule}] ${finding.message}\n`,
    );
  io.stdout(`${summary}\n`);
  return report.findings.length === 0 ? 0 : 1;
}
