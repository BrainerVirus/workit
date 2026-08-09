// CLI port of scripts/init/apply.sh.
import { initApplyData } from "../init";

const action = process.argv[2] ?? "";
const confirmed = process.argv[3] ?? "false";
if (confirmed !== "true") {
  console.error("ERROR: confirmed=true required to write config");
  process.exit(1);
}
const out = initApplyData(action);
if (out.error) {
  console.error("ERROR: " + out.error);
  process.exit(1);
}
console.log(JSON.stringify(out));
