#!/usr/bin/env python3
"""Index and check the decision blocks in docs/.

Usage:
  python3 scripts/decisions_index.py           # rewrite the index in docs/decisions/README.md
  python3 scripts/decisions_index.py --check   # exit 1 if a block is invalid or the index is stale

A decision lives in the topic doc it governs: a heading, then an HTML comment that
holds its fields (format: docs/decisions/README.md). Stdlib only, like docs_sync.py,
so the pre-commit hook runs it before anything is installed.
"""

from __future__ import annotations

import argparse
import json
import posixpath
import re
import subprocess
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

INDEX_PATH = "docs/decisions/README.md"
DOCS_DIR = "docs"
CONTRACT_PATH = "contracts/docs-sync.json"
BEGIN = "<!-- decisions:generated -->"
END = "<!-- /decisions:generated -->"
ISSUE_URL = "https://github.com/calebn/sharecut-studio/issues/"

Status = Literal["accepted", "proposed", "superseded"]
HEADING_PREFIX: dict[Status, str] = {
    "accepted": "Decision: ",
    "proposed": "Proposed decision: ",
    "superseded": "Superseded decision: ",
}
SCALAR_KEYS = frozenset(
    {
        "id",
        "status",
        "date",
        "decided-by",
        "manual-review",
        "enforcement",
        "supersedes",
        "superseded-by",
    }
)
LIST_KEYS = frozenset({"evidence", "enforced-by"})
REQUIRED_KEYS = ("id", "status", "date", "decided-by")

