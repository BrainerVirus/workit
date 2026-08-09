// CLI port of scripts/youtrack/greeting.sh.
import { youTrackGreeting } from "../youtrack";

const override = process.argv[2];
const result = youTrackGreeting(override);
if (result.exitCode !== 0) {
  console.error(result.stderr || "greeting failed");
  process.exit(1);
}
process.stdout.write(result.stdout);
