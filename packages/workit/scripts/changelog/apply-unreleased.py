#!/usr/bin/env python3
"""Merge Keep a Changelog entries into ## [Unreleased] without duplicating ### headings."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

CATEGORIES = (
    "Added",
    "Changed",
    "Deprecated",
    "Removed",
    "Fixed",
    "Security",
)
CAT_RE = re.compile(
    r"^###\s+(" + "|".join(CATEGORIES) + r")\s*$",
    re.IGNORECASE,
)
UNRELEASED_RE = re.compile(r"^##\s+\[Unreleased\]\s*$", re.IGNORECASE | re.MULTILINE)
VERSION_RE = re.compile(r"^##\s+\[", re.MULTILINE)
BULLET_RE = re.compile(r"^([-*]\s+)(.+?)\s*$")
HEADING_RE = re.compile(r"^###\s+")

SKELETON = """# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

"""


def normalize_bullet(text: str) -> str:
    text = text.strip()
    m = BULLET_RE.match(text)
    if m:
        return m.group(2).strip()
    if text.startswith(("- ", "* ")):
        return text[2:].strip()
    return text


def format_bullet(text: str) -> str:
    body = normalize_bullet(text)
    return f"- {body}"


def split_unreleased(text: str) -> tuple[str, str, str]:
    lines = text.splitlines(keepends=True)
    start = None
    for i, line in enumerate(lines):
        if UNRELEASED_RE.match(line.rstrip("\n")):
            start = i
            break
    if start is None:
        return text, "", ""

    end = len(lines)
    for j in range(start + 1, len(lines)):
        stripped = lines[j].rstrip("\n")
        # Next version heading ends Unreleased (ignore a stray second Unreleased)
        if VERSION_RE.match(stripped):
            if UNRELEASED_RE.match(stripped):
                continue
            end = j
            break

    before = "".join(lines[: start + 1])
    body = "".join(lines[start + 1 : end])
    after = "".join(lines[end:])
    return before, body, after


def canonical_category(heading: str) -> str | None:
    match = CAT_RE.match(heading.rstrip("\r\n"))
    if not match:
        return None
    return next(c for c in CATEGORIES if c.lower() == match.group(1).lower())


def split_sections(body: str) -> tuple[list[str], list[dict]]:
    preamble: list[str] = []
    sections: list[dict] = []
    current: dict | None = None
    for line in body.splitlines(keepends=True):
        if HEADING_RE.match(line):
            current = {
                "heading": line,
                "category": canonical_category(line),
                "body": [],
            }
            sections.append(current)
        elif current is None:
            preamble.append(line)
        else:
            current["body"].append(line)
    return preamble, sections


def bullet_blocks(lines: list[str]) -> list[tuple[str | None, list[str]]]:
    blocks: list[tuple[str | None, list[str]]] = []
    current: list[str] = []
    key: str | None = None
    for line in lines:
        match = BULLET_RE.match(line.rstrip("\r\n"))
        if match:
            if current:
                blocks.append((key, current))
            key = normalize_bullet(line).lower()
            current = [line]
        else:
            current.append(line)
    if current:
        blocks.append((key, current))
    return blocks


def merge_sections(body: str, entries: dict[str, list[str]], normalize_only: bool):
    preamble, sections = split_sections(body)
    first: dict[str, dict] = {}
    rendered: list[dict] = []
    for section in sections:
        category = section["category"]
        if category and category in first:
            first[category]["body"].extend(section["body"])
        else:
            rendered.append(section)
            if category:
                first[category] = section

    added: dict[str, int] = {}
    if not normalize_only:
        for raw_category, bullets in entries.items():
            category = next(
                (c for c in CATEGORIES if c.lower() == raw_category.lower()),
                None,
            )
            if category is None:
                return None, None, {"error": f"invalid category: {raw_category}"}
            section = first.get(category)
            if section is None:
                section = {
                    "heading": f"### {category}\n",
                    "category": category,
                    "body": ["\n"],
                }
                rendered.append(section)
                first[category] = section

            seen: set[str] = set()
            kept: list[str] = []
            for key, block in bullet_blocks(section["body"]):
                if key is not None and key in seen:
                    continue
                if key is not None:
                    seen.add(key)
                kept.extend(block)

            fresh: list[str] = []
            for bullet in bullets or []:
                key = normalize_bullet(bullet).lower()
                if not key or key in seen:
                    continue
                seen.add(key)
                fresh.append(format_bullet(bullet) + "\n")
            if fresh:
                insert_at = 0
                while insert_at < len(kept) and not kept[insert_at].strip():
                    insert_at += 1
                section["body"] = kept[:insert_at] + fresh + kept[insert_at:]
            else:
                section["body"] = kept
            added[category] = len(fresh)

    output = "".join(preamble)
    for section in rendered:
        output += section["heading"] + "".join(section["body"])
    counts = {
        category: sum(
            1 for key, _ in bullet_blocks(section["body"]) if key is not None
        )
        for category, section in first.items()
    }
    return output, counts, added


def ensure_file(path: Path) -> str:
    if path.exists():
        return path.read_text(encoding="utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(SKELETON, encoding="utf-8", newline="")
    return SKELETON


def has_unreleased_heading(text: str) -> bool:
    return any(
        UNRELEASED_RE.match(line.rstrip("\n")) for line in text.splitlines()
    )


def apply(
    path: Path,
    entries: dict[str, list[str]] | None,
    normalize_only: bool = False,
) -> dict:
    text = ensure_file(path)
    if not has_unreleased_heading(text):
        lines = text.splitlines(keepends=True)
        insert_at = len(lines)
        for i, line in enumerate(lines):
            if VERSION_RE.match(line.rstrip("\n")) and not UNRELEASED_RE.match(
                line.rstrip("\n")
            ):
                insert_at = i
                break
        text = (
            "".join(lines[:insert_at])
            + "## [Unreleased]\n\n"
            + "".join(lines[insert_at:])
        )

    before, body, after = split_unreleased(text)
    new_body, counts, added_counts = merge_sections(
        body, entries or {}, normalize_only
    )
    if isinstance(added_counts, dict) and added_counts.get("error"):
        return added_counts
    # before already includes "## [Unreleased]\n"
    if not before.endswith("\n"):
        before += "\n"
    out = before + new_body + after
    path.write_text(out, encoding="utf-8", newline="")
    return {
        "ok": True,
        "path": str(path),
        "normalize_only": normalize_only,
        "added": added_counts,
        "categories": counts,
    }


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"error": "JSON stdin required"}))
        return 1
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"invalid JSON: {e}"}))
        return 1

    rel = payload.get("path") or "CHANGELOG.md"
    path = Path(rel)
    if not path.is_absolute():
        path = Path.cwd() / path

    normalize_only = bool(payload.get("normalize_only", False))
    entries = payload.get("entries") or {}
    if not normalize_only and not entries:
        print(json.dumps({"error": "entries required unless normalize_only"}))
        return 1

    # Normalize list or dict forms
    if isinstance(entries, list):
        grouped: dict[str, list[str]] = {}
        for item in entries:
            cat = item.get("category") or item.get("type")
            text = item.get("text") or item.get("entry") or ""
            if not cat or not text:
                print(json.dumps({"error": "each entry needs category + text"}))
                return 1
            grouped.setdefault(cat, []).append(text)
        entries = grouped

    result = apply(path, entries, normalize_only=normalize_only)
    print(json.dumps(result))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
