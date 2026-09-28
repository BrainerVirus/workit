// CLI port of scripts/pr-create.sh — create | --build-body.
//
// Decision ae03c569 re-enabled hosted PR/MR creation with pre/post provider SHA
// verification and accepted the residual non-atomic source-SHA race. The legacy
// create mode still cannot mint the native action receipt, the one-time action
// reservation, or the target writer lease the shared contract requires, so it
// never performs a hosted create itself. It returns the same needs_input shape
// as the headless `workit action` route and points at the reserved,
// TTY-confirmed shared path.
import { prBuildBody } from "../pr-create";

const mode = process.argv[2] ?? "create";
if (mode === "--build-body") {
  console.log(JSON.stringify({ body: prBuildBody(process.env, process.cwd()) }));
  process.exit(0);
}
console.log(
  JSON.stringify({
    ok: false,
    schemaVersion: 1,
    code: "needs_input",
    error: "hosted PR/MR creation requires the reserved shared action path with TTY confirmation",
    details: {
      operation: "hosting.pull_request",
      guidance:
        "Run `workit action hosting.pull_request --payload <file> --confirm` from the target checkout: it records the one-time action reservation behind the terminal confirmation and verifies the provider PR head against the approved source SHA before reporting success.",
    },
  }),
);
process.exit(1);
