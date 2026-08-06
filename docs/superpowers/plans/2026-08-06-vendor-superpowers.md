# Vendor Superpowers + Feature-Scoped Docs Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-06-vendor-superpowers-design.md`
**Branch:** `feature/vendor-superpowers`

**Goal:** Vendor the 14 Superpowers skills into the toolkit (removing the external plugin from OpenCode/Cursor) and migrate workflow docs from `docs/superpowers/{specs,plans,sdd}/` to a feature-scoped `docs/<slug>/{spec.md,plan.md,sdd/}` layout with spec+plan committed and `sdd/` gitignored.

**Architecture:** Two independent moves in one branch. (A) `vendor/superpowers/skills/` holds a verbatim copy of the upstream skills + provenance files; `src/plugin.ts` registers the vendored path alongside `skills/`; `opencode.json` drops the external git plugin; an update script re-syncs from upstream on demand. (B) All path-bearing code (`docs-validate`, `flow-state`, `sdd`, `handoff-context`, `branch`, `plan-tasks`, tools) moves from `docs/superpowers/{specs,plans,sdd}/<dated-name>` to `docs/<slug>/{spec.md,plan.md,sdd/}`; slug = directory name; `docs/*/sdd/` is gitignored.

**Tech Stack:** TypeScript + zod (existing `src/core`), `bun test`, bash (update script), existing `@opencode-ai/plugin` + MCP server patterns. No new production dependencies.

## Global Constraints

- Docs layout: `docs/<slug>/spec.md`, `docs/<slug>/plan.md` (committed), `docs/<slug>/sdd/` (gitignored — progress, flow.json, briefs, diffs).
- Slug = directory name; `feature/<slug>` derived from it (no date parsing).
- Plan `**Spec:**` link = `docs/<slug>/spec.md`; spec `**Branch:**` = `feature/<slug>`.
- `flow.json` lives at `docs/<slug>/sdd/flow.json`.
- `.gitignore`: replace `docs/superpowers/` with `docs/*/sdd/`.
- Vendored skills copied verbatim from upstream; never edited in `vendor/`.
- `vendor/superpowers/VERSION` + `NOTICE.md` record provenance.
- `src/plugin.ts` registers both `skills/` and `vendor/superpowers/skills` (no duplicates).
- `opencode.json` no longer references the external superpowers git plugin.
- Old `docs/superpowers/` paths must be absent from all `src/`, `templates/`, `cursor/`, `scripts/` sources (grep check in final task).
- `bun run check` green after every task.
- Version stays `0.4.0` (this is a feature change, not a release).

---

### Task 1: Vendor the Superpowers skills + provenance

**Files:**
- Create: `vendor/superpowers/skills/` (copy of the 14 upstream skill dirs)
- Create: `vendor/superpowers/VERSION`
- Create: `vendor/superpowers/NOTICE.md`
- Create: `scripts/update-superpowers.sh`
- Test: `test/vendor-superpowers.test.ts`

**Interfaces:**
- Consumes: upstream skills at `~/.cache/opencode/packages/superpowers@git+https:/github.com/obra/superpowers.git/node_modules/superpowers/skills/` (14 dirs: brainstorming, dispatching-parallel-agents, executing-plans, finishing-a-development-branch, receiving-code-review, requesting-code-review, subagent-driven-development, systematic-debugging, test-driven-development, using-git-worktrees, using-superpowers, verification-before-completion, writing-plans, writing-skills)
- Produces: `vendor/superpowers/skills/<name>/SKILL.md` for each; `VERSION` containing `6.1.1`; `NOTICE.md` with source/license/update info; `scripts/update-superpowers.sh [--pin X.Y.Z]` that clones upstream, copies skills, writes VERSION, prints `git status` (never pushes/commits)

- [ ] **Step 1: Write the failing test**

