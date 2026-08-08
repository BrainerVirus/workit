---
name: wk-commit
description: Structured local commits via workflow_git_context. Use for /wk-commit or "use commit skill" only — not casual "ship it".
disable-model-invocation: true
---

# Commit — Structured local commits (no push)

## Step 1 — Gather facts (required)

Call MCP tool `workflow_git_context` with arguments from the user's message (paths after `/wk-commit`, etc.).

**Workspace root:** defaults to the Cursor workspace. Pass `workspace_root` when the user names a different repository path.

Use the tool return value as ground truth. Do not read git, run npm, or infer repo state yourself.
If the tool errors, report the error and stop.

For workflow steps below that show `git` commands, prefer the MCP tool fields (`branch`, `status_short`, `staged`, `unstaged`, `untracked`, `diff_stat`, `partial_staged`) as ground truth. Run git commands only when executing commits or staging.

---

# Commit workflow

Analyze git changes and create **LOCAL commits only** (**DO NOT push**).

Use **Conventional Commits**.

Split changes into logical commits by **intent** first, then by **type**, and, if changes are large, also by **scope/module**.

Always include the required co-author trailer.

---

## Modes

### 1) Commit all uncommitted changes

```bash
    /wk-commit
```

Use **all uncommitted changes in the repository**, including:

- staged changes
- unstaged tracked changes
- untracked files

### 2) Commit only changes under specific paths

```bash
/wk-commit <paths...>
```

Use **only changes inside the provided path(s)**, including:

- staged changes inside those paths
- unstaged tracked changes inside those paths
- untracked files inside those paths

Files outside the provided paths must not be included unless explicitly allowed by flags.

---

## Invocation

```bash
/wk-commit [paths...]
[--group-by intent|intent,type|intent,type,scope|intent,type,scope,module]
[--include-other-staged] [--allow-partial] [--hunk-split]
[--force-prod]
```

---

## Default behavior

- `/wk-commit` → commit **all uncommitted changes**
- `/wk-commit <paths...>` → commit **only changes inside those paths**

If staged files already exist outside the selected paths, abort unless `--include-other-staged` is provided.

---

## Flags

- `--group-by`: Default is `intent,type,scope`.
- `--include-other-staged`: Include already staged files outside selected paths.
- `--allow-partial`: Allow partially staged files.
- `--hunk-split`: Use patch-based staging to split mixed files when safe.
- `--force-prod`: Allow commits on protected branch `prod`.

---

## Hard rules

**Never:**

- Run `git push`
- Run `git push --force`
- Commit to `prod` without `--force-prod`
- Commit files containing secrets
- Disable hooks or pre-commit automatically
- Use `--no-verify`
- Remove tests to bypass CI
- Use broad staging commands such as `git add .`, `git add -A`, or `git commit -a` unless explicitly required by the selected mode and safe selection logic

---

# Workflow

## 1. Branch check

```bash
git rev-parse --abbrev-ref HEAD
```

If branch is `prod` and `--force-prod` is not provided → **ABORT**.

---

## 2. Determine working set

### Mode A — all changes

Use:

```bash
git status --short
```

If no changes exist:

> ⚠️ No changes to commit

### Mode B — selected paths only

Use:

```bash
git status --short -- <paths...>
```

If no changes exist under those paths:

> ⚠️ No changes to commit in specified paths

If staged files already exist outside the specified paths, abort unless `--include-other-staged` is provided.

Check with:

```bash
git diff --cached --name-only
```

If outside-path staged files exist:

> 🛑 Staged files outside selected paths detected
> Re-run with --include-other-staged

---

## 3. Partial staging check

Detect partially staged files:

```bash
staged=$(git diff --cached --name-only)
unstaged=$(git diff --name-only)
partial=intersection(staged, unstaged)
```

If partial files exist and `--allow-partial` is not set → **ABORT**.

Abort message:

> 🛑 Partial-staged files detected
> Use --allow-partial

The assistant must not run plain `git add <file>` in a way that collapses partial staging unless:

- `--allow-partial` is enabled, or
- `--hunk-split` is enabled and patch-based selection is used safely

---

## 4. Build the index for the selected working set

### Mode A — all changes

Stage all changes in the repository working set, including:

- modified tracked files
- deleted tracked files
- untracked files

### Mode B — selected paths only

Stage only changes inside the selected paths, including:

