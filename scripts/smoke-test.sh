#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

fail() { printf 'smoke-test FAIL: %s\n' "$1" >&2; exit 1; }

node -e "JSON.parse(require('fs').readFileSync('$PLUGIN_ROOT/.cursor-plugin/plugin.json'))" || fail 'plugin.json invalid'
node -e "JSON.parse(require('fs').readFileSync('$PLUGIN_ROOT/mcp.json'))" || fail 'mcp.json invalid'

for script in verify-project.sh pr-ready-context.sh changelog-context.sh \
  release-notes-context.sh docs-refresh-context.sh collect-handoff-context.sh; do
  [ -x "$PLUGIN_ROOT/scripts/$script" ] || fail "missing or not executable: $script"
done

[ -f "$PLUGIN_ROOT/scripts/_shared/common.sh" ] || fail 'common.sh missing'

[ -d "$PLUGIN_ROOT/mcp/node_modules/@modelcontextprotocol/sdk" ] || fail 'MCP sdk not installed'

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
git init -q
git config user.email smoke@test
git config user.name smoke
echo '{}' > package.json
git add package.json
git commit -q -m init
git checkout -q -b develop
git checkout -q -b feature/smoke
bash "$PLUGIN_ROOT/scripts/pr-ready-context.sh" >/dev/null || fail 'pr-ready-context.sh'
bash "$PLUGIN_ROOT/scripts/changelog-context.sh" >/dev/null || fail 'changelog-context.sh'

if [ -d "$HOME/.config/opencode/docs/superpowers/specs" ]; then
  OUT=$(cd "$HOME/.config/opencode" && bash "$PLUGIN_ROOT/scripts/collect-handoff-context.sh" 2>/dev/null) \
    || fail 'collect-handoff-context.sh active-pair auto mode'
  printf '%s' "$OUT" | grep -q 'workflow_plan_tasks' || fail 'handoff missing workflow_plan_tasks'
  printf '%s' "$OUT" | grep -q 'workflow_sdd_context' || fail 'handoff missing workflow_sdd_context'
  printf '%s' "$OUT" | grep -q 'TodoWrite' || fail 'handoff missing TodoWrite UI gate'
  printf '%s' "$OUT" | grep -q 'FORBIDDEN — SDD path' || fail 'handoff missing SDD path gate'
  printf '%s' "$OUT" | grep -q 'docs/superpowers/sdd/' || fail 'handoff missing docs SDD path'
  printf '%s' "$OUT" | grep -q 'COORDINATOR HARD-GATES' || fail 'handoff missing COORDINATOR HARD-GATES'
  printf '%s' "$OUT" | grep -qE '\*\*Branch:\*\* (feature|bugfix)/' || fail 'handoff missing resolved branch'
  printf '%s' "$OUT" | grep -q '<USER FILLS>' && fail 'handoff still has USER FILLS placeholders'
  printf '%s' "$OUT" | grep -q 'Commit policy' && fail 'handoff should not include commit policy field'

  HANDOFF_MSG='docs/superpowers/specs/2026-06-17-workflow-toolkit-design.md docs/superpowers/plans/2026-06-17-workflow-toolkit.md'
  OUT=$(cd "$HOME/.config/opencode" && bash "$PLUGIN_ROOT/scripts/collect-handoff-context.sh" "$HANDOFF_MSG" 2>/dev/null) \
    || fail 'collect-handoff-context.sh message paths'
  printf '%s' "$OUT" | grep -q '2026-06-17-workflow-toolkit-design.md' || fail 'handoff message paths wrong spec'
fi

[ -f "$PLUGIN_ROOT/templates/execution-contract.md" ] || fail 'missing execution-contract.md'
[ -f "$PLUGIN_ROOT/templates/superpowers-doc-contract.md" ] || fail 'missing superpowers-doc-contract.md'
[ -x "$PLUGIN_ROOT/hooks/session-start" ] || fail 'missing hooks/session-start'
bash "$PLUGIN_ROOT/hooks/session-start" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'additional_context' in d"
[ -x "$PLUGIN_ROOT/scripts/lib/resolve-handoff-branch.sh" ] || fail 'missing resolve-handoff-branch.sh'
"$PLUGIN_ROOT/scripts/lib/parse-plan-tasks.sh" "$PLUGIN_ROOT/scripts/fixtures/sample-plan.md" --format=json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['task_count']==2; assert d['tasks'][0]['section_text']"
grep -q workflow_plan_tasks "$PLUGIN_ROOT/mcp/server.js" || fail 'workflow_plan_tasks not registered'

