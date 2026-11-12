// The shapes a raw ytrack write can take, generated from what the gate reads
// (raw-git.ts WRAPPERS and KEYWORDS) plus the fixed forms it follows. Shared by
// the core suite and both launcher suites (#780, decision for PR #827): the
// launchers' pre-filter must route every shape the gate decides.
import { KEYWORDS, WRAPPERS } from "@/packages/workit-core/src/hooks/raw-git";

const W = "ytrack issue comment X-1 --body hi";
const args = "issue comment X-1 --body hi";

/** Shapes a POSIX shell runs. */
export const POSIX_SHAPES: string[] = [
  ...Object.entries(WRAPPERS).flatMap(([key, { values, operands }]) => {
    const fill = "1 ".repeat(operands ?? 0);
    const first = values.split(" ").find(Boolean);
    return [
      `${key} ${fill}${W}`,
      ...(first ? [`${key} ${first}${first.startsWith("--") ? "=" : " "}x ${fill}${W}`] : []),
    ];
  }),
  ...[...KEYWORDS].map((keyword) => `${keyword} ${W}`),
  `FOO="a b" ${W}`,
  `find . -exec ${W} \\;`,
  `find . -name x -exec ${W} {} +`,
  `parallel ${W}`,
  `xargs ${W}`,
  `script -qc "${W}" /dev/null`,
  `flock /tmp/l -c '${W}'`,
  `env -S'${W}'`,
  `trap '${W}' EXIT`,
  `bash -c '${W}'`,
  `eval "${W}"`,
  `bash <<'EOF'\n${W}\nEOF`,
  `echo '${W}' | bash`,
  `source <(echo '${W}')`,
  `echo $(${W})`,
  `echo \`${W}\``,
  `( ${W} )`,
  `{ ${W}; }`,
  `true;${W}`,
  `true\n${W}`,
  `Y=ytrack; $Y ${args}`,
  `for c in ytrack; do $c ${args}; done`,
  "{ytrack,issue,comment,X-1,--body,hi}",
  `ytrack.exe ${args}`,
  `ytrack.cmd ${args}`,
  `ytrack@1 ${args}`,
  `$'ytrack' ${args}`,
  `y"t"rack ${args}`,
  `yt\\rack ${args}`,
  `/opt/bin/ytrack ${args}`,
  `workit check --name y -- ${W}`,
  `npx -y ${W}`,
  `pnpm dlx ${W}`,
  `npx -c '${W}'`,
  `alias yt=ytrack; yt ${args}`,
  `yt() { ytrack "$@"; }; yt ${args}`,
  `$(which ytrack) ${args}`,
];

/** Shapes Claude Code's PowerShell tool runs. */
export const POWERSHELL_SHAPES: string[] = [
  `C:\\bin\\ytrack.exe ${args}`,
  `cmd /c ${W}`,
  `yt\`rack ${args}`,
];

/** Commands that only mention ytrack: the launchers keep them on the fast path. */
export const FAST = [
  "cat docs/ytrack-notes.md",
  "ls /tmp/ytrack/x",
  "wc -l packages/workit-core/src/hooks/ytrack-guard.ts",
  "cat ~/.claude/skills/ytrack/SKILL.md",
  "rg -n ytrackRunner packages",
  "YTRACK_HOST=acme ls",
  "cat ytrack.md",
  "workit youtrack note X-1 --markdown hi",
];

/** Mentions the shared test routes to the runtime, where the gate decides nothing. */
export const ROUTED_MENTIONS = ["echo see the ytrack skill", "grep -rn ytrack docs"];
