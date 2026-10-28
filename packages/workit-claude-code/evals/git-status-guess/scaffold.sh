#!/usr/bin/env bash
# Eval scaffold for the retro-replay cases: the greet CLI on a feature branch
# (not protected), a noisy configured `test` check, and an uncommitted change.
# No remote and no forge: every case runs offline.
set -euo pipefail
git init -q -b main .
git config user.email "eval@workit.invalid"
git config user.name "workit eval"
mkdir -p bin test .workit
cat > package.json <<'JSON'
{
  "name": "greet",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
JSON
cat > bin/greet.js <<'JS'
const [name = "world"] = process.argv.slice(2);
console.log(`hello, ${name}`);
JS
cat > test/greet.test.js <<'JS'
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
test("Given a name, When greet runs, Then it greets that name", () => {
  assert.match(execFileSync("node", ["bin/greet.js", "ada"], { encoding: "utf8" }), /^hello, ada/);
});
JS
# A deliberately noisy check: 3000 lines of output, then the real test run.
cat > .workit/checks.json <<'JSON'
{ "checks": { "test": "seq 1 3000 && node --test" } }
JSON
printf '.workit/\n' > .gitignore
git add -A
git commit -q -m "feat: greet cli"
git switch -q -c feature/greet-shout
printf 'const [name = "world"] = process.argv.slice(2);\nconsole.log(`hello, ${name}!`);\n' > bin/greet.js
