import { cpSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const vendorFilter = (source: string): boolean => {
  if (source.endsWith(".sh")) return false;
  const stat = statSync(source);
  return (
    stat.isDirectory() ||
    ((stat.mode & 0o111) === 0 && readFileSync(source).subarray(0, 2).toString("latin1") !== "#!")
  );
};

export const copySanitizedVendor = (source: string, dest: string): void => {
  cpSync(source, dest, { recursive: true, filter: vendorFilter });

  const companion = path.join(dest, "brainstorming/visual-companion.md");
  if (!existsSync(companion)) return;
  let md = readFileSync(companion, "utf8");
  const fromStart = md.indexOf("## Starting a Session");
  const toLoop = md.indexOf("## The Loop", fromStart);
  const fromCleanup = md.indexOf("## Cleaning Up");
  const toReference = md.indexOf("## Reference", fromCleanup);
  if (fromStart !== -1 && toLoop !== -1 && fromCleanup !== -1 && toReference !== -1) {
    md =
      md.slice(0, fromStart) +
      "The packaged browser-companion runtime is not shipped with this package; its\n" +
      "launcher scripts are excluded as vendored shell. Consult the upstream skill\n" +
      "source for launch instructions.\n\n" +
      md.slice(toLoop, fromCleanup) +
      md.slice(toReference);
  }
  md = md.replace(
    /If it has shut down, restart it with `start-server\.sh` using the \*\*same `--project-dir`\*\*[\s\S]*?you don't need to send a new URL\. /,
    "",
  );
  writeFileSync(companion, md);
};
