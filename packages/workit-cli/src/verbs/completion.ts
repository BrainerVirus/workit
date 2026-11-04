// `workit completion <shell>`: print the completion script for zsh, bash, fish
// or PowerShell (completion/scripts.ts). `workit setup` and `workit upgrade`
// install it for the user's shell; this prints it for any other setup.
import pkg from "../../package.json" with { type: "json" };
import { SHELLS, completionScript, type Shell } from "../completion/scripts";
import { emit, fail, ok, type Io } from "../output";

const USAGE = `workit completion <${SHELLS.join("|")}>`;

export async function run(argv: string[], io: Io): Promise<number> {
  const args = argv.filter((arg) => arg !== "--json");
  const [shell, extra] = args;
  if (!shell || extra !== undefined || !(SHELLS as readonly string[]).includes(shell))
    return emit(
      io,
      fail(
        "invalid_input",
        shell && extra === undefined ? `unknown shell ${shell}` : "missing shell",
        {
          unblock: USAGE,
        },
      ),
    );
  const script = completionScript(shell as Shell, pkg.version);
  if (io.json) return emit(io, ok({ shell, script }));
  io.stdout(script);
  return 0;
}