- modified tracked files under those paths
- deleted tracked files under those paths
- untracked files under those paths

Do not stage files outside the selected paths unless `--include-other-staged` is set.

### Staging rules

- Do not use `git add .`
- Do not use `git add -A` at repository root in path mode
- Do not use `git commit -a`
- Preserve path boundaries strictly
- Preserve partial staging semantics unless explicitly allowed

After staging, verify that the index is not empty:

```bash
git diff --cached --name-only
```

If empty:

> ⚠️ No staged changes to commit

---

## 5. Secrets scan

Scan the staged diff:

```bash
git diff --cached
```

### Forbidden filenames

Abort if selected staged files match:

- `.env*`
- `*secret*`
- `*.pem`
- `*.key`
- `id_rsa`
- `id_ed25519`
- `*.p12`
- `*.kdbx`

### Secret patterns

Abort on high-confidence matches such as:

- `AWS_(ACCESS_KEY|SECRET|SESSION).*KEY`
- `BEGIN (RSA|EC|OPENSSH) PRIVATE KEY`
- `-----BEGIN`
- `(api[-_ ]?key|token|password)\s*[:=]`

If detected:

> 🛑 Potential secrets detected
> Affected files: <file>

---

# Change detection

For each staged file detect:

```text
{intent, type, scope, mixed}
```

Print a table before planning commits.

---

## Intent detection

Intent is the **primary grouping dimension**.

Prefer grouping by **atomic change purpose**, not by file extension alone.

Examples of intents:

- add a feature
- fix a bug
- refactor internals
- update tests for a specific behavior
- update documentation for a specific feature
- change CI/build configuration
- bump dependencies

### Intent rules

- Keep closely related code, tests, and docs together when they describe the same change.
- Split unrelated changes even if they share the same type.
- Never merge unrelated feature scopes just to reduce commit count.
- If an intent cannot be isolated safely, create a separate fallback commit only if it is still coherent; otherwise abort.

---

## Type detection

Type is used after intent grouping.

| Priority | Type       | Patterns / Signals                                 |
| -------- | ---------- | -------------------------------------------------- |
| 1        | `test`     | only tests changed                                 |
| 2        | `docs`     | only docs changed                                  |
| 3        | `ci`       | `.github/workflows`, CI configs                    |
| 4        | `build`    | `Dockerfile`, build scripts, packaging             |
| 5        | `chore`    | maintenance, housekeeping, repo config             |
| 6        | `perf`     | performance-focused changes                        |
| 7        | `fix`      | bug fix or correction                              |
| 8        | `feat`     | new user-visible functionality                     |
| 9        | `refactor` | structural internal change without behavior change |
| 10       | `style`    | formatting only                                    |

### Type rules

- If a commit includes production code plus related tests/docs, choose the type from the primary code change.
- Do not force docs/tests into separate commits when they are part of the same atomic change.
- Use path patterns only as hints, not as the sole classifier.

---

## Scope detection

Choose the dominant scope in the group.

| Scope     | Paths                          |
| --------- | ------------------------------ |
| `api`     | `src/api`                      |
| `dash`    | `src/dashboard`                |
| `db`      | `migrations`, `controllers`    |
| `service` | `modules/services`             |
| `deps`    | `requirements`, `package.json` |
| `config`  | `configs`, `Makefile`          |
| `static`  | `static`                       |
| `test`    | `tests`                        |
| `ci`      | `.github/workflows`            |
| `build`   | `Dockerfile`                   |

If no clear scope exists, scope may be omitted.

---

## Mixed file policy

A file is `mixed` if it contains multiple semantic change types or multiple intents.

### If `--hunk-split` is disabled

- Prefer assigning the file to the dominant intent if the change is still coherent.
- If the file mixes unrelated changes and cannot be assigned safely, mark it as `[MIXED]`.
- If ambiguity is high, abort instead of guessing.

Priority when forced to assign a dominant type:

```text
fix > feat > refactor > perf > chore > docs > style
```

### If `--hunk-split` is enabled

- Use patch-based staging to isolate safe hunks.
- Only split hunks when the resulting commits remain coherent.
- If safe isolation is not possible, use a fallback commit:

```text
chore(mixed): isolate ambiguous changes
```

only if that commit is still understandable and intentional.

Otherwise abort.

---

## Breaking changes

