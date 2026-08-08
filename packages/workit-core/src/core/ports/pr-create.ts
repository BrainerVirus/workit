// CLI port of scripts/pr-create.sh — create | --build-body.
import { prBuildBody, prCreate } from "../pr-create";

const mode = process.argv[2] ?? "create";
if (mode === "--build-body") {
  console.log(JSON.stringify({ body: prBuildBody(process.env, process.cwd()) }));
  process.exit(0);
}
if (process.env.WF_PR_CONFIRMED !== "true") {
  console.error("ERROR: confirmed=true required");
  process.exit(1);
}
if (!process.env.WF_PR_TITLE) {
  console.error("ERROR: title required");
  process.exit(1);
}
const out = prCreate(process.env, process.cwd());
if (out.error || out.ok === false) {
  console.log(JSON.stringify(out));
  process.exit(1);
}
console.log(JSON.stringify(out));
