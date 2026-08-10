// CLI port of scripts/youtrack/api.sh — write guard before any config read.
import { youTrackApi } from "../youtrack";

const args = process.argv.slice(2);
const cmd = args[0];
if (cmd === "log-time" || cmd === "post-comment") {
  if ((process.env.WORKFLOW_YT_WRITE ?? "") !== "1") {
    console.error(
      "ERROR: YouTrack write operations require WORKFLOW_YT_WRITE=1 (refusing to mutate production)",
    );
    process.exit(1);
  }
}
const out = youTrackApi(args, process.env.WORKFLOW_YT_WRITE ?? "");
if ("error" in out) {
  console.log(JSON.stringify({ ok: false, error: out.error }));
  process.exit(1);
}
console.log(JSON.stringify(out.data));