Create `test/vendor-superpowers.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const VENDOR = path.resolve(import.meta.dir, "../vendor/superpowers");

const REQUIRED_SKILLS = [
  "brainstorming", "dispatching-parallel-agents", "executing-plans",
  "finishing-a-development-branch", "receiving-code-review", "requesting-code-review",
  "subagent-driven-development", "systematic-debugging", "test-driven-development",
  "using-git-worktrees", "using-superpowers", "verification-before-completion",
  "writing-plans", "writing-skills",
];

test("vendored skills dir contains all 14 upstream skills", () => {
  const dirs = readdirSync(path.join(VENDOR, "skills")).filter((d) =>
    existsSync(path.join(VENDOR, "skills", d, "SKILL.md")));
  for (const skill of REQUIRED_SKILLS) {
    expect(dirs).toContain(skill);
  }
});

test("each vendored SKILL.md has valid frontmatter with name + description", () => {
  for (const dir of readdirSync(path.join(VENDOR, "skills"))) {
    const file = path.join(VENDOR, "skills", dir, "SKILL.md");
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    expect(fm, `${dir} missing frontmatter`).not.toBeNull();
    expect(fm![1]).toMatch(/^name:/m);
    expect(fm![1]).toMatch(/^description:/m);
  }
});

test("VERSION file exists and NOTICE.md documents provenance", () => {
  const version = readFileSync(path.join(VENDOR, "VERSION"), "utf8").trim();
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  const notice = readFileSync(path.join(VENDOR, "NOTICE.md"), "utf8");
  expect(notice).toContain("obra/superpowers");
  expect(notice).toContain("MIT");
  expect(notice).toContain("update-superpowers.sh");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/vendor-superpowers.test.ts`
Expected: FAIL — `vendor/superpowers` does not exist.

- [ ] **Step 3: Copy the skills from the installed upstream cache**

```bash
SP=~/.cache/opencode/packages/superpowers@git+https:/github.com/obra/superpowers.git/node_modules/superpowers
mkdir -p vendor/superpowers
cp -R "$SP/skills" vendor/superpowers/skills
printf '6.1.1\n' > vendor/superpowers/VERSION
```

Create `vendor/superpowers/NOTICE.md`:

```markdown
# Vendored: Superpowers skills

- **Source:** https://github.com/obra/superpowers (MIT)
- **Vendored version:** see `VERSION`
- **Vendored contents:** `skills/` — the 14 engineering-process skills only (docs, tests, and packaging scripts are intentionally excluded).
- **Update procedure:** run `./scripts/update-superpowers.sh [--pin X.Y.Z]` from the repo root, review the diff, and commit. Never edit files under `vendor/superpowers/skills/` by hand — re-run the script instead.
```

- [ ] **Step 4: Create `scripts/update-superpowers.sh`**

```bash
#!/usr/bin/env bash
# Re-sync vendored Superpowers skills from upstream. Never pushes or commits.
set -euo pipefail

REPO="https://github.com/obra/superpowers.git"
VENDOR="vendor/superpowers"
PIN=""
for arg in "$@"; do
  case "$arg" in
    --pin) PIN="" ;; # consumed with next arg
    --pin=*) PIN="${arg#--pin=}" ;;
    --https) REPO="https://github.com/obra/superpowers.git" ;;
    --ssh) REPO="git@github.com:obra/superpowers.git" ;;
    *) if [ -z "$PIN" ]; then PIN="$arg"; fi ;;
  esac
done

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "Cloning upstream..."
git clone --quiet --depth 1 "$REPO" "$STAGE/sp"
cd "$STAGE/sp"
if [ -n "$PIN" ]; then
  git fetch --quiet --depth 1 origin "refs/tags/$PIN" 2>/dev/null || {
    echo "ERROR: pin $PIN not found upstream" >&2
    exit 1
  }
  git checkout --quiet "$PIN"
fi
VERSION="$(grep -m1 '"version"' package.json | sed -E 's/.*"version": "([^"]+)".*/\1/')"

cd "$ROOT"
rm -rf "$VENDOR/skills"
mkdir -p "$VENDOR"
cp -R "$STAGE/sp/skills" "$VENDOR/skills"
printf '%s\n' "$VERSION" > "$VENDOR/VERSION"
echo "Vendored superpowers $VERSION -> $VENDOR"
echo "Review with: git status && git diff --stat"
```

