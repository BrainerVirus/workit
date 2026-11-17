// `workit dir <kind>`: print where Workit keeps one kind of file, so agents
// never invent a location (docs/agents/file-locations.md).
//
//   workit dir plans|retros|handoffs|notes   per clone: <git-common-dir>/workit/<kind>,
//                                      the same for every worktree; created here.
//                                      notes: an agent's or user's notes, never in
//                                      the working tree (no repo ignores a Workit file)
//   workit dir config|state|data|cache|runtime   per user (core/workit-paths.mjs)
//
//   workit dir                         lists the kinds, each with what it holds
//
// Read-only but for creating a missing per-clone directory.
import { WORKIT_DIR_KINDS, workitDir } from "@workit-dev/core/src/core/workit-paths.mjs";
import { REPO_DIR_KINDS, isRepoDirKind, repoDir } from "@workit-dev/core/src/core/repo-paths";
import { emit, fail, ok, type Io } from "../output";

const KINDS = [...REPO_DIR_KINDS, ...WORKIT_DIR_KINDS];
const USAGE = `workit dir [${KINDS.join("|")}] [--json]`;

type Kind = "config" | "state" | "data" | "cache" | "runtime";

/** What each kind holds (docs/agents/file-locations.md), for a bare `workit dir`. */
const MEANINGS: Record<string, string> = {
  plans: "plan files (fanout plans, shaped work), per clone",
  retros: "retrospectives, per clone",
  handoffs: "resume briefs for the next session, per clone",
  notes: "an agent's or user's notes, per clone, outside the working tree",
  config: "workspaces.json, grants and settings, per user",
  state: "logs, leases, managed worktrees and scratch dirs, per user",
  data: "the owned CLI install, per user",
  cache: "regenerable files, per user",
  runtime: "sockets and locks that die with the session, per user",
};

function listKinds(io: Io): number {
  const kinds = KINDS.map((kind) => ({
    kind,
    scope: isRepoDirKind(kind) ? "clone" : "user",
    meaning: MEANINGS[kind] ?? "",
  }));
  return emit(io, ok({ kinds }), (data) => [
    ...data.kinds.map((row) => `${row.kind.padEnd(9)} ${row.meaning}`),
    "workit dir <kind> prints its path",
  ]);
}

export async function run(argv: string[], io: Io): Promise<number> {
  const args = argv.filter((arg) => arg !== "--json");
  const flag = args.find((arg) => arg.startsWith("-"));
  if (flag) return emit(io, fail("invalid_input", `unknown flag ${flag}: ${USAGE}`));
  const [kind, extra] = args;
  if (kind === undefined) return listKinds(io);
  if (!kind || extra !== undefined || !KINDS.includes(kind))
    return emit(
      io,
      fail("invalid_input", extra === undefined ? `unknown kind ${kind}: ${USAGE}` : USAGE),
    );
  if (isRepoDirKind(kind)) {
    const dir = repoDir(kind, io.cwd);
    if (dir instanceof Error) return emit(io, fail("unavailable", dir.message));
    return emit(io, ok({ kind, scope: "clone", path: dir }), (data) => data.path);
  }
  const dir = workitDir(kind as Kind, io.env);
  return emit(io, ok({ kind, scope: "user", path: dir }), (data) => data.path);
}
