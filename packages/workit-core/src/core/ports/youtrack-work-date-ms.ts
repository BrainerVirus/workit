// CLI port of scripts/youtrack/work-date-ms.sh.
import { youTrackWorkDateMs } from "../youtrack";

const raw = process.argv[2] ?? "auto";
const out = youTrackWorkDateMs(raw);
if ("error" in out) {
  console.error("ERROR: " + out.error);
  process.exit(1);
}
console.log(JSON.stringify(out.data));