```bash
chmod +x scripts/update-superpowers.sh
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/vendor-superpowers.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add vendor/superpowers scripts/update-superpowers.sh test/vendor-superpowers.test.ts
git commit -m "feat(vendor): vendor superpowers skills 6.1.1 with update script"
```

---

### Task 2: Register vendored skills in the plugin; drop the external plugin

**Files:**
- Modify: `src/plugin.ts` (config hook — append `vendor/superpowers/skills`)
- Modify: `~/.config/opencode/opencode.json` (remove the superpowers git plugin entry)
- Modify: `test/plugin.test.ts` (assert both skill paths registered)
- Modify: `test/smoke.ts` (tool count unchanged; skill paths assertion updated)

**Interfaces:**
- Consumes: `root` (repo root) already resolved in `src/plugin.ts`
- Produces: config hook adds `vendor/superpowers/skills` to `mutable.skills.paths` (after `skills/`, no duplicates)

- [ ] **Step 1: Write the failing test**

Append to `test/plugin.test.ts` (inside the existing describe block):

```typescript
test("config registers vendored superpowers skills alongside toolkit skills", async () => {
  const hooks = await plugin({
    directory: "/repo", worktree: "/repo",
    serverUrl: new URL("http://localhost"),
  } as never);
  const config: Record<string, any> = {};
  await hooks.config?.(config);
  const paths = config.skills.paths as string[];
  expect(paths.some((p) => p.endsWith("/skills"))).toBe(true);
  expect(paths.some((p) => p.endsWith("/vendor/superpowers/skills"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/plugin.test.ts -t "registers vendored"`
Expected: FAIL — vendored path not present.

- [ ] **Step 3: Extend the config hook in `src/plugin.ts`**

Find the config hook (around line 57) and modify the skill registration block:

```typescript
mutable.skills ??= {};
mutable.skills.paths ??= [];
const skillPath = path.join(root, "skills");
const vendoredSkillsPath = path.join(root, "vendor", "superpowers", "skills");
for (const p of [skillPath, vendoredSkillsPath]) {
  if (existsSync(p) && !mutable.skills.paths.includes(p)) {
    mutable.skills.paths.push(p);
  }
}
```

Add `existsSync` to the imports from `node:fs` in `src/plugin.ts` (it already imports `readFileSync`).

- [ ] **Step 4: Remove the external plugin from `~/.config/opencode/opencode.json`**

Edit `~/.config/opencode/opencode.json`: delete the line

```json
"superpowers@git+https://github.com/obra/superpowers.git",
```