_ID_RE = re.compile(r"^D-[a-z0-9]+(-[a-z0-9]+)*$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_PENDING_RE = re.compile(r"^pending #(\d+)$")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_FIELD_RE = re.compile(r"^([a-z-]+):(?:\s+(.*))?$")
_ITEM_RE = re.compile(r"^\s*-\s+(.*)$")
_ISSUE_RE = re.compile(r"#(\d+)\b")
_TEST_REF_RE = re.compile(r"^(?P<path>[\w./-]+)::(?P<name>\S.*)$")
_DOCS_SYNC_REF_RE = re.compile(r"^docs-sync: (?P<id>[a-z0-9-]+)$")
_MAKE_REF_RE = re.compile(r"^make (?P<target>[a-z0-9-]+)$")


@dataclass(frozen=True)
class Decision:
    id: str
    title: str  # the heading text after its status prefix
    status: Status
    date: str
    decided_by: str
    evidence: tuple[str, ...]
    enforced_by: tuple[str, ...]  # "path::test", "docs-sync: <rule>", "make <target>"
    manual_review: str | None
    pending: int | None  # issue that will build the enforcement ("enforcement: pending #N")
    supersedes: str | None
    superseded_by: str | None
    doc: str  # repo-relative path
    line: int  # 1-based line of the heading
    anchor: str  # GitHub heading slug within `doc`


def slugify(heading: str) -> str:
    """GitHub's heading anchor: rendered text, lowercased, punctuation dropped, spaces to -."""
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", heading)
    text = text.replace("`", "").replace("*", "")
    text = re.sub(r"[^\w\- ]", "", text.strip().lower())
    return text.replace(" ", "-")


def parse_doc(doc: str, text: str) -> tuple[list[Decision], list[str]]:
    """Every decision block in one Markdown file, and the format problems found.

    Fenced code is skipped, so a doc can show the block format as an example."""
    decisions: list[Decision] = []
    problems: list[str] = []
    lines = text.splitlines()
    slug_counts: dict[str, int] = {}
    heading: tuple[str, int, str] | None = None  # text, line, anchor of the last heading
    last_content = 0  # line number of the last non-blank line outside a block
    in_fence = False
    i = 0
    while i < len(lines):
        raw = lines[i]
        stripped = raw.strip()
        lineno = i + 1
        if stripped.startswith(("```", "~~~")):
            in_fence = not in_fence
        if in_fence or stripped.startswith(("```", "~~~")):
            last_content = lineno
            i += 1
            continue
        match = _HEADING_RE.match(raw)
        if match:
            slug = slugify(match.group(2))
            seen = slug_counts.get(slug, 0)
            slug_counts[slug] = seen + 1
            heading = (match.group(2), lineno, slug if seen == 0 else f"{slug}-{seen}")
            last_content = lineno
            i += 1
            continue
        if stripped != "<!-- decision":
            if stripped:
                last_content = lineno
            i += 1
            continue

        where = f"{doc}:{lineno}"
        end = next((j for j in range(i + 1, len(lines)) if lines[j].strip() == "-->"), None)
        if end is None:
            problems.append(f"{where}: decision block has no closing -->")
            break
        fields, field_problems = _parse_fields(lines[i + 1 : end], where)
        problems.extend(field_problems)
        i = end + 1
        if heading is None or heading[1] != last_content:
            problems.append(f"{where}: a decision block must directly follow its heading")
            continue
        decision = _build(fields, heading, doc, where, problems)
        if decision is not None:
            decisions.append(decision)
    return decisions, problems


def _parse_fields(body: list[str], where: str) -> tuple[dict[str, str | list[str]], list[str]]:
    fields: dict[str, str | list[str]] = {}
    problems: list[str] = []
    current_list: list[str] | None = None
    for line in body:
        if not line.strip():
            continue
        if "--" in line:
            problems.append(f"{where}: '--' cannot appear inside an HTML comment")
        item = _ITEM_RE.match(line)
        if item and current_list is not None:
            current_list.append(item.group(1).strip())
            continue
        match = _FIELD_RE.match(line.strip())
        if not match:
            problems.append(f"{where}: cannot read line {line.strip()!r}")
            current_list = None
            continue
        key, value = match.group(1), (match.group(2) or "").strip()
        if key in fields:
            problems.append(f"{where}: duplicate field {key!r}")
        if key in LIST_KEYS:
            if value:
                problems.append(f"{where}: {key} is a list; put each entry on a '- ' line")
            current_list = []
            fields[key] = current_list
        elif key in SCALAR_KEYS:
            current_list = None
            fields[key] = value
        else:
            problems.append(f"{where}: unknown field {key!r}")
            current_list = None
    return fields, problems


def _build(
    fields: dict[str, str | list[str]],
    heading: tuple[str, int, str],
    doc: str,
    where: str,
    problems: list[str],
) -> Decision | None:
    def scalar(key: str) -> str | None:
        value = fields.get(key)
        return value if isinstance(value, str) and value else None

    def items(key: str) -> tuple[str, ...]:
        value = fields.get(key)
        return tuple(value) if isinstance(value, list) else ()

    missing = [key for key in REQUIRED_KEYS if scalar(key) is None]
    if missing:
        problems.append(f"{where}: missing {', '.join(missing)}")
        return None
    decision_id = scalar("id") or ""
    status_text = scalar("status") or ""
    date = scalar("date") or ""
    if not _ID_RE.match(decision_id):
        problems.append(f"{where}: id {decision_id!r} must look like D-kebab-case")
    status = next((s for s in HEADING_PREFIX if s == status_text), None)
    if status is None:
        problems.append(f"{where}: status {status_text!r} must be accepted, proposed or superseded")
        return None
    if not _DATE_RE.match(date):
        problems.append(f"{where}: date {date!r} must be YYYY-MM-DD")
    prefix = HEADING_PREFIX[status]
    text, line, anchor = heading
    if not text.startswith(prefix):
        problems.append(f"{where}: status {status} needs a heading that starts with {prefix!r}")
    pending: int | None = None
    enforcement = scalar("enforcement")
    if enforcement is not None:
        pending_match = _PENDING_RE.match(enforcement)
        if pending_match is None:
            problems.append(f"{where}: enforcement must read 'pending #<issue>'")
        else:
            pending = int(pending_match.group(1))
    return Decision(
        id=decision_id,
        title=text[len(prefix) :] if text.startswith(prefix) else text,
        status=status,
        date=date,
        decided_by=scalar("decided-by") or "",
        evidence=items("evidence"),
        enforced_by=items("enforced-by"),
        manual_review=scalar("manual-review"),
        pending=pending,
        supersedes=scalar("supersedes"),
        superseded_by=scalar("superseded-by"),
        doc=doc,
        line=line,
        anchor=anchor,
    )


@dataclass(frozen=True)
class Repo:
    """What an enforcement entry may point at."""

    root: Path
    docs_sync_rules: frozenset[str]
    make_targets: frozenset[str]

    @classmethod
    def load(cls, root: Path) -> Repo:
        contract = json.loads((root / CONTRACT_PATH).read_text(encoding="utf-8"))
        makefile = (root / "Makefile").read_text(encoding="utf-8")
        return cls(
            root=root,
            docs_sync_rules=frozenset(rule["id"] for rule in contract["rules"]),
            make_targets=frozenset(re.findall(r"^([a-z0-9-]+):", makefile, re.M)),
        )


def _defines_test(source: str, suffix: str, name: str) -> bool:
    """A Python ``def name(`` or a JS/TS test title quoted exactly as ``name``."""
    if suffix == ".py":
        return re.search(rf"^\s*(?:async\s+)?def {re.escape(name)}\(", source, re.M) is not None
    return any(f"{quote}{name}{quote}" in source for quote in "\"'`")


def check_enforcement_ref(ref: str, repo: Repo) -> str | None:
    """Why ``ref`` does not name a real check, or None when it does."""
    test = _TEST_REF_RE.match(ref)
    if test:
        path = repo.root / test.group("path")
        if not path.is_file():
            return f"test file {test.group('path')} does not exist"
        source = path.read_text(encoding="utf-8")
        if not _defines_test(source, path.suffix, test.group("name")):
            return f"{test.group('path')} has no test named {test.group('name')!r}"
        return None
    rule = _DOCS_SYNC_REF_RE.match(ref)
    if rule:
        if rule.group("id") not in repo.docs_sync_rules:
            return f"docs-sync rule {rule.group('id')!r} is not in {CONTRACT_PATH}"
        return None
    target = _MAKE_REF_RE.match(ref)
    if target:
        if target.group("target") not in repo.make_targets:
            return f"make target {target.group('target')!r} is not in the Makefile"
        return None
    return "use 'path::test name', 'docs-sync: <rule-id>' or 'make <target>'"


def validate(decisions: Iterable[Decision], repo: Repo) -> list[str]:
    """Rule problems across all blocks: ids, enforcement, supersession."""
    decisions = list(decisions)
    problems: list[str] = []
    by_id: dict[str, Decision] = {}
    for d in decisions:
        if d.id in by_id:
            first = by_id[d.id]
            problems.append(f"{d.id}: used by {first.doc}:{first.line} and {d.doc}:{d.line}")
        else:
            by_id[d.id] = d

    for d in decisions:
        where = f"{d.id} ({d.doc}:{d.line})"
        if d.status == "accepted" and not (d.enforced_by or d.manual_review or d.pending):
            problems.append(
                f"{where}: an accepted decision needs enforced-by, manual-review "
                "or 'enforcement: pending #<issue>'"
            )
        if d.pending is not None and d.status != "accepted":
            problems.append(f"{where}: only an accepted decision can have pending enforcement")
        for ref in d.enforced_by:
            reason = check_enforcement_ref(ref, repo)
            if reason:
                problems.append(f"{where}: enforced-by {ref!r}: {reason}")

        if (d.status == "superseded") != (d.superseded_by is not None):
            problems.append(f"{where}: status superseded and superseded-by go together")
        if d.superseded_by is not None:
            newer = by_id.get(d.superseded_by)
            if newer is None:
                problems.append(f"{where}: superseded-by {d.superseded_by} does not exist")
            elif newer.supersedes != d.id:
                problems.append(f"{where}: {newer.id} must name it in supersedes")
            elif newer.doc != d.doc:
                problems.append(f"{where}: keep it in {newer.doc}, next to {newer.id}")
        if d.supersedes is not None:
            older = by_id.get(d.supersedes)
            if older is None:
                problems.append(f"{where}: supersedes {d.supersedes}, which does not exist")
            elif older.superseded_by != d.id:
                problems.append(f"{where}: {older.id} must name it in superseded-by")
    return problems


def _enforcement_cell(d: Decision) -> str:
    parts: list[str] = []
    if d.enforced_by:
        parts.append(f"{len(d.enforced_by)} check" + ("s" if len(d.enforced_by) > 1 else ""))
    if d.manual_review:
        parts.append("manual review")
    if d.pending is not None:
        parts.append(f"pending [#{d.pending}]({ISSUE_URL}{d.pending})")
    return ", ".join(parts)


def render_index(decisions: Iterable[Decision]) -> str:
    """The generated table: one row per block, ordered by doc then position."""
    rows = [
        "| ID | Decision | Status | Date | Enforcement | Issues |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    index_dir = posixpath.dirname(INDEX_PATH)
    for d in sorted(decisions, key=lambda d: (d.doc, d.line)):
        href = f"{posixpath.relpath(d.doc, index_dir)}#{d.anchor}"
        issues: list[str] = []
        for number in _ISSUE_RE.findall(" ".join(d.evidence)):
            if number not in issues:
                issues.append(number)
        issue_cell = ", ".join(f"[#{n}]({ISSUE_URL}{n})" for n in issues)
        title = d.title.replace("|", "\\|")
        rows.append(
            f"| `{d.id}` | [{title}]({href}) | {d.status} | {d.date} | "
            f"{_enforcement_cell(d)} | {issue_cell} |"
        )
    return "\n".join(rows)


def apply_index(readme: str, table: str) -> str:
    start = readme.find(BEGIN)
    stop = readme.find(END)
    if start == -1 or stop == -1 or stop < start:
        raise ValueError(f"{INDEX_PATH} needs the {BEGIN} and {END} markers")
    return readme[: start + len(BEGIN)] + "\n" + table + "\n" + readme[stop:]


def collect(root: Path) -> tuple[list[Decision], list[str]]:
    decisions: list[Decision] = []
    problems: list[str] = []
    for path in sorted((root / DOCS_DIR).rglob("*.md")):
        rel = path.relative_to(root).as_posix()
        if rel == INDEX_PATH:
            continue
        found, doc_problems = parse_doc(rel, path.read_text(encoding="utf-8"))
        decisions.extend(found)
        problems.extend(doc_problems)
    return decisions, problems


def _repo_root() -> Path:
    out = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True
    )
    return Path(out.stdout.strip())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--check", action="store_true", help="fail instead of writing")
    args = parser.parse_args(argv)

    root = _repo_root()
    decisions, problems = collect(root)
    problems += validate(decisions, Repo.load(root))
    index = root / INDEX_PATH
    current = index.read_text(encoding="utf-8")
    wanted = apply_index(current, render_index(decisions))
    if args.check and wanted != current:
        problems.append(f"{INDEX_PATH} is stale; run `make decisions-index`")
    elif not args.check and wanted != current:
        index.write_text(wanted, encoding="utf-8")
        print(f"wrote {INDEX_PATH} ({len(decisions)} decisions)")
    for problem in problems:
        print(f"decisions: {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
