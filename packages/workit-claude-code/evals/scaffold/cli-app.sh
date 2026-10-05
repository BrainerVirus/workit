#!/usr/bin/env bash
# Eval scaffold: a tiny Node CLI app on a protected `main`, with a test script
# and a bin entry, so verify-app has a real surface to inspect and drive.
set -euo pipefail
git init -q -b main .
git config user.email "eval@workit.invalid"
git config user.name "workit eval"
mkdir -p bin test
cat > package.json <<'JSON'
{
  "name": "greet",
  "version": "1.0.0",
  "type": "module",
  "bin": { "greet": "./bin/greet.js" },
  "scripts": { "test": "node --test test/" }
}
JSON
cat > bin/greet.js <<'JS'
#!/usr/bin/env node
const [name = "world"] = process.argv.slice(2);
if (name === "--help") {
  console.log("usage: greet [name]");
} else {
  console.log(`hello, ${name}`);
}
JS
chmod +x bin/greet.js
cat > test/greet.test.js <<'JS'
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
test("Given a name, When greet runs, Then it greets that name", () => {
  assert.equal(execFileSync("node", ["bin/greet.js", "ada"], { encoding: "utf8" }), "hello, ada\n");
});
JS
printf '# greet\n\nRun `node bin/greet.js <name>`.\n' > README.md
git add -A
git commit -q -m "feat: greet cli"
