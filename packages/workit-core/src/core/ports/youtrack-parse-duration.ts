// CLI port of scripts/youtrack/parse-duration.sh.
import { youTrackParseDuration } from "../youtrack";

const text = process.argv.slice(2).join(" ");
if (!text) {
  console.error("ERROR: duration text required");
  process.exit(1);
}
const out = youTrackParseDuration(text);
if ("error" in out) {
  console.error("ERROR: " + out.error);
  process.exit(1);
}
console.log(JSON.stringify(out.data));