from the `plugin` array. Keep `ponytail` and the workflow-toolkit entry.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/plugin.test.ts && bun test test/smoke.ts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/plugin.ts test/plugin.test.ts
git commit -m "feat(plugin): register vendored superpowers skills; drop external plugin"
```

---

### Task 3: Migrate core paths to `docs/<slug>/` — flow-state, sdd, branch, docs-validate

**Files:**
- Modify: `src/core/flow-state.ts` (flow.json path)
- Modify: `src/core/sdd.ts` (sdd_dir)
- Modify: `src/core/branch.ts` (slug derive + stash exclude + sdd default)
- Modify: `src/core/docs-validate.ts` (drop mirror support; spec/plan under docs/<slug>)
- Modify: `src/core/handoff-context.ts` (resolution becomes single-dir-per-feature)
- Modify: `src/tools/flow.ts`, `src/tools/handoff.ts`, `src/tools/sdd.ts`, `src/tools/repo.ts` (path constants)
- Modify: `test/flow-state.test.ts`, `test/flow-tools.test.ts`, `test/sdd.test.ts`, `test/branch-policy.test.ts`, `test/docs-validate.test.ts`, `test/handoff.test.ts`, `test/plugin.test.ts`, `test/mcp-regressions.test.ts` (fixtures)
- Test: `test/docs-layout.test.ts` (new — end-to-end new layout)

**Interfaces:**
- Consumes: existing exported signatures (unchanged): `readFlowState`, `transitionSpec`, `transitionPlan`, `recordMenuChoice`, `assertFlowGates`, `slugFromPath`, `docsValidate`, `sddContext`, `sddTaskBrief`, `sddReviewPackage`, `sddAppendProgress`, `resolveBranch`, `docsBranch`, `branchSetup`, `resolveWorkflowPaths`, `buildHandoffContract`, `parsePlanTasks`, `resolveHandoffBranch`
- Produces (changed constants only — signatures identical):
  - `flow.json` at `docs/<slug>/sdd/flow.json`
  - `sdd_dir = docs/<slug>/sdd`
  - slug derived from `docs/<slug>` dir name (no date prefix)
  - plan `**Spec:**` link `docs/<slug>/spec.md`
  - handoff message paths `docs/<slug>/plan.md` / `docs/<slug>/spec.md`

- [ ] **Step 1: Write the failing end-to-end test for the new layout**

Create `test/docs-layout.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSddTools } from "../src/tools/sdd";
import { WorkflowStateStore } from "../src/state";
import { createFlowTools } from "../src/tools/flow";
import { buildHandoffPrompt } from "../src/tools/handoff";

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-layout-"));
  const slug = "add-some-awesome-feat";
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  mkdirSync(path.join(root, "docs", slug, "sdd"), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"),
    `# Spec\n\n**Branch:** \`feature/${slug}\`\n`);
  writeFileSync(path.join(root, "docs", slug, "plan.md"),
    `# Plan\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n`);
  return { root, slug };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

test("flow state lives at docs/<slug>/sdd/flow.json", () => {
  const { root, slug } = fixture();
  try {
    const tools = createFlowTools();
    const ctx = { directory: root } as any;
    const spec = `docs/${slug}/spec.md`;
    const raw = await tools.workflow_spec_approve.execute(
      { confirmed: true, spec_path: spec }, ctx);
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(true);
    expect(existsSync(path.join(root, "docs", slug, "sdd", "flow.json"))).toBe(true);
    expect(existsSync(path.join(root, "docs", slug, "flow.json"))).toBe(false);
  } finally { cleanup(root); }
});

test("sdd context resolves docs/<slug>/sdd", () => {
  const { root, slug } = fixture();
  try {
    const raw = await createSddTools(new WorkflowStateStore()).workflow_sdd_context.execute(
      { plan_path: `docs/${slug}/plan.md` },
      { directory: root, worktree: root, sessionID: "s" } as never,
    );
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(true);
    expect(out.data.sdd_dir).toBe(`docs/${slug}/sdd`);
  } finally { cleanup(root); }
});

test("handoff resolves docs/<slug>/plan.md and spec.md", () => {
  const { root, slug } = fixture();
  try {
    const result = buildHandoffPrompt(root, `docs/${slug}/plan.md`);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.plan).toBe(`docs/${slug}/plan.md`);
      expect(result.spec).toBe(`docs/${slug}/spec.md`);
      expect(result.sdd).toBe(`docs/${slug}/sdd`);
    }
  } finally { cleanup(root); }
});

