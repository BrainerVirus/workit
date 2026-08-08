#!/usr/bin/env bash
# Load workflow-toolkit VCS config (GitLab / GitHub). Token never printed.
# Commands: load (vcs.json + resolved workspace merged), summary (load minus tokenPath), resolve (workspace only).
set -euo pipefail

CMD="${1:-load}"
# Mirrors src/core/config.ts configDir chain: WORKFLOW_TOOLKIT_CONFIG ->
# WORKFLOW_TOOLKIT_CONFIG_DIR -> XDG_CONFIG_HOME/$HOME/.config + /workflow-toolkit.
# WORKFLOW_VCS_CONFIG stays the explicit full-path override.
CONFIG="${WORKFLOW_VCS_CONFIG:-${WORKFLOW_TOOLKIT_CONFIG:-${WORKFLOW_TOOLKIT_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/workflow-toolkit}}/vcs.json}"
TOKEN_PLACEHOLDER='YOUR_TOKEN_HERE'
WORKSPACES="$(dirname "$CONFIG")/workspaces.json"
CWD="${WORKFLOW_WORKSPACE_ROOT:-$PWD}"

case "$CMD" in
  load|summary|resolve)
    python3 - "$CONFIG" "$WORKSPACES" "$CWD" "$TOKEN_PLACEHOLDER" "$CMD" <<'PY'
import json, os, re, sys
from pathlib import Path

cfg_path = Path(os.path.expanduser(sys.argv[1]))
ws_path = Path(os.path.expanduser(sys.argv[2]))
cwd = os.path.expanduser(sys.argv[3])
placeholder = sys.argv[4]
mode = sys.argv[5]

# mirrors src/core/workspaces.ts globToRegExp: `*` -> [^/]*, `**/` -> (?:[^/]+/)* (leading consumes /),
# trailing `**` -> (?:/.*)? plus [^/]* from the second star (bare parent matches), everything else
# regex-escaped. First-wins, never throws.
def glob_to_regexp(glob: str) -> "re.Pattern[str]":
    out = ""
    i = 0
    while i < len(glob):
        c = glob[i]
        if c == "*":
            if i + 1 < len(glob) and glob[i + 1] == "*":
                if i + 2 < len(glob) and glob[i + 2] == "/":
                    if out == "":
                        out += "/?"
                    out += "(?:[^/]+/)*"
                    i += 2
                else:
                    if i + 2 >= len(glob):
                        if out.endswith("/"):
                            out = out[:-1]
                        out += "(?:/.*)?"
                    else:
                        out += ".*"
                    i += 1
            else:
                out += "[^/]*"
        else:
            out += re.escape(c)
        i += 1
    return re.compile("^" + out + "$")


def resolve_workspace() -> dict | None:
    try:
        parsed = json.loads(ws_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(parsed, dict):
        return None
    lst = parsed.get("workspaces")
    if not isinstance(lst, list):
        return None
    cwd_posix = cwd.replace(os.sep, "/")
    for entry in lst:
        if not isinstance(entry, dict):
            continue
        glob = entry.get("glob")
        if not isinstance(glob, str) or not glob:
            continue
        if glob_to_regexp(glob).match(cwd_posix):
            return entry
    return None

ws = resolve_workspace()
ws_vcs = ws.get("vcs") if isinstance(ws, dict) and isinstance(ws.get("vcs"), dict) else {}
ws_yt = ws.get("youtrack") if isinstance(ws, dict) and isinstance(ws.get("youtrack"), dict) else {}

cfg: dict = {}
cfg_ok = False
if cfg_path.is_file():
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        cfg_ok = isinstance(cfg, dict)
    except Exception:
        pass

provider = ((ws_vcs.get("provider") or cfg.get("provider")) or "gitlab").lower()
default_target = ws_vcs.get("defaultTargetBranch") or cfg.get("defaultTargetBranch", "develop")
link_issues = ws_yt.get("link_issues")
youtrack_base_url = ws_yt.get("baseUrl")

if mode == "resolve":
    print(json.dumps({
        "ok": True,
        "workspace_name": ws.get("name") if isinstance(ws, dict) else None,
        "provider": provider,
        "defaultTargetBranch": default_target,
        "link_issues": link_issues if isinstance(link_issues, bool) else None,
        "youtrack_base_url": youtrack_base_url if isinstance(youtrack_base_url, str) else None,
    }))
    sys.exit(0)

if not cfg_ok:
    print(json.dumps({"ok": False, "error": "missing or invalid vcs.json"}))
    sys.exit(1)

prov = cfg.get(provider) or {}
token_file = prov.get("tokenFile") or str(Path.home() / f".config/workflow-toolkit/{provider}.token")
token_path = Path(os.path.expanduser(token_file))
token_ok = False
token_placeholder = True
if token_path.is_file():
    token = token_path.read_text(encoding="utf-8").strip()
    token_placeholder = not token or token == placeholder or token.startswith(placeholder)
    token_ok = not token_placeholder

out = {
    "ok": True,
    "configPath": str(cfg_path.resolve()),
    "provider": provider,
    "defaultTargetBranch": default_target,
    "pr": cfg.get("pr") or {},
    "tokenPath": str(token_path.resolve()),
    "tokenPresent": token_path.is_file(),
    "tokenReady": token_ok,
    "workspace_name": ws.get("name") if isinstance(ws, dict) else None,
    "link_issues": link_issues if isinstance(link_issues, bool) else None,
    "youtrack_base_url": youtrack_base_url if isinstance(youtrack_base_url, str) else None,
}
if provider == "gitlab":
    out["gitlab"] = {
        "host": prov.get("host", "gitlab.com"),
        "apiUrl": prov.get("apiUrl", "https://gitlab.com/api/v4"),
    }
elif provider == "github":
    out["github"] = {
        "host": prov.get("host", "github.com"),
    }

if mode == "summary":
    out.pop("tokenPath", None)
print(json.dumps(out))
PY
    ;;
  *)
    echo 'ERROR: unknown command (load|summary|resolve)' >&2
    exit 1
    ;;
esac
