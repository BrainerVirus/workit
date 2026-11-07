import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { currentJudgment } from "@brainervirus/workit-core/src/core/policy/current-judgment";
import {
  branchLane,
  REVIEW_LANES,
  type ReviewLane,
} from "@brainervirus/workit-core/src/core/policy/lane";
import { commentStyle } from "@brainervirus/workit-core/src/deslop/lex";
import {
  DESLOP_CLASSES,
  DESLOP_PASSES,
  deslopResultLine,
  lanePasses,
  raiseLane,
  scanSource,
  type DeslopClass,
  type DeslopFinding,
  type LaneRaise,
} from "@brainervirus/workit-core/src/deslop/scan";
import { defaultBase } from "@brainervirus/workit-core/src/git/default-base";
import { actorFromEnv, appendObserved, codeKey } from "@brainervirus/workit-core/src/ledger";
import { changedLines, git, resolveBase, TEST_FILE, toPosix } from "../test-audit/audit";
import { emit, fail, ok, type Envelope, type Io } from "../output";
import { auditTests, type TestAuditReport } from "./test-audit";

const USAGE =
  "workit deslop scan [--diff [<base>]] [--lane none|self|focused|full] [--json] | workit deslop result --removed <n> [--reshapes <n>] [--open <n>] [--lane <lane>] [--base <b>]";
const MAX_BYTES = 2 * 1024 * 1024;

type Flags = {
  base: string | null;
  lane: ReviewLane | null;
  counts: Record<"removed" | "reshapes" | "open", number | null>;
};

function parse(argv: string[], sub: "scan" | "result"): Flags | string {
  const flags: Flags = {
    base: null,
    lane: null,
    counts: { removed: null, reshapes: null, open: null },
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    if (flag === "--json") continue;
    if (sub === "scan" && flag === "--diff") {
      const next =
        inline ?? (argv[index + 1] && !argv[index + 1].startsWith("-") ? argv[++index] : undefined);
      if (next) flags.base = next;
      continue;
    }
    const value = (): string | null => {
      const given = inline ?? argv[++index];
      return given === undefined || given === "" ? null : given;
    };
    if (flag === "--base") {
      const given = value();
      if (!given) return "--base requires a branch";
      flags.base = given;
    } else if (flag === "--lane") {
      const given = value();
      if (!given || !(REVIEW_LANES as readonly string[]).includes(given))
        return `--lane must be ${REVIEW_LANES.join(", ")}`;
      flags.lane = given as ReviewLane;
    } else if (
      sub === "result" &&
      (flag === "--removed" || flag === "--reshapes" || flag === "--open")
    ) {
      const given = value();
      const number = Number(given);
      if (given === null || !Number.isInteger(number) || number < 0)
        return `${flag} requires a whole number of 0 or more`;
      flags.counts[flag.slice(2) as keyof Flags["counts"]] = number;
    } else return `unknown option ${raw}`;
  }
  if (sub === "result" && flags.counts.removed === null)
    return "--removed <n> is required: the lines deslop deleted";
  return flags;
}

type ScanData = {
  base: string | null;
  fork: string;
  lane: LaneRaise & { source: "flag" | "diff"; diffReasons: string[] };
  passes: { id: string; text: string }[];
  findings: DeslopFinding[];
  counts: Record<DeslopClass, number>;
  files: number;
  testAudit: Pick<TestAuditReport, "files" | "tests" | "findings" | "summary" | "parseErrors">;
  durationMs: number;
};

type Scanned = { data: ScanData } | { failure: Envelope };