test("docs validate passes on the new layout", async () => {
  const { root, slug } = fixture();
  try {
    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_validate.execute(
      { spec_path: `docs/${slug}/spec.md`, plan_path: `docs/${slug}/plan.md` },
      { directory: root, worktree: root, sessionID: "s" } as never,
    );
    expect(JSON.parse(raw as string).ok).toBe(true);
  } finally { cleanup(root); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/docs-layout.test.ts`
Expected: FAIL — old paths produce wrong flow.json location and spec_mismatch.

- [ ] **Step 3: Migrate `src/core/flow-state.ts`**

Replace the flowPath helper:

```typescript
const flowPath = (root: string, slug: string) => {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid slug: ${JSON.stringify(slug)}`);
  return path.join(root, "docs", slug, "sdd", "flow.json");
};
```

- [ ] **Step 4: Migrate `src/core/sdd.ts`**

Replace the sdd_dir computation:

```typescript
const sdd_dir = path.join("docs", resolvedSlug, "sdd");
```

- [ ] **Step 5: Migrate `src/core/branch.ts`**

The default `sdd_dir` (line 168) stays `docs/superpowers/sdd` only as a fallback string — replace it with `docs/<slug>/sdd` where the slug is available; in practice callers always pass `sdd_dir` explicitly (tools and tests), so the default value is only a safety net. See steps 5b/5c below for the stash exclude and slug changes.

5b. Stash exclude covers the new layout:

```typescript
// branch.ts:168 — default sdd stays as-is (caller passes it; tests pass it too)
// branch.ts:203 — stash exclude covers the new layout:
exec(["stash", "push", "-u", "-m", `workflow-toolkit: pre-checkout ${target}`, "--", ":!docs/*/sdd"]);
```

5c. `deriveSlug` — the slug is the parent directory name of `plan.md` (drop date prefix and `-design` stripping). Replace the function and remove `DATE_PREFIX_RE`:

```typescript
const deriveSlug = (planPath: string): string => {
  // New layout: plan lives at docs/<slug>/plan.md — slug is the dir name.
  const dirName = path.basename(path.dirname(planPath));
  return dirName === "." || dirName === "/" || dirName === "" ? "" : dirName;
};
```

Delete the now-unused `DATE_PREFIX_RE` constant (line 10). `deriveKind` (line 35) uses `slug` for the bugfix heuristic and `readSafe(planPath)` for the **Goal:** line — the plan path is unchanged in shape, so `deriveKind` needs no edit beyond verifying it still receives the plan path. The three call sites (`resolveBranch` line 92, `docsBranch` line 116) keep passing the plan path — with `docs/<slug>/plan.md` the dirname now yields `<slug>` directly.

- [ ] **Step 6: Migrate `src/core/docs-validate.ts`**

Remove the mirror-path block (lines ~105-112) — no more `docs/specs/` support:

```typescript
const linked = (linkMatch[1] ?? linkMatch[2] ?? "").trim();
const linkedAbs = path.isAbsolute(linked) ? linked : path.join(cwd, linked);
if (path.resolve(linkedAbs) !== path.resolve(specAbs)) {
  errors.push(err("spec_mismatch", `plan **Spec:** ${linked} does not match spec_path ${spec_path}`, plan_path));
}
```

Remove the now-unused `existsSync` import if nothing else uses it.

- [ ] **Step 7: Migrate `src/core/handoff-context.ts`**

Rewrite resolution for the single-dir-per-feature layout. Replace `extractMessagePaths`, `normalizeDocPath`, `resolveFromMessagePaths`, and `resolveActivePair`:

```typescript
const DOC_RE = /docs\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(spec|plan)\.md/g;

const extractMessagePaths = (message: string): string[] =>
  [...new Set(message.match(DOC_RE) ?? [])].sort();

const resolveFromMessagePaths = (root: string, message: string): Resolved => {
  const paths = extractMessagePaths(message);
  if (paths.length === 0) return { error: "no paths" };
  const slugs = [...new Set(paths.map((p) => p.split("/")[1]))];
  if (slugs.length !== 1) return { error: "multiple features in message — use exactly one docs/<slug>/ pair" };
  const slug = slugs[0];
  const plan = `docs/${slug}/plan.md`;
  const spec = `docs/${slug}/spec.md`;
  if (!existsSync(path.join(root, plan)) || !existsSync(path.join(root, spec))) {
    return { error: `docs/${slug}/ must contain both plan.md and spec.md` };
  }
  return { spec, plan, source: "message_paths" };
};

const resolveActivePair = (root: string): Resolved => {
  const docsDir = path.join(root, "docs");
  let best: { score: number; spec: string; plan: string; source: string } | null = null;
  for (const slug of readdirSync(docsDir)) {
    if (slug.startsWith(".")) continue;
    const plan = path.join("docs", slug, "plan.md");
    const spec = path.join("docs", slug, "spec.md");
    if (!existsSync(path.join(root, plan)) || !existsSync(path.join(root, spec))) continue;
    const score = Math.max(statSync(path.join(root, spec)).mtimeMs, statSync(path.join(root, plan)).mtimeMs);
    if (best === null || score > best.score || (score === best.score && slug < best.spec.split("/")[1])) {
      best = { score, spec, plan, source: "active_pair" };
    }
  }
  if (best === null) return { error: "no pair" };
  return { spec: best.spec, plan: best.plan, source: best.source };
};
```

Update `resolveWorkflowPaths` fallbacks:

```typescript
const docsDir = path.join(root, "docs");
if (!existsSync(docsDir) || listMd(docsDir).length === 0) {
  return { error: "no docs/<slug>/ features found under docs/" };
}
return { error: "could not resolve spec and plan — mention docs/<slug>/plan.md or create docs/<slug>/{spec.md,plan.md}" };
```

Update `buildHandoffContract` slug + sddDir:

```typescript
const slug = path.basename(path.dirname(plan));
const sddDir = `docs/${slug}/sdd`;
```

- [ ] **Step 8: Migrate path constants in tools**

`src/tools/flow.ts`:

```typescript
const flowPathFor = (slug: string) => path.posix.join("docs", slug, "sdd", "flow.json");
```

`src/tools/handoff.ts`:

```typescript
const sdd = `docs/${path.basename(path.dirname(resolved.plan))}/sdd`;
```

`src/tools/sdd.ts`:

```typescript
sdd_dir: path.posix.join("docs", path.basename(path.dirname(planPath)), "sdd"),
```

`src/tools/repo.ts`:

```typescript
let resolvedSdd = sdd_dir ?? "docs/superpowers/sdd"; // keep — caller always passes it; default only used by tests
```

- [ ] **Step 9: Update existing test fixtures to the new layout**

For each of `test/flow-state.test.ts`, `test/flow-tools.test.ts`, `test/sdd.test.ts`, `test/branch-policy.test.ts`, `test/docs-validate.test.ts`, `test/handoff.test.ts`, `test/plugin.test.ts`, `test/mcp-regressions.test.ts`: replace fixtures that create `docs/superpowers/{specs,plans,sdd}/...` with `docs/<slug>/{spec.md,plan.md,sdd/}` per the mapping:

| Old fixture | New fixture |
| --- | --- |
| `docs/superpowers/specs/x-design.md` | `docs/x/spec.md` |
| `docs/superpowers/plans/x.md` | `docs/x/plan.md` |
| `docs/superpowers/sdd/x/` | `docs/x/sdd/` |
| plan `**Spec:**` link | `docs/x/spec.md` |
| `**Branch:** feature/x` unchanged | same |
| handoff message paths | `docs/x/plan.md` |

Delete tests that specifically tested the mirror `docs/specs/` behavior (mirror support removed).

- [ ] **Step 10: Run the full suite**

Run: `bun test`
Expected: PASS (includes the new `docs-layout.test.ts` + migrated fixtures).

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor(docs): migrate workflow docs to docs/<slug>/{spec.md,plan.md,sdd/}"
```

---

### Task 4: Update templates, gitignore, sync-runtime

**Files:**
- Modify: `templates/superpowers-doc-contract.md` (layout table + examples)
- Modify: `templates/execution-contract.md` (SDD path references)
- Modify: `.gitignore` (`docs/superpowers/` → `docs/*/sdd/`)
- Modify: `scripts/sync-runtime.sh` (ensure vendored skills synced for Cursor)
- Modify: `test/contracts.test.ts` (contract text assertions if any reference old paths)

**Interfaces:**
- Consumes: new layout from Task 3
- Produces: contract/gitignore/sync consistent with `docs/<slug>/`; Cursor plugin copy includes `vendor/superpowers/skills`

- [ ] **Step 1: Update `templates/superpowers-doc-contract.md`**

Replace the layout table:

```markdown
| Document | Path |
| --- | --- |
| Spec | `docs/<slug>/spec.md` |
| Plan | `docs/<slug>/plan.md` |
| SDD state | `docs/<slug>/sdd/` |
```

Replace the example block (currently uses `docs/superpowers/specs/...`):

```markdown
**Branch:** `feature/<slug>`

**Spec:** `docs/<slug>/spec.md`
```

Update the SDD sentence:

```markdown
- Keep all SDD state tracked under `docs/<slug>/sdd/`; use `workflow_sdd_context` and the registered `workflow_sdd_*` tools.
```

- [ ] **Step 2: Update `templates/execution-contract.md`**

Replace:

```markdown
- Tracked state, briefs, ledgers, and review diffs live only under `<SDD_DIR>` in `docs/superpowers/sdd/<slug>/` and use `workflow_sdd_*` tools.
```

with:

```markdown
- Tracked state, briefs, ledgers, and review diffs live only under `<SDD_DIR>` in `docs/<slug>/sdd/` and use `workflow_sdd_*` tools.
```

- [ ] **Step 3: Update `.gitignore`**

Replace:

```gitignore
# Superpowers workflow docs are working files, not versioned
docs/superpowers/
```

with:

```gitignore
# Feature SDD state is working files, not versioned (spec.md/plan.md stay tracked)
docs/*/sdd/
```

- [ ] **Step 4: Update `scripts/sync-runtime.sh`**

The rsync for the Cursor plugin copy (`$SHARE/cursor/` → `$PLUGIN_DIR/`) only copies `cursor/`. The vendored skills live at repo root `vendor/superpowers/skills`. Add a second rsync for the vendored skills into the plugin copy:

```bash
# Vendored skills for Cursor (same folder layout as OpenCode registration)
mkdir -p "$PLUGIN_DIR/vendor/superpowers"
rsync -a --delete "$SHARE/vendor/superpowers/skills" "$PLUGIN_DIR/vendor/superpowers/"
```

- [ ] **Step 5: Update `test/contracts.test.ts`**

Run `grep -rn "docs/superpowers" test/contracts.test.ts`; if any assertion expects the old contract text, update it to the new layout text from Step 1.

- [ ] **Step 6: Run the full suite**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(docs): update contract, gitignore, sync for docs/<slug>/ layout"
```

---

### Task 5: No-legacy grep gate + final check

**Files:**
- Modify: `test/mcp-regressions.test.ts` (add the grep gate test)
- No source changes expected

**Interfaces:**
- Consumes: all of Tasks 1-4
- Produces: proof that no `docs/superpowers` path remains in sources

- [ ] **Step 1: Write the failing grep-gate test**

Append to `test/mcp-regressions.test.ts`:

```typescript
test("no docs/superpowers paths remain in sources", () => {
  const { readdirSync, readFileSync, statSync } = require("node:fs") as typeof import("node:fs");
  const root = path.resolve(import.meta.dir, "..");
  const skipDirs = new Set(["node_modules", ".git", ".cache", "docs", "vendor"]);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (skipDirs.has(entry)) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|js|sh|md|json)$/.test(entry)) continue;
      const content = readFileSync(full, "utf8");
      if (content.includes("docs/superpowers")) {
        offenders.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/mcp-regressions.test.ts -t "no docs/superpowers paths remain"`
Expected: FAIL — lists files still referencing the old path.

- [ ] **Step 3: Fix remaining references**

For each offender: update the path to the new layout or remove the reference. Re-run until the test passes. (The `docs/` dir itself is skipped — the old spec/plan files there are user-side artifacts, not sources.)

- [ ] **Step 4: Final release gate**

Run: `bun run check`
Expected: all tests + typecheck PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(docs): grep gate — no docs/superpowers paths in sources"
```

---

## Post-plan checklist

- [ ] `bun run check` green after every task.
- [ ] `vendor/superpowers/skills/` has 14 SKILL.md dirs + VERSION + NOTICE.md.
- [ ] `opencode.json` has no `superpowers@git+https://...` entry.
- [ ] All fixtures and sources use `docs/<slug>/{spec.md,plan.md,sdd/}`.
- [ ] `.gitignore` contains `docs/*/sdd/` (spec/plan tracked).
- [ ] Grep gate test passes (no `docs/superpowers` in sources).
- [ ] `scripts/update-superpowers.sh` executable and runnable.