# pr-ready: branch-exclusive range on feature/* (not origin/main when forked from develop)
PR_TMP=$(mktemp -d)
(
  cd "$PR_TMP" && git init -q && git config user.email t@t.com && git config user.name t
  echo root > f && git add f && git commit -q -m "root"
  git branch -m main
  git checkout -q -b develop
  echo develop > d && git add d && git commit -q -m "develop setup"
  git checkout -q -b feature/my-work
  echo feat >> f && git add f && git commit -q -m "feat: my work"
  git checkout -q develop
  echo other > x && git add x && git commit -q -m "develop-only"
  git checkout -q feature/my-work
  OUT=$(bash "$PLUGIN_ROOT/scripts/pr-ready-context.sh" 2>/dev/null)
  printf '%s' "$OUT" | grep -q 'range_mode: branch-exclusive' || exit 1
  printf '%s' "$OUT" | grep -q 'git_sync:' || exit 1
  printf '%s' "$OUT" | grep -q 'base_ref: develop' || exit 1
  printf '%s' "$OUT" | grep -q 'range: develop\.\.HEAD' || exit 1
  printf '%s' "$OUT" | grep -q 'feat: my work' || exit 1
  printf '%s' "$OUT" | grep -q 'develop setup' && exit 1
  printf '%s' "$OUT" | grep -q 'develop-only' && exit 1
  git checkout -q develop
  bash "$PLUGIN_ROOT/scripts/pr-ready-context.sh" >/dev/null 2>&1 && exit 1
  exit 0
) || fail 'pr-ready branch-exclusive range'
rm -rf "$PR_TMP"

# MCP workspace root: WORKFLOW_WORKSPACE_ROOT env (from run-server.sh ${workspaceFolder} arg)
WS_TMP=$(mktemp -d)
(
  cd "$WS_TMP" && git init -q && git config user.email t@t.com && git config user.name t
  echo root > f && git add f && git commit -q -m "root"
  git checkout -q -b develop
  git checkout -q -b feature/ws-env
  cd /tmp
  WORKFLOW_WORKSPACE_ROOT="$WS_TMP" node -e "
    import { runScript } from '$PLUGIN_ROOT/mcp/lib/run-script.js';
    const r = runScript('pr-ready-context.sh', [], undefined);
    if (r.exitCode !== 0) process.exit(1);
    if (!r.stdout.includes('branch: feature/ws-env')) process.exit(1);
  " || exit 1
) || fail 'WORKFLOW_WORKSPACE_ROOT not honored by runScript'
rm -rf "$WS_TMP"

# Full checks (Task 12)
chmod +x "$PLUGIN_ROOT/scripts/init/"*.sh "$PLUGIN_ROOT/scripts/present/"*.sh 2>/dev/null || true

for script in init/status.sh init/apply.sh present/ascii-wireframe.sh present/flow-diagram.sh; do
  [ -x "$PLUGIN_ROOT/scripts/$script" ] || fail "missing $script"
done

bash "$PLUGIN_ROOT/scripts/init/status.sh" | python3 -c "import json,sys; json.load(sys.stdin)"

echo '{"title":"Test","rows":[{"type":"header","label":"Hi"}]}' | bash "$PLUGIN_ROOT/scripts/present/ascii-wireframe.sh" | grep -q '┌' || fail 'ascii-wireframe'

echo '{"nodes":[{"id":"A","label":"Start"}],"edges":[]}' | bash "$PLUGIN_ROOT/scripts/present/flow-diagram.sh" | grep -q 'flowchart' || fail 'flow-diagram'

