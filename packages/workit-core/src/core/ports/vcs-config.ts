// CLI port of scripts/vcs/config.sh — mode: load | summary | resolve.
import { vcsConfig } from "../vcs-config";

const cmd = process.argv[2] ?? "load";
if (cmd !== "load" && cmd !== "summary" && cmd !== "resolve") {
  console.error("ERROR: unknown command (load|summary|resolve)");
  process.exit(1);
}
const out = vcsConfig(cmd, process.cwd());
if (!out.ok) {
  console.log(JSON.stringify(out));
  process.exit(1);
}
console.log(JSON.stringify(out));