If a public API, external contract, migration behavior, or user-facing interface changes incompatibly:

- Header: `type(scope)!: subject`
- Footer must include:

```text
BREAKING CHANGE: <description>
```

---

# Commit planning

## Defaults

- Max commits = `10`
- Group-by = `intent,type,scope`

## Large group threshold

A group is considered large if:

- files ≥ 10, or
- LOC ≥ 400

Large groups may be split further by module if doing so preserves semantic clarity.

---

## Grouping rules

1. Group by **intent**
2. Then split by **type** if needed
3. Then split by **scope** if needed
4. Large groups may split by **module**
5. Enforce `--max-commits` only if semantic integrity is preserved

### Merge rules when commit count must be reduced

Allowed merges:

- `style + docs` → `chore`
- `ci + build` → `chore`
- `perf + refactor` → `refactor`

Forbidden merges:

- unrelated `feat` scopes
- unrelated `fix` groups
- unrelated application code and dependency bumps unless tightly coupled

### If `max-commits` would force bad merges

Do not produce misleading commits.

Instead:

- show the best semantic plan
- explain that it exceeds `--max-commits`
- or abort with recommendation to increase the limit

---

## Commit order

Preferred order:

1. `test`
2. `fix`
3. `feat`
4. `refactor`
5. `perf`
6. `ci`
7. `build`
8. `chore`
9. `docs`
10. `style`

When intent grouping implies a different order for coherence, semantic order wins.

---

## Plan output

Show:

```text
FILE → {INTENT, TYPE, SCOPE, MIXED}
```

Then print the commit plan:

```text
Commit 1/N: type(scope): subject
* file1
* file2

Commit 2/N: ...
```

---

# Commit execution

Before each commit:

- ensure the index contains only the files/hunks for that commit
- verify staged file list matches the current planned group
- preserve path restrictions in path mode

After each commit:

- recompute remaining staged/uncommitted changes
- continue until the plan is complete or an abort condition occurs

---

## Author

Use the default git author configured in the repository.

**Do NOT override the commit author via `--author`.**

The assistant must only add the co-author trailer below.

```
Co-authored-by: Cursor <cursoragent@cursor.com>
```

Rules:

- The trailer must be the last line of the commit message
- Ensure there is one blank line before the trailer
- Do not replace or override the existing git author
- Do not add additional co-authors unless explicitly requested

---

## Commit subject rules

Subject must be:

- imperative mood
- lowercase
- concise
- no trailing period
- ideally ≤ 72 characters

Examples:

- `feat(api): add payout endpoint`
- `fix(db): handle null status migration`
- `refactor(service): simplify billing adapter`

---

## Commit template

```text
<type>(<scope>): <subject>

Why:
* reason

What:
* change

Changes:
* file1: description
* file2: description

Stats:
* N files changed
* +additions/-deletions lines
```

If scope is unknown, `<type>: <subject>` is allowed.

If the change is trivial, the body may be shortened, but the co-author trailer remains mandatory.

---

## Git command

Use the repository's default git author.

```bash
git commit \
  -m "<type>(<scope>): <subject>" \
  -m "<body>"
```

Do not pass `--author`.

---

## Hook failures

If commit hooks or pre-commit checks fail:

- stop immediately
- report the failure output
- do not retry with `--no-verify`
- do not modify tests or files only to bypass checks unless explicitly instructed

---

# Completion output

Example:

```text
✅ Created 3 commits

[1] test(api): add endpoint tests
Hash: abc123

[2] feat(api): add payout endpoint
Hash: def456

[3] docs(api): document payout flow
Hash: 789xyz

📌 Commits created locally. NOT pushed.
```

---

# Abort messages

## Protected branch

```text
🛑 Protected branch: prod
Re-run with --force-prod
```

## Partial staged

```text
🛑 Partial-staged files detected
Use --allow-partial
```

## Secrets

```text
🛑 Potential secrets detected
Affected files: <file>
```

## No changes

### No paths mode

```text
⚠️ No changes to commit
```

### Path mode

```text
⚠️ No changes to commit in specified paths
```

## Outside staged files in path mode

```text
🛑 Staged files outside selected paths detected
Re-run with --include-other-staged
```

## Ambiguous mixed changes

```text
🛑 Ambiguous mixed changes cannot be safely isolated
Use --hunk-split or reduce the selected scope
```