[ -f "$PLUGIN_ROOT/rules/ask-question-only.mdc" ] || fail 'missing rules/ask-question-only.mdc'
grep -q 'AskQuestion' "$PLUGIN_ROOT/rules/ask-question-only.mdc" || fail 'ask-question rule incomplete'
grep -q 'plan_execution' "$PLUGIN_ROOT/rules/ask-question-only.mdc" || fail 'post-plan AskQuestion override missing'
[ -f "$PLUGIN_ROOT/rules/no-worktrees.mdc" ] || fail 'missing no-worktrees rule'
grep -q 'workflow_branch_setup' "$PLUGIN_ROOT/templates/execution-contract.md" || fail 'branch setup missing from contract'
grep -q '\.superpowers/sdd' "$PLUGIN_ROOT/templates/execution-contract.md" || fail 'SDD forbidden path missing from contract'
grep -q 'workflow_sdd_context' "$PLUGIN_ROOT/templates/execution-contract.md" || fail 'workflow_sdd_context missing from contract'
[ -f "$PLUGIN_ROOT/rules/sdd-docs-path.mdc" ] || fail 'missing sdd-docs-path rule'
[ -f "$PLUGIN_ROOT/rules/cursor-todowrite.mdc" ] || fail 'missing cursor-todowrite rule'
grep -q 'TodoWrite' "$PLUGIN_ROOT/templates/execution-contract.md" || fail 'TodoWrite missing from contract'
chmod +x "$PLUGIN_ROOT/scripts/sdd/"*.sh 2>/dev/null || true
SDD_TMP=$(mktemp -d)
(
  cd "$SDD_TMP" && git init -q
  OUT=$(bash "$PLUGIN_ROOT/scripts/sdd/sdd-workspace.sh" test-plan-slug)
  [ "$OUT" = "docs/superpowers/sdd/test-plan-slug" ] || exit 1
  [ -f docs/superpowers/sdd/test-plan-slug/progress.md ] || exit 1
  echo '### Task 1: smoke' > section.txt
  bash "$PLUGIN_ROOT/scripts/sdd/task-brief.sh" docs/superpowers/sdd/test-plan-slug 1 section.txt
  [ -f docs/superpowers/sdd/test-plan-slug/task-1-brief.md ] || exit 1
  PARSED=$(bash "$PLUGIN_ROOT/scripts/sdd/parse-progress.sh" "$PLUGIN_ROOT/scripts/fixtures/sample-sdd/progress.md")
  printf '%s' "$PARSED" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 1 in d['completed_task_ids']"
  [ ! -d .workflow ] || exit 1
  node -e "
    import { sddTaskBrief } from '$PLUGIN_ROOT/mcp/lib/sdd-context.js';
    const r = sddTaskBrief({
      sdd_dir: 'docs/superpowers/sdd/test-plan-slug',
      task_id: 2,
      section_text: '### Task 2: via mcp',
      workspace_root: process.cwd(),
    });
    if (r.error) process.exit(1);
    import fs from 'node:fs';
    if (fs.existsSync('.workflow')) process.exit(1);
  " || exit 1
) || fail 'SDD scripts'
# TodoWrite payload from sdd context
node -e "
  import { todosFromTasks } from '$PLUGIN_ROOT/mcp/lib/sdd-context.js';
  const todos = todosFromTasks(
    [{ id: 1, title: 'A' }, { id: 2, title: 'B' }, { id: 3, title: 'C' }],
    [1],
  );
  if (todos[0].status !== 'completed') process.exit(1);
  if (todos[1].status !== 'in_progress') process.exit(1);
  if (todos[2].status !== 'pending') process.exit(1);
  if (todos[1].id !== 'task-2') process.exit(1);
" || fail 'todosFromTasks shape'
rm -rf "$SDD_TMP"
grep -qE '^0\. \*\*using-git-worktrees\*\*|Load `using-git-worktrees`' "$PLUGIN_ROOT/templates/execution-contract.md" \
  && fail 'worktrees still required in execution contract'
chmod +x "$PLUGIN_ROOT/scripts/branch/setup-branch.sh" 2>/dev/null || true
BR_TMP=$(mktemp -d)
(
  cd "$BR_TMP" && git init -q && git config user.email t@t.com && git config user.name t
  echo a > f && git add f && git commit -q -m init
  git checkout -q -b feature/test-branch
  OUT=$(bash "$PLUGIN_ROOT/scripts/branch/setup-branch.sh" setup docs/superpowers/sdd/test feature/test-branch no)
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); assert d['branch']=='feature/test-branch'" "$OUT"
) || fail 'branch setup script'
rm -rf "$BR_TMP"
grep -q 'HARD-GATE — Cursor AskQuestion' "$PLUGIN_ROOT/templates/superpowers-doc-contract.md" || fail 'doc contract missing AskQuestion HARD-GATE'
bash "$PLUGIN_ROOT/hooks/session-start" | python3 -c "import json,sys; d=json.load(sys.stdin); c=d.get('additional_context',''); assert 'AskQuestion' in c and 'workflow_sdd_context' in c and 'TodoWrite' in c"

