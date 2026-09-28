#!/usr/bin/env python3
"""Check a change against the docs-sync map in contracts/docs-sync.json.

Usage:
  python3 scripts/docs_sync.py table [--check]   # AGENTS.md § Docs in sync

Stdlib only, so CI runs it before installing anything. Never reads ``__file__``:
review_packet.py pipes this file into ``python3 -`` from a git object (see
docs_sync_findings in scripts/review_packet.py), so the repo root is found with
``git rev-parse --show-toplevel`` instead.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

CONTRACT_PATH = "contracts/docs-sync.json"
AGENTS_PATH = "AGENTS.md"
BEGIN = "<!-- docs-sync:generated -->"
END = "<!-- /docs-sync:generated -->"
DEFAULT_BASE = "origin/main"

_TABLE_RE = re.compile(re.escape(BEGIN) + r"\n(.*?)\n" + re.escape(END), re.S)
_ID_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_BACKTICK_RE = re.compile(r"`([^`]+)`")
# git log --format=%h%x00%B%x1e: NUL separates the sha from the body, RS separates commits.
_TRAILER_RE = re.compile(r"^Docs-Sync-Waive:[ \t]*(?P<id>[a-z0-9-]+)[ \t]*(?P<reason>.*)$", re.M)
# Pre-contract commits waived ux-pack-sync with a bare subject marker. Parsed so replay
# classifies them; a waiver without a reason is still a problem, so the gate rejects it.
_LEGACY_RE = re.compile(r"\[skip (?P<id>[a-z0-9-]+)\]")
# A backticked prose token may be root-relative or (like the rest of AGENTS.md's SOLID/DRY
# section) shorthand for a path under the package root; try both before giving up.
_PACKAGE_PREFIX = "src/podcast_mcp/"


class ContractError(ValueError):
    """contracts/docs-sync.json or AGENTS.md markers are malformed. Message names the path."""


# ---------------------------------------------------------------- contract (domain types)


@dataclass(frozen=True)
class Glob:
    """Repo-relative POSIX glob. ``**`` spans directories, ``*`` and ``?`` stay in one
    segment, a trailing ``/`` means everything below that directory. Full-match only."""

    text: str
    pattern: re.Pattern[str]

    @classmethod
    def parse(cls, text: str) -> Glob:
        if not text or text.startswith("/") or text.startswith("./") or "\\" in text:
            raise ContractError(
                f"invalid glob {text!r}: must be repo-relative, no leading /, ./ or backslash"
            )
        body = text[:-1] + "**" if text.endswith("/") else text
        out: list[str] = []
        i, n = 0, len(body)
        while i < n:
            if body[i : i + 3] == "**/":
                out.append("(?:.*/)?")
                i += 3
            elif body[i : i + 2] == "**":
                out.append(".*")
                i += 2
            elif body[i] == "*":
                out.append("[^/]*")
                i += 1
            elif body[i] == "?":
                out.append("[^/]")
                i += 1
            else:
                out.append(re.escape(body[i]))
                i += 1
        return cls(text=text, pattern=re.compile("^" + "".join(out) + "$"))

    def matches(self, path: str) -> bool:
        return self.pattern.match(path) is not None


@dataclass(frozen=True)
class Trigger:
    include: tuple[Glob, ...]  # non-empty (parse enforces)
    exclude: tuple[Glob, ...] = ()

    def fired_by(self, paths: Iterable[str]) -> tuple[str, ...]:
        """Paths matching some include and no exclude, in input order."""
        return tuple(
            p
            for p in paths
            if any(g.matches(p) for g in self.include)
            and not any(g.matches(p) for g in self.exclude)
        )


@dataclass(frozen=True)
class Gate:
    """Fails the PR check when fired, unsatisfied and unwaived. A gate always has a trigger."""

    trigger: Trigger


@dataclass(frozen=True)
class Advisory:
    """Reports only. ``trigger=None`` is a row with no code trigger: rendered in the table,
    never evaluated. Promote to Gate by renaming the JSON key once replay shows it is precise."""

    trigger: Trigger | None


@dataclass(frozen=True)
class Rule:
    id: str  # kebab-case, unique; the waiver key
    when: str  # "When you change…" cell, trimmed; content otherwise verbatim
    update: str  # "Update…" cell, trimmed; content otherwise verbatim
    docs: tuple[Glob, ...]  # paths that satisfy the rule; any one changing is enough
    enforcement: Gate | Advisory


@dataclass(frozen=True)
class Contract:
    ignore: tuple[Glob, ...]  # never trigger any rule (tests, stories, lockfiles)
    rules: tuple[Rule, ...]  # AGENTS.md table order


def _parse_trigger(value: object, rule_id: str, field_name: str) -> Trigger:
    if not isinstance(value, dict):
        raise ContractError(f"rule {rule_id!r}: {field_name} must be an object")
    include_raw = value.get("include")
    if not isinstance(include_raw, list) or not include_raw:
        raise ContractError(f"rule {rule_id!r}: {field_name} needs a non-empty include list")
    include = tuple(Glob.parse(g) for g in include_raw)
    exclude = tuple(Glob.parse(g) for g in value.get("exclude", []))
    extra = set(value) - {"include", "exclude"}
    if extra:
        raise ContractError(f"rule {rule_id!r}: {field_name} has unknown field(s) {sorted(extra)}")
    return Trigger(include=include, exclude=exclude)


def parse_contract(raw: object) -> Contract:
    """The only validation of the contract's shape (there is no separate JSON Schema
    validator at runtime; schemas/docs-sync.schema.json documents the same shape for editors).

    Rejects, naming the JSON path: api_version != 1; a non-list rules; duplicate or
    non-kebab ids; a rule with both or neither of gate/advisory; an empty include; empty
    when/update; any malformed glob; unknown fields.
    """
    if not isinstance(raw, dict):
        raise ContractError("contract root must be an object")
    if raw.get("api_version") != 1:
        raise ContractError(f"contract api_version must be 1, got {raw.get('api_version')!r}")
    ignore = tuple(Glob.parse(g) for g in raw.get("ignore", []))
    rules_raw = raw.get("rules")
    if not isinstance(rules_raw, list):
        raise ContractError("contract.rules must be a list")

    seen_ids: set[str] = set()
    rules: list[Rule] = []
    for i, rr in enumerate(rules_raw):
        if not isinstance(rr, dict):
            raise ContractError(f"rules[{i}]: must be an object")
        rule_id = rr.get("id")
        if not isinstance(rule_id, str) or not _ID_RE.match(rule_id):
            raise ContractError(f"rules[{i}]: id must be kebab-case, got {rule_id!r}")
        if rule_id in seen_ids:
            raise ContractError(f"rules[{i}] ({rule_id}): duplicate id")
        seen_ids.add(rule_id)

        when = rr.get("when")
        update = rr.get("update")
        if not isinstance(when, str) or not when.strip():
            raise ContractError(f"rules[{i}] ({rule_id}): when must be a non-empty string")
        if not isinstance(update, str) or not update.strip():
            raise ContractError(f"rules[{i}] ({rule_id}): update must be a non-empty string")

        docs_raw = rr.get("docs", [])
        if not isinstance(docs_raw, list):
            raise ContractError(f"rules[{i}] ({rule_id}): docs must be a list")
        docs = tuple(Glob.parse(g) for g in docs_raw)

        has_gate = "gate" in rr
        has_advisory = "advisory" in rr
        if has_gate == has_advisory:
            raise ContractError(f"rules[{i}] ({rule_id}): exactly one of gate/advisory is required")
        enforcement: Gate | Advisory
        if has_gate:
            enforcement = Gate(trigger=_parse_trigger(rr["gate"], rule_id, "gate"))
        else:
            advisory_raw = rr["advisory"]
            enforcement = Advisory(
                trigger=None
                if advisory_raw is None
                else _parse_trigger(advisory_raw, rule_id, "advisory")
            )

        extra = set(rr) - {"id", "when", "update", "docs", "gate", "advisory"}
        if extra:
            raise ContractError(f"rules[{i}] ({rule_id}): unknown field(s) {sorted(extra)}")

        rules.append(Rule(id=rule_id, when=when, update=update, docs=docs, enforcement=enforcement))
    return Contract(ignore=ignore, rules=tuple(rules))


def _resolve_prose_path(token: str, tracked: frozenset[str]) -> str | None:
    """The tracked-repo-relative path (or directory glob) ``token`` names, or None when it
    is not path-like (a code symbol, env var, make target, or bare skill name never resolve).

    Tries ``token`` as a root-relative path first, then as shorthand for a path under
    ``src/podcast_mcp/`` (the convention this file's own SOLID/DRY section uses)."""
    candidates = [token]
    if not token.startswith(_PACKAGE_PREFIX):
        candidates.append(_PACKAGE_PREFIX + token)
    for candidate in candidates:
        if candidate.endswith("/"):
            if any(t.startswith(candidate) for t in tracked):
                return candidate
        else:
            if candidate in tracked:
                return candidate
            if any(t == candidate or t.startswith(candidate + "/") for t in tracked):
                return candidate + "/"
    return None


def lint_contract(contract: Contract, tracked: Iterable[str]) -> list[str]:
    """Repo-state problems, empty when clean.

    - every include/exclude/docs/ignore glob must match at least one tracked file, so a
      renamed doc or dead trigger fails CI instead of going quiet;
    - every backticked token in a rule's ``update`` that resolves to a tracked path must be
      matched by one of that rule's ``docs`` globs, so the prose and the machine list can't
      silently disagree. Non-resolving tokens (code symbols, env vars, make targets, the
      handful of runtime-relative paths named in AGENTS.md) are not path-like and are
      skipped, not required;
    - a backticked token under a tracked top-level or package directory must resolve, so
      a row keeps no reference to a deleted or renamed file.
    """
    tracked_set = frozenset(tracked)
    problems: list[str] = []

    all_globs: list[Glob] = list(contract.ignore)
    for rule in contract.rules:
        all_globs.extend(rule.docs)
        if rule.enforcement.trigger is not None:
            all_globs.extend(rule.enforcement.trigger.include)
            all_globs.extend(rule.enforcement.trigger.exclude)
    seen: set[str] = set()
    for glob in all_globs:
        if glob.text in seen:
            continue
        seen.add(glob.text)
        if not any(glob.matches(t) for t in tracked_set):
            problems.append(f"docs-sync glob {glob.text!r} matches no tracked file")

    # A token under a real top-level or package directory that no longer resolves is a
    # dead reference (a renamed or deleted file), not a symbol.
    roots = {t.split("/")[0] for t in tracked_set if "/" in t} | {
        t[len(_PACKAGE_PREFIX) :].split("/")[0]
        for t in tracked_set
        if t.startswith(_PACKAGE_PREFIX) and "/" in t[len(_PACKAGE_PREFIX) :]
    }
    for rule in contract.rules:
        for token in _BACKTICK_RE.findall(rule.update):
            canonical = _resolve_prose_path(token, tracked_set)
            if canonical is None:
                if "/" in token and token.split("/")[0] in roots:
                    problems.append(f"{rule.id}: update references `{token}`, which is not tracked")
                continue
            if not any(glob.matches(canonical) for glob in rule.docs):
                problems.append(
                    f"{rule.id}: update references `{token}` but no docs glob matches it"
                )
    return problems


# ---------------------------------------------------------------- change + evaluation


@dataclass(frozen=True)
class Waiver:
    rule_id: str
    reason: str | None  # None only for the legacy "[skip <id>]" marker or an empty trailer
    commit: str  # abbreviated sha


@dataclass(frozen=True)
class Change:
    """What one PR (or branch-so-far, or replay unit) changed, and the waivers it carries."""

    label: str  # "origin/main...HEAD", "index", "#744"
    files: tuple[str, ...]  # --no-renames: a rename contributes both paths
    waivers: tuple[Waiver, ...] = ()


Outcome = Literal["violated", "waived", "advisory", "satisfied"]
_OUTCOME_RANK: dict[Outcome, int] = {"violated": 0, "waived": 1, "advisory": 2, "satisfied": 3}


@dataclass(frozen=True)
class Finding:
    rule: Rule
    outcome: Outcome
    triggered_by: tuple[str, ...]
    satisfied_by: tuple[str, ...] = ()
    waivers: tuple[Waiver, ...] = ()


@dataclass(frozen=True)
class Report:
    change: Change
    findings: tuple[Finding, ...]  # fired rules only, ordered by outcome then contract order
    problems: tuple[str, ...]  # waiver hygiene: unknown rule id, waiver without a reason

    @property
    def blocking(self) -> bool:
        return any(f.outcome == "violated" for f in self.findings) or bool(self.problems)


def evaluate(contract: Contract, change: Change) -> Report:
    """Pure. The one function behind the gate, the hook, `make docs-sync`, replay and the
    review packet."""
    live = tuple(p for p in change.files if not any(g.matches(p) for g in contract.ignore))
    findings: list[Finding] = []
    problems: list[str] = []

    for rule in contract.rules:
        trigger = rule.enforcement.trigger
        if trigger is None:
            continue
        fired = trigger.fired_by(live)
        if not fired:
            continue
        fired_set = set(fired)
        # A file that fired the rule cannot also satisfy it: editing docs/session-sync.md
        # must not count as "updated docs" for a rule it triggered.
        satisfied_by = tuple(
            p for p in change.files if p not in fired_set and any(g.matches(p) for g in rule.docs)
        )
        waivers = tuple(w for w in change.waivers if w.rule_id == rule.id)
        is_gate = isinstance(rule.enforcement, Gate)

        outcome: Outcome
        if satisfied_by:
            outcome = "satisfied"
        elif waivers:
            outcome = "waived"
        elif is_gate:
            outcome = "violated"
        else:
            outcome = "advisory"

        findings.append(
            Finding(
                rule=rule,
                outcome=outcome,
                triggered_by=fired,
                satisfied_by=satisfied_by,
                waivers=waivers,
            )
        )
        if outcome == "waived":
            for waiver in waivers:
                if waiver.reason is None:
                    problems.append(
                        f"{rule.id}: waived without a reason in {waiver.commit} "
                        f"([skip {rule.id}]); write `Docs-Sync-Waive: {rule.id} <reason>`"
                    )

    known_ids = {r.id for r in contract.rules}
    for waiver in change.waivers:
        if waiver.rule_id not in known_ids:
            problems.append(
                f"{waiver.commit}: Docs-Sync-Waive names unknown rule {waiver.rule_id!r}"
            )

    findings.sort(key=lambda f: (_OUTCOME_RANK[f.outcome], contract.rules.index(f.rule)))
    return Report(change=change, findings=tuple(findings), problems=tuple(problems))


def parse_waivers(log: str) -> tuple[Waiver, ...]:
    """``log`` is ``git log --format=%h%x00%B%x1e``. Trailer lines anywhere in a message
    count (agents do not always put trailers in the last paragraph); an empty reason is
    stored as None, same as the legacy ``[skip <id>]`` marker."""
    waivers: list[Waiver] = []
    for record in log.split("\x1e"):
        record = record.strip("\n")
        if not record:
            continue
        sha, _, body = record.partition("\x00")
        sha = sha.strip()
        if not sha:
            continue
        for match in _TRAILER_RE.finditer(body):
            reason = match.group("reason").strip()
            waivers.append(Waiver(rule_id=match.group("id"), reason=reason or None, commit=sha))
        for match in _LEGACY_RE.finditer(body):
            waivers.append(Waiver(rule_id=match.group("id"), reason=None, commit=sha))
    return tuple(waivers)


# ---------------------------------------------------------------- git shell (thin)


def git(*args: str, stdin: str | None = None) -> str:
    return subprocess.run(
        ["git", *args], input=stdin, check=True, capture_output=True, text=True
    ).stdout


def _repo_root() -> Path:
    return Path(git("rev-parse", "--show-toplevel").strip())


def tracked_files() -> tuple[str, ...]:
    return tuple(line for line in git("ls-files").splitlines() if line)


def read_repo_file(path: str, rev: str | None) -> str:
    """``rev=None``: working tree at ``git rev-parse --show-toplevel``. ``rev=":"``: the
    index. Otherwise ``git show <rev>:<path>``."""
    if rev is None:
        return (_repo_root() / path).read_text(encoding="utf-8")
    if rev == ":":
        return git("show", f":{path}")
    return git("show", f"{rev}:{path}")


def load_contract(rev: str | None) -> Contract:
    return parse_contract(json.loads(read_repo_file(CONTRACT_PATH, rev)))


# ---------------------------------------------------------------- output


def render_table(contract: Contract) -> str:
    """A compact ``| When you change… | Update… |`` table, one row per rule in contract
    order. Cells are ``Rule.when`` / ``Rule.update`` exactly as stored (already trimmed)."""
    lines = ["| When you change… | Update… |", "| --- | --- |"]
    lines.extend(f"| {rule.when} | {rule.update} |" for rule in contract.rules)
    return "\n".join(lines)


def splice_table(agents_md: str, table: str) -> str:
    """Replace the text between BEGIN and END. ContractError when a marker is missing."""
    if BEGIN not in agents_md or END not in agents_md:
        raise ContractError(f"{AGENTS_PATH} is missing the {BEGIN} / {END} markers")
    replacement = f"{BEGIN}\n{table}\n{END}"
    new_text, count = _TABLE_RE.subn(lambda _match: replacement, agents_md, count=1)
    if count == 0:
        raise ContractError(f"{AGENTS_PATH} markers are present but not well-formed")
    return new_text


def _current_table_region(agents_md: str) -> str:
    match = _TABLE_RE.search(agents_md)
    if not match:
        raise ContractError(f"{AGENTS_PATH} is missing the {BEGIN} / {END} markers")
    return match.group(1)


# ---------------------------------------------------------------- CLI


def _cmd_table(args: argparse.Namespace) -> int:
    contract = load_contract(None)
    table = render_table(contract)
    agents_md = read_repo_file(AGENTS_PATH, None)

    if args.check:
        problems = lint_contract(contract, tracked_files())
        if _current_table_region(agents_md) != table:
            problems.append(f"{AGENTS_PATH} docs-sync table is stale; run `make docs-sync-table`")
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1 if problems else 0

    (_repo_root() / AGENTS_PATH).write_text(splice_table(agents_md, table), encoding="utf-8")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    table_parser = sub.add_parser("table", help="regenerate (or --check) the AGENTS.md table")
    table_parser.add_argument("--check", action="store_true")

    args = parser.parse_args(argv)
    try:
        if args.cmd == "table":
            return _cmd_table(args)
        raise ContractError(
            f"unknown command {args.cmd!r}"
        )  # pragma: no cover - argparse guards this
    except ContractError as exc:
        print(f"docs-sync: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"docs-sync: {' '.join(exc.cmd)} failed: {exc.stderr.strip()}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
