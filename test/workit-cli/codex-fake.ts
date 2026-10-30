/**
 * A fake Codex's read-only plugin answers: `plugin marketplace list --json`
 * names the configured marketplaces and `plugin list --json --marketplace X`
 * lists the installed rows of X. An unscoped `plugin list --json` is the
 * remote-catalog fetch Workit must never run, so it throws.
 */
export type CodexRow = {
  name: string;
  marketplaceName: string;
  [key: string]: unknown;
};

export const codexInventoryAnswer = (
  args: string[],
  installed: CodexRow[],
  marketplaces: string[] = ["workflow-toolkit"],
): { status: number; stdout: string } | undefined => {
  const line = args.join(" ");
  if (line === "plugin marketplace list --json")
    return {
      status: 0,
      stdout: JSON.stringify({
        marketplaces: marketplaces.map((name) => ({ name, root: `/m/${name}` })),
      }),
    };
  if (line === "plugin list --json") throw new Error("unscoped codex plugin list ran");
  const scoped = /^plugin list --json --marketplace (\S+)$/.exec(line);
  if (scoped)
    return {
      status: 0,
      stdout: JSON.stringify({
        installed: installed.filter((row) => row.marketplaceName === scoped[1]),
      }),
    };
  return undefined;
};