chmod +x "$PLUGIN_ROOT/scripts/init/toolkit-status.sh" 2>/dev/null || true
[ -x "$PLUGIN_ROOT/scripts/init/toolkit-status.sh" ] || fail 'missing toolkit-status.sh'
bash "$PLUGIN_ROOT/scripts/init/toolkit-status.sh" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'youtrack_verify' in d and 'youtrack_config' in d"

SKILLS=(wf-verify wf-pr wf-changelog wf-release-notes wf-docs-refresh wf-commit wf-handoff wf-implement wf-init wf-status wf-meetings wf-issue-update)
for s in "${SKILLS[@]}"; do
  [ -f "$PLUGIN_ROOT/skills/$s/SKILL.md" ] || fail "skill missing: $s"
done

chmod +x "$PLUGIN_ROOT/scripts/vcs/"*.sh 2>/dev/null || true
[ -x "$PLUGIN_ROOT/scripts/pr-create.sh" ] || fail 'missing pr-create.sh'
"$PLUGIN_ROOT/scripts/youtrack/parse-duration.sh" '1h 30m' | python3 -c "import json,sys; assert json.load(sys.stdin)['minutes']==90"
"$PLUGIN_ROOT/scripts/youtrack/work-date-ms.sh" auto | python3 -c "import json,sys; d=json.load(sys.stdin); assert isinstance(d['dateMs'], int) and d['dateMs'] > 0"

# changelog merge into existing Unreleased categories (no duplicate ### Added)
CL_TMP=$(mktemp -d)
(
  cd "$CL_TMP"
  cat > CHANGELOG.md <<'EOF'
# Changelog

## [Unreleased]

### Added

- **Old feature** — already there.

### Fixed

- **Old bug** — already there.

## [1.0.0] - 2026-01-01

### Added

- Initial release.
EOF
  python3 "$PLUGIN_ROOT/scripts/changelog/apply-unreleased.py" <<'JSON'
{"entries":{"Added":["**New feature** — from task"],"Fixed":["**New bugfix** — from task"]}}
JSON
  ADDED_N=$(grep -c '^### Added' CHANGELOG.md)
  FIXED_N=$(grep -c '^### Fixed' CHANGELOG.md)
  UNREL_N=$(grep -c '^## \[Unreleased\]' CHANGELOG.md)
  [ "$ADDED_N" = "2" ] || exit 1   # one under Unreleased, one under 1.0.0
  [ "$FIXED_N" = "1" ] || exit 1   # only Unreleased
  [ "$UNREL_N" = "1" ] || exit 1
  grep -q 'New feature' CHANGELOG.md || exit 1
  grep -q 'Old feature' CHANGELOG.md || exit 1
  # duplicate headings collapse
  cat > CHANGELOG.md <<'EOF'
# Changelog

## [Unreleased]

### Added

- **A** — one.

### Fixed

- **B** — two.

### Added

- **C** — three.
EOF
  python3 "$PLUGIN_ROOT/scripts/changelog/apply-unreleased.py" <<'JSON'
{"normalize_only":true}
JSON
  [ "$(grep -c '^### Added' CHANGELOG.md)" = "1" ] || exit 1
  [ "$(grep -c '^## \[Unreleased\]' CHANGELOG.md)" = "1" ] || exit 1
  grep -q '\*\*A\*\*' CHANGELOG.md || exit 1
  grep -q '\*\*C\*\*' CHANGELOG.md || exit 1
) || fail 'changelog apply-unreleased merge'
rm -rf "$CL_TMP"

for tool in workflow_verify workflow_pr_context workflow_changelog_context \
  workflow_changelog_apply \
  workflow_release_notes_context workflow_docs_context workflow_git_context \
  workflow_plan_tasks workflow_handoff_prompt workflow_toolkit_init_status \
  workflow_toolkit_init_apply workflow_present_ascii \
  workflow_present_flow workflow_youtrack_verify_token workflow_toolkit_status \
  workflow_youtrack_context workflow_youtrack_parse_issue workflow_youtrack_parse_duration workflow_youtrack_log_time \
  workflow_youtrack_draft workflow_youtrack_post workflow_pr_create \
  workflow_resolve_branch workflow_branch_setup workflow_sdd_context workflow_sdd_task_brief \
  workflow_sdd_review_package workflow_sdd_append_progress; do
  grep -q "$tool" "$PLUGIN_ROOT/mcp/server.js" || fail "tool not registered: $tool"
done

if [ -f "$PLUGIN_ROOT/skills/wf-verify/SKILL.md" ]; then
  printf 'smoke-test: OK\n'
else
  printf 'smoke-test: OK (scaffold)\n'
fi
