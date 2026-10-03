#!/usr/bin/env bash
# Eval scaffold: a git repository on a protected `main` with one commit, so
# the plugin's SessionStart context and PreToolUse branch policy apply.
# Runs in the eval's working directory (claude plugin eval --scaffold).
set -euo pipefail
git init -q -b main .
git config user.email "eval@workit.invalid"
git config user.name "workit eval"
printf 'export const add = (a: number, b: number) => a + b;\n' > add.ts
git add add.ts
git commit -q -m "feat: add"
printf 'export const add = (a: number, b: number) => a - b;\n' > add.ts
git commit -q -am "fix: adjust add"
