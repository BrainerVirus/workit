// CLI port of scripts/youtrack/config.sh — JSON out, argv/env in.
import {
  youTrackConfigLoad,
} from "../youtrack";

const args = process.argv.slice(2);
const cmd = args[0] ?? "load";

if (cmd !== "load") {
  console.error("ERROR: unknown command");
  process.exit(1);
}

const out = youTrackConfigLoad();
if ("error" in out) {
  if (out.error === "ERROR: missing youtrack.json") {
    console.error(out.error);
  } else {
    console.log(JSON.stringify({ ok: false, error: out.error }));
  }
  process.exit(1);
}
console.log(JSON.stringify(out.data));