function scan(io: Io, flags: Flags): Scanned {
  const started = performance.now();
  const top = git(io.cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok)
    return {
      failure: fail(
        "unavailable",
        "deslop scan reads the branch diff: run it inside a git work tree",
        {
          unblock: "workit deslop scan --cwd <repository>",
        },
      ),
    };
  const assessed = flags.lane
    ? null
    : branchLane(io.cwd, {
        base: flags.base,
        head: null,
        workingTree: true,
        judgment: currentJudgment(io.cwd),
      });
  const base = flags.base ?? assessed?.base ?? defaultBase(io.cwd);
  const fork = resolveBase(io.cwd, base);
  if (!fork)
    return {
      failure: fail(
        "invalid_input",
        `cannot resolve a base to diff against${base ? `: ${base}` : ""}`,
        {
          unblock: "workit deslop scan --diff <base-branch-or-sha>",
        },
      ),
    };
  const changed = changedLines(io.cwd, fork);
  const display = (file: string) => toPosix(path.relative(io.cwd, file) || file);
  const findings: DeslopFinding[] = [];
  let files = 0;
  for (const [file, lines] of changed) {
    if (!commentStyle(toPosix(file))) continue;
    let source: string;
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    files += 1;
    findings.push(...scanSource(display(file), source, lines));
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const tests = [...changed.keys()]
    .filter((file) => TEST_FILE.test(toPosix(file)))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    })
    .toSorted();
  const audit = auditTests(tests, display);
  const testFindings = audit.findings.filter((finding) => finding.severity !== "info");
  const raised = raiseLane(flags.lane ?? assessed?.lane ?? "focused", findings);
  const counts = Object.fromEntries(DESLOP_CLASSES.map((name) => [name, 0])) as Record<
    DeslopClass,
    number
  >;
  for (const finding of findings) counts[finding.class] += 1;
  const data: ScanData = {
    base,
    fork,
    lane: {
      ...raised,
      source: flags.lane ? "flag" : "diff",
      diffReasons: assessed?.reasons ?? [],
    },
    passes: lanePasses(raised.lane).map((id) => ({ id, text: DESLOP_PASSES[id] })),
    findings,
    counts,
    files,
    testAudit: {
      files: audit.files,
      tests: audit.tests,
      findings: testFindings,
      summary: audit.summary,
      parseErrors: audit.parseErrors,
    },
    durationMs: Math.round(performance.now() - started),
  };
  return { data };
}

function human(data: ScanData): string[] {
  const lines = data.findings.map(
    (finding) =>
      `${finding.file}:${finding.line}  ${finding.class}${finding.class === "allowed" || finding.class === "suppression" ? ` (${finding.reason})` : ""}  ${finding.text}`,
  );
  for (const finding of data.testAudit.findings)
    lines.push(
      `${finding.file}:${finding.line}  test:${finding.rule} [${finding.severity}]  ${finding.why}`,
    );
  const counts = DESLOP_CLASSES.map((name) => `${data.counts[name]} ${name}`).join(", ");
  const lane = data.lane;
  lines.push(
    `deslop scan: ${counts} in ${data.files} file(s); test-audit ${data.testAudit.findings.length} finding(s) in ${data.testAudit.files} test file(s); ${data.durationMs} ms`,
    `lane ${lane.from}${lane.lane === lane.from ? "" : ` -> ${lane.lane} (${lane.reasons.join("; ")})`}${lane.source === "flag" ? " (from --lane)" : ""}`,
    ...data.passes.map((pass) => `  ${pass.text}`),
  );
  return lines;
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "scan" && sub !== "result")
    return emit(
      io,
      fail(
        "invalid_input",
        `${sub ? `unknown deslop action "${sub}"` : "missing scan|result"}\nusage: ${USAGE}`,
      ),
    );
  const flags = parse(rest, sub);
  if (typeof flags === "string")
    return emit(io, fail("invalid_input", `${flags}\nusage: ${USAGE}`));
  if (sub === "scan") {
    const scanned = scan(io, flags);
    return "failure" in scanned ? emit(io, scanned.failure) : emit(io, ok(scanned.data), human);
  }
  let lane = flags.lane;
  if (!lane) {
    const scanned = scan(io, flags);
    if ("failure" in scanned) return emit(io, scanned.failure);
    lane = scanned.data.lane.lane;
  }
  const line = deslopResultLine({
    lane,
    removed: flags.counts.removed ?? 0,
    reshapes: flags.counts.reshapes ?? 0,
    open: flags.counts.open ?? 0,
  });
  const key = codeKey(io.cwd);
  const row = appendObserved(io.cwd, {
    type: "deslop.result",
    actor: actorFromEnv(io.env),
    ...key,
    what: line,
    lane,
    removed: flags.counts.removed ?? 0,
    reshapes: flags.counts.reshapes ?? 0,
    open: flags.counts.open ?? 0,
  });
  if (!row.ok)
    return emit(
      io,
      fail("unavailable", `deslop result not recorded: ${row.error}`, {
        data: { line },
        unblock: row.unblock ?? "retry workit deslop result",
      }),
    );
  return emit(
    io,
    ok({ line, id: String(row.value.id), branch: key.branch, head: key.head }),
    (data) => [
      `${data.line} (recorded ${data.id} on ${data.branch ?? "(detached)"} at ${(data.head ?? "?").slice(0, 12)})`,
    ],
  );
}
