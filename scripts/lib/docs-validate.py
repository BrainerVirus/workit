#!/usr/bin/env python3
"""Validate linked spec/plan docs for workflow handoff/implement gates."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

BRANCH_RE = re.compile(
    r"^\s*\*+Branch:\*+\s*`?((?:feature|bugfix)/[^`\s|]+)`?\s*$",
    re.I | re.M,
)
SPEC_LINK_RE = re.compile(r"^\s*\*+Spec:\*+\s*(?:`([^`]+)`|(\S+))\s*$", re.I | re.M)
TASK_RE = re.compile(r"^###\s+Task\s+(\d+):\s*(.*)$", re.I)


def err(code: str, message: str, path: str | None = None) -> dict:
    item: dict[str, str] = {"code": code, "message": message}
    if path:
        item["path"] = path
    return item


def read_branch(text: str, label: str) -> tuple[str | None, dict | None]:
    match = BRANCH_RE.search(text)
    if not match:
        return None, err("missing_branch", f"**Branch:** feature/* or bugfix/* required in {label}")
    return match.group(1).strip().strip("`"), None


def scan_task_headings(plan_text: str) -> tuple[list[int], list[str], dict | None]:
    ids: list[int] = []
    titles: list[str] = []
    in_fence = False
    for line in plan_text.splitlines():
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        match = TASK_RE.match(line)
        if match:
            ids.append(int(match.group(1)))
            titles.append(match.group(2).strip())
    if not ids:
        return ids, titles, err("task_order", "no ### Task N sections found outside fences")
    expected = list(range(1, len(ids) + 1))
    if sorted(ids) != expected or len(set(ids)) != len(ids):
        return ids, titles, err(
            "task_order",
            f"task headings must be contiguous from 1..{len(ids)}; found {ids}",
        )
    return ids, titles, None


def main() -> int:
    if len(sys.argv) < 4:
        print(json.dumps({"ok": False, "errors": [err("usage", "spec_path plan_path parse_script required")]}))
        return 1

    spec_arg, plan_arg, parser = sys.argv[1], sys.argv[2], sys.argv[3]
    cwd = Path.cwd()
    spec_path = Path(spec_arg) if os.path.isabs(spec_arg) else cwd / spec_arg
    plan_path = Path(plan_arg) if os.path.isabs(plan_arg) else cwd / plan_arg
    errors: list[dict] = []

    if not spec_path.is_file():
        errors.append(err("missing_file", f"spec not found: {spec_arg}", spec_arg))
    if not plan_path.is_file():
        errors.append(err("missing_file", f"plan not found: {plan_arg}", plan_arg))
    if errors:
        print(json.dumps({"ok": False, "errors": errors}))
        return 1

    spec_text = spec_path.read_text(encoding="utf-8")
    plan_text = plan_path.read_text(encoding="utf-8")

    spec_branch, spec_err = read_branch(spec_text, "spec")
    if spec_err:
        errors.append(spec_err)
    plan_branch, plan_err = read_branch(plan_text, "plan")
    if plan_err:
        errors.append(plan_err)

    link_match = SPEC_LINK_RE.search(plan_text)
    if not link_match:
        errors.append(err("missing_spec_link", "**Spec:** link required in plan", str(plan_arg)))
    else:
        linked = (link_match.group(1) or link_match.group(2) or "").strip()
        linked_path = Path(linked) if os.path.isabs(linked) else cwd / linked
        try:
            if linked_path.resolve() != spec_path.resolve():
                errors.append(
                    err(
                        "spec_mismatch",
                        f"plan **Spec:** {linked} does not match spec_path {spec_arg}",
                        str(plan_arg),
                    )
                )
        except OSError:
            errors.append(err("spec_mismatch", f"cannot resolve plan **Spec:** {linked}", str(plan_arg)))

    if spec_branch and plan_branch and spec_branch != plan_branch:
        errors.append(
            err(
                "branch_mismatch",
                f"spec branch {spec_branch!r} != plan branch {plan_branch!r}",
                str(plan_arg),
            )
        )

    _, _, task_err = scan_task_headings(plan_text)
    if task_err:
        errors.append(task_err)

    if errors:
        print(json.dumps({"ok": False, "errors": errors}))
        return 1

    parse = subprocess.run(
        ["bash", parser, str(plan_path), "--format=json"],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=False,
    )
    if parse.returncode != 0:
        message = (parse.stderr or parse.stdout or "parse-plan-tasks failed").strip()
        print(json.dumps({"ok": False, "errors": [err("parse_failed", message, str(plan_arg))]}))
        return 1

    try:
        parsed = json.loads(parse.stdout.strip())
    except json.JSONDecodeError:
        print(json.dumps({"ok": False, "errors": [err("parse_failed", "invalid JSON from parse-plan-tasks", str(plan_arg))]}))
        return 1

    parsed_tasks = parsed.get("tasks") or []
    heading_ids, heading_titles, task_err = scan_task_headings(plan_text)
    if task_err:
        print(json.dumps({"ok": False, "errors": [task_err]}))
        return 1

    if len(parsed_tasks) != len(heading_ids):
        print(
            json.dumps(
                {
                    "ok": False,
                    "errors": [
                        err(
                            "task_order",
                            f"parse-plan-tasks count {len(parsed_tasks)} != heading count {len(heading_ids)}",
                            str(plan_arg),
                        )
                    ],
                }
            )
        )
        return 1

    for i, task in enumerate(parsed_tasks):
        if str(task.get("id")) != str(heading_ids[i]):
            print(
                json.dumps(
                    {
                        "ok": False,
                        "errors": [
                            err(
                                "task_order",
                                f"task id mismatch at position {i + 1}",
                                str(plan_arg),
                            )
                        ],
                    }
                )
            )
            return 1
        if (task.get("title") or "").strip() != heading_titles[i]:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "errors": [
                            err(
                                "task_order",
                                f"task title mismatch for Task {heading_ids[i]}",
                                str(plan_arg),
                            )
                        ],
                    }
                )
            )
            return 1

    rel_spec = spec_arg if not os.path.isabs(spec_arg) else os.path.relpath(spec_path, cwd)
    rel_plan = plan_arg if not os.path.isabs(plan_arg) else os.path.relpath(plan_path, cwd)
    print(
        json.dumps(
            {
                "ok": True,
                "spec": rel_spec,
                "plan": rel_plan,
                "branch": spec_branch,
                "task_count": len(parsed_tasks),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
