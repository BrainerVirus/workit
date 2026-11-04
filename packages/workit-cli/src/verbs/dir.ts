// `workit dir <kind>`: print where Workit keeps one kind of file, so agents
// never invent a location (docs/agents/file-locations.md).
//
//   workit dir plans|retros|handoffs   per clone: <git-common-dir>/workit/<kind>,
//                                      the same for every worktree; created here
//   workit dir config|state|data|cache|runtime   per user (core/workit-paths.mjs)
//
// Read-only but for creating a missing per-clone directory.
import { WORKIT_DIR_KINDS, workitDir } from "@brainervirus/workit-core/src/core/workit-paths.mjs";
import {
  REPO_DIR_KINDS,
  isRepoDirKind,
  repoDir,
} from "@brainervirus/workit-core/src/core/repo-paths";
import { emit, fail, ok, type Io } from "../output";

const KINDS = [...REPO_DIR_KINDS, ...WORKIT_DIR_KINDS];
const USAGE = `workit dir <${KINDS.join("|")}> [--json]`;

type Kind = "config" | "state" | "data" | "cache" | "runtime";

export async function run(argv: string[], io: Io): Promise<number> {
  const args = argv.filter((arg) => arg !== "--json");
  const flag = args.find((arg) => arg.startsWith("-"));
  if (flag) return emit(io, fail("invalid_input", `unknown flag ${flag}: ${USAGE}`));
  const [kind, extra] = args;
  if (!kind || extra !== undefined || !KINDS.includes(kind))
    return emit(
      io,
      fail("invalid_input", kind && extra === undefined ? `unknown kind ${kind}: ${USAGE}` : USAGE),
    );
  if (isRepoDirKind(kind)) {
    const dir = repoDir(kind, io.cwd);
    if (dir instanceof Error) return emit(io, fail("unavailable", dir.message));
    return emit(io, ok({ kind, scope: "clone", path: dir }), (data) => data.path);
  }
  const dir = workitDir(kind as Kind, io.env);
  return emit(io, ok({ kind, scope: "user", path: dir }), (data) => data.path);
}
