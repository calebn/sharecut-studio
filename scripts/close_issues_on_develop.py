"""Close the issues a PR merged to the base branch references with a closing keyword.

Usage:
  python3 scripts/close_issues_on_develop.py [--dry-run]

Needs `REPO`, `PR_NUMBER` and `GH_TOKEN` (the `gh` CLI); `DRY_RUN=true` is `--dry-run`. Only the
PR body counts, as read now, not as it was at the merge. See docs/contributing.md.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import branches

GH_TIMEOUT_SECONDS = 60
OPT_OUT_LABELS = frozenset({"needs-user-input", "owner-check"})
_BULLET = r"(?:[-*+]|\d{1,9}[.)])[ \t]+"
_CLOSING = re.compile(
    rf"^[ \t]*(?:{_BULLET})?(?P<bold>\*\*)?(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+"
    r"(?:(?P<repo>[\w.-]{1,100}/[\w.-]{1,100}))?#(?P<num>\d{1,9})\b(?P<rest>.*)$",
    re.IGNORECASE | re.ASCII,
)
_CLOSING_TAIL = re.compile(r"[\s.,;:!)_]*")
_CLOSING_TAIL_BOLD = re.compile(r"[\s.,;:!)_]*\*\*[\s.,;:!)_]*")
_LABEL = re.compile(r"[ \t]*\((?P<text>[^()\n]{1,40})\)")
_LABEL_STOP = re.compile(
    r"\b(?:partial(?:ly)?|partly|part|items?|not|only|except|but|until|after|once|if|when|still"
    r"|some|half)\b",
    re.IGNORECASE | re.ASCII,
)
_HEADING_LINE = re.compile(r"^ {0,3}#{1,6}[ \t]+\S")
_BULLET_LINE = re.compile(rf"^[ \t]*{_BULLET}")
_PARTIAL = re.compile(
    r"\b(?:part(?:[ \t-]+\d+)?[ \t-]+of|step[ \t-]+\d+[ \t-]+of|partial(?:ly)?|partly|towards?"
    r"|relates?[ \t]+to|related[ \t]+to|refs?|references?)\b",
    re.IGNORECASE | re.ASCII,
)
_ISSUE_REFS = (
    re.compile(
        r"(?<![\w/])(?:(?<![.-])(?P<repo>[\w.-]{1,100}/[\w.-]{1,100}))?#(?P<num>\d{1,9})\b",
        re.ASCII,
    ),
    re.compile(r"\bGH-(?P<num>\d{1,9})\b", re.IGNORECASE | re.ASCII),
    re.compile(
        r"https?://github\.com/(?P<repo>[\w.-]{1,100}/[\w.-]{1,100})/(?:issues|pull)/(?P<num>\d{1,9})\b",
        re.IGNORECASE | re.ASCII,
    ),
)
_FENCE_LINE = re.compile(r"^ {0,3}(?:`{3,}|~{3,})")
_FENCE_OPEN = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_BACKTICK_RUN = re.compile(r"`+")


def marker(pr: int) -> str:
    return f"<!-- close-on-develop pr={pr} -->"


def _visible_lines(body: str, *, fences: bool) -> str:
    """Lines of `body` outside blockquote paragraphs and, if `fences`, fenced code blocks."""
    kept: list[str] = []
    fence: tuple[str, int] | None = None
    quoted = False
    for line in body.replace("\r\n", "\n").split("\n"):
        if fence:
            closer = re.fullmatch(rf" {{0,3}}({re.escape(fence[0])}{{{fence[1]},}})[ \t]*", line)
            if closer:
                fence = None
                kept.append("")
            continue
        opener = _FENCE_OPEN.match(line) if fences else None
        if opener and not (opener[1][0] == "`" and "`" in opener[2]):
            fence = (opener[1][0], len(opener[1]))
            quoted = False
            kept.append("")
            continue
        if not line.strip():
            quoted = False
        elif line.lstrip(" ").startswith(">") and len(line) - len(line.lstrip(" ")) < 4:
            if not quoted:
                kept.append("")
            quoted = True
            continue
        elif quoted:
            continue
        kept.append(line)
    return "\n".join(kept)


def _without_code_spans(paragraph: str) -> str:
    """Drop inline code spans: a run of N backticks closes at the next run of exactly N."""
    runs = list(_BACKTICK_RUN.finditer(paragraph))
    out, pos, i = [], 0, 0
    while i < len(runs):
        opener = runs[i]
        closing = next(
            (j for j in range(i + 1, len(runs)) if len(runs[j].group()) == len(opener.group())),
            None,
        )
        if closing is None:
            i += 1
            continue
        out.append(paragraph[pos : opener.start()])
        pos = runs[closing].end()
        i = closing + 1
    out.append(paragraph[pos:])
    return " ".join(out)


def _mentions(line: str) -> list[tuple[str | None, int]]:
    return [
        (match.groupdict().get("repo"), int(match["num"]))
        for pattern in _ISSUE_REFS
        for match in pattern.finditer(line)
    ]


def _is_indented_code(line: str) -> bool:
    lead = line[: len(line) - len(line.lstrip(" \t"))]
    return "\t" in lead or len(lead) >= 4


def _closes_cleanly(match: re.Match[str]) -> bool:
    bold = bool(match["bold"])
    tail = _CLOSING_TAIL_BOLD if bold else _CLOSING_TAIL
    rest = match["rest"]
    if tail.fullmatch(rest):
        return True
    label = _LABEL.match(rest)
    if not label or _LABEL_STOP.search(label["text"]):
        return False
    after = rest[label.end() :]
    return bool(tail.fullmatch(after)) or (not bold and after[:1] in {".", ";", ":", "!"})


def _scan_block(lines: Sequence[str], repo: str, found: set[int], partial: set[int]) -> None:
    kinds: list[str] = []
    numbers: list[int | None] = []
    for line in lines:
        mentions = _mentions(line)
        has_phrase = bool(_PARTIAL.search(line))
        if has_phrase:
            partial.update(num for owner, num in mentions if _same_repo(owner, repo))
        number = None
        indented = _is_indented_code(line)
        match = None if indented else _CLOSING.match(line)
        if match:
            kind = "chain"
            if _closes_cleanly(match) and _same_repo(match["repo"], repo):
                number = int(match["num"])
        elif not indented and (_BULLET_LINE.match(line) or (has_phrase and mentions)):
            kind = "chain"
        else:
            kind = "prose"
        kinds.append(kind)
        numbers.append(number)
    for i, number in enumerate(numbers):
        before_ok = i == 0 or kinds[i - 1] == "chain"
        after_ok = i == len(kinds) - 1 or kinds[i + 1] == "chain"
        if number is not None and before_ok and after_ok:
            found.add(number)


def _refs(body: str, repo: str, *, fences: bool) -> set[int]:
    text = re.sub(r"<!--.*?(?:-->|\Z)", " ", _visible_lines(body, fences=fences), flags=re.S)
    found: set[int] = set()
    partial: set[int] = set()
    for paragraph in re.split(r"\n[ \t]*\n", text):
        segment: list[str] = []
        for line in _without_code_spans(paragraph).split("\n"):
            if not line.strip() or _FENCE_LINE.match(line) or _HEADING_LINE.match(line):
                _scan_block(segment, repo, found, partial)
                segment = []
            else:
                segment.append(line)
        _scan_block(segment, repo, found, partial)
    return found - partial


def _same_repo(owner_repo: str | None, repo: str) -> bool:
    return owner_repo is None or owner_repo.lower() == repo.lower()


def closing_refs(body: str | None, repo: str) -> set[int]:
    """Issues in `repo` that `body` closes outside code, comments and quotes.

    A keyword counts only on a line that starts a paragraph or follows a blank line, another
    keyword line or a list bullet, directly before `#N`, with nothing but punctuation after the
    number (or one short parenthetical label without partial words such as "not" or "items", then
    punctuation or, after a sentence stop, free prose), and only when the next line in the paragraph is again a keyword line or a bullet.
    A markdown heading line ends a block like a blank line. An issue the body also names with "Part of", "Refs", "Related to" and the like stays open.

    Fences and inline code interact (a ``` line can open a fence or close a span), so the body is
    read both ways and only issues both readings close count: when in doubt, do not close.
    """
    return _refs(body or "", repo, fences=True) & _refs(body or "", repo, fences=False)


@dataclass
class Plan:
    close: list[int] = field(default_factory=list)
    skipped: list[tuple[int, str]] = field(default_factory=list)
    failed: list[tuple[int, str]] = field(default_factory=list)


class Client(Protocol):
    def pull(self, number: int) -> Mapping[str, Any]: ...

    def issue(self, number: int) -> Mapping[str, Any] | None: ...

    def comment_bodies(self, number: int) -> list[str]: ...

    def comment(self, number: int, body: str) -> None: ...

    def close(self, number: int) -> None: ...


def plan(client: Client, pr: Mapping[str, Any], repo: str) -> Plan:
    result = Plan()
    for number in sorted(closing_refs(pr.get("body"), repo)):
        try:
            issue = client.issue(number)
        except RuntimeError as exc:
            result.failed.append((number, str(exc)))
            continue
        if issue is None:
            result.skipped.append((number, "not found"))
        elif "pull_request" in issue:
            result.skipped.append((number, "is a pull request"))
        elif issue["state"] != "open":
            result.skipped.append((number, "already closed"))
        elif OPT_OUT_LABELS & {label["name"] for label in issue.get("labels", [])}:
            result.skipped.append((number, "opt-out label"))
        else:
            result.close.append(number)
    return result


def comment_body(pr: Mapping[str, Any]) -> str:
    sha = pr.get("merge_commit_sha")
    commit = f" in {sha}" if sha else ""
    return f"Closed by #{pr['number']}{commit}, merged to `{pr['base']['ref']}`.\n\n{marker(pr['number'])}"


def apply(client: Client, pr: Mapping[str, Any], result: Plan, *, dry_run: bool) -> int:
    """Comment (unless this PR's marker is there), then close. Returns the number of failures."""
    failures = 0
    for number in result.close:
        print(f"{'would close' if dry_run else 'closing'} #{number} (PR #{pr['number']})")
        if dry_run:
            continue
        try:
            if not any(marker(pr["number"]) in body for body in client.comment_bodies(number)):
                client.comment(number, comment_body(pr))
            client.close(number)
        except Exception as exc:
            failures += 1
            print(f"::error::could not close #{number} for PR #{pr['number']}: {exc}")
    return failures


Runner = Callable[..., "subprocess.CompletedProcess[str]"]


class GhClient:
    def __init__(self, repo: str, run: Runner = subprocess.run) -> None:
        self.repo = repo
        self._run = run

    def _api(self, *args: str) -> Any:
        try:
            proc = self._run(
                ["gh", "api", *args],
                capture_output=True,
                text=True,
                check=False,
                timeout=GH_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"gh api {args[-1]} timed out after {exc.timeout}s") from exc
        if proc.returncode != 0:
            raise RuntimeError(f"gh api {args[-1]} failed: {proc.stderr.strip()}")
        return json.loads(proc.stdout) if proc.stdout.strip() else None

    def pull(self, number: int) -> Mapping[str, Any]:
        return self._api(f"repos/{self.repo}/pulls/{number}")

    def issue(self, number: int) -> Mapping[str, Any] | None:
        try:
            return self._api(f"repos/{self.repo}/issues/{number}")
        except RuntimeError as exc:
            if "HTTP 404" in str(exc):
                return None
            raise

    def comment_bodies(self, number: int) -> list[str]:
        data = self._api(
            "--paginate", "--slurp", f"repos/{self.repo}/issues/{number}/comments?per_page=100"
        )
        return [c["body"] or "" for page in data or [] for c in page]

    def comment(self, number: int, body: str) -> None:
        self._api("-X", "POST", f"repos/{self.repo}/issues/{number}/comments", "-f", f"body={body}")

    def close(self, number: int) -> None:
        self._api(
            "-X",
            "PATCH",
            f"repos/{self.repo}/issues/{number}",
            "-f",
            "state=closed",
            "-f",
            "state_reason=completed",
        )


def run(client: Client, *, repo: str, pr_number: int, base: str, dry_run: bool) -> int:
    """1 when any issue could not be read or closed, else 0. A PR not merged to `base` is a no-op."""
    try:
        pr = client.pull(pr_number)
    except RuntimeError as exc:
        print(f"::error::could not read PR #{pr_number}: {exc}")
        return 1
    if not pr.get("merged_at") or pr["base"]["ref"] != base:
        print(f"PR #{pr_number} is not merged into {base}; nothing to do")
        return 0
    result = plan(client, pr, repo)
    for number, reason in result.skipped:
        print(f"skip #{number}: {reason}")
    for number, error in result.failed:
        print(f"::error::could not read #{number}: {error}")
    failures = apply(client, pr, result, dry_run=dry_run)
    return 1 if failures or result.failed else 0


def main(argv: Sequence[str] | None = None, *, client: Client | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    repo, pr_number = os.environ["REPO"], int(os.environ["PR_NUMBER"])
    dry_run = args.dry_run or os.environ.get("DRY_RUN", "").lower() == "true"
    return run(
        client or GhClient(repo),
        repo=repo,
        pr_number=pr_number,
        base=branches.base(),
        dry_run=dry_run,
    )


if __name__ == "__main__":
    raise SystemExit(main())
