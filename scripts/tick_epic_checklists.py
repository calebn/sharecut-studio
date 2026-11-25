"""Tick the `- [ ]` lines of open `epic` issues whose referenced issues and PRs are done.

Usage:
  python3 scripts/tick_epic_checklists.py [--dry-run]

Needs `REPO` and `GH_TOKEN` (the `gh` CLI). `PR_NUMBER` makes the run wait for the issues that PR
closes first; `DRY_RUN=true` is `--dry-run`. Every run sweeps all open epics against live state.
See docs/contributing.md.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any, Literal, NamedTuple, Protocol

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import close_issues_on_develop as closer

RefState = Literal["done", "dead", "open"]

WAIT_ATTEMPTS = 8
WAIT_SECONDS = 15
WRITE_ATTEMPTS = 3
_UNCHECKED = re.compile(r"^( {0,3}[-*+] \[) (\][ \t])")
_LEAD = r"#\d+(?:(?:,\s*|,?\s+and\s+)#\d+)*\b"
_OWNED = re.compile(rf"(?:[^#():\n]{{1,80}}:\s+)?{_LEAD}")
_HOLD = re.compile(
    r"(?<![\w-])(?:leftovers?|follow[- ]?ups?|still[ \t]+open|remain(?:s|ing)?|superseded|blocked"
    r"|except|but[ \t]+not|not[ \t]+yet|deferred|half|todo|only|later|until|unfinished|unless)"
    r"(?![\w-])",
    re.IGNORECASE,
)
_FOREIGN_REF = re.compile(r"\bGH-\d|(?<![\w./-])[\w.-]+#\d", re.IGNORECASE)
_FENCE = re.compile(r"^( *)(`{3,}|~{3,})(.*)$")


class Tick(NamedTuple):
    line_no: int
    refs: tuple[int, ...]


def ref_state(issue: Mapping[str, Any] | None) -> RefState:
    if issue is None or issue["state"] != "closed":
        return "open"
    pull = issue.get("pull_request")
    completed = pull["merged_at"] if pull else issue.get("state_reason") == "completed"
    return "done" if completed else "dead"


def line_refs(line: str, repo: str) -> tuple[int, ...] | None:
    text = closer._without_code_spans(line)
    box = _UNCHECKED.match(text)
    if not box or not _OWNED.match(text, box.end()):
        return None
    if closer._PARTIAL.search(text) or _HOLD.search(text) or _FOREIGN_REF.search(text):
        return None
    mentions = closer._mentions(text)
    if not all(closer._same_repo(owner, repo) for owner, _ in mentions):
        return None
    return tuple(sorted({number for _, number in mentions}))


def _candidates(lines: Sequence[str], repo: str) -> Iterator[tuple[int, tuple[int, ...]]]:
    """Index and refs of each tickable line outside fences and HTML comments."""
    fence: tuple[str, int, int] | None = None
    in_comment = False
    for index, raw in enumerate(lines):
        line = raw.rstrip("\r")
        if fence:
            char, size, indent = fence
            end = re.fullmatch(
                rf" {{{indent},{indent + 3}}}{re.escape(char)}{{{size},}}[ \t]*", line
            )
            fence = None if end else fence
            continue
        opener = _FENCE.match(line)
        if opener and not (opener[2][0] == "`" and "`" in opener[3]):
            fence = (opener[2][0], len(opener[2]), len(opener[1]))
            continue
        scan = line if in_comment else closer._without_code_spans(line)
        if in_comment or "<!--" in scan or "-->" in scan:
            in_comment = scan.rfind("<!--") > scan.rfind("-->") or (
                in_comment and "-->" not in scan
            )
            continue
        if refs := line_refs(line, repo):
            yield index, refs


def tick_body(body: str, states: Mapping[int, RefState], repo: str) -> tuple[str, list[Tick]]:
    lines = body.split("\n")
    ticks = []
    for index, refs in _candidates(lines, repo):
        if all(states.get(number, "open") == "done" for number in refs):
            lines[index] = _UNCHECKED.sub(r"\1x\2", lines[index], count=1)
            ticks.append(Tick(index + 1, refs))
    return "\n".join(lines), ticks


def pending_refs(body: str, repo: str) -> set[int]:
    return {number for _, refs in _candidates(body.split("\n"), repo) for number in refs}


class Client(Protocol):
    def open_epics(self) -> list[Mapping[str, Any]]: ...

    def issue(self, number: int) -> Mapping[str, Any] | None: ...

    def pull(self, number: int) -> Mapping[str, Any]: ...

    def patch_body(self, number: int, body: str) -> None: ...


class GhClient(closer.GhClient):
    def open_epics(self) -> list[Mapping[str, Any]]:
        pages = self._api(
            "--paginate", "--slurp", f"repos/{self.repo}/issues?labels=epic&state=open&per_page=100"
        )
        return [issue for page in pages or [] for issue in page if "pull_request" not in issue]

    def patch_body(self, number: int, body: str) -> None:
        try:
            self._api("-X", "PATCH", f"repos/{self.repo}/issues/{number}", "-f", f"body={body}")
        except RuntimeError as exc:
            raise RuntimeError(str(exc).replace(f"body={body}", "body=<omitted>")) from None


def await_closers(
    client: Client, pr_number: int, repo: str, sleep: Callable[[float], None]
) -> None:
    """The closer closes with GITHUB_TOKEN, so give it a bounded head start over this run."""
    waiting = closer.closing_refs(client.pull(pr_number).get("body"), repo)
    for _ in range(WAIT_ATTEMPTS):
        waiting = {n for n in waiting if ref_state(client.issue(n)) == "open"}
        if not waiting:
            return
        sleep(WAIT_SECONDS)


def sweep_epic(
    client: Client, epic: int, body: str, states: dict[int, RefState], *, repo: str, dry_run: bool
) -> None:
    for _ in range(WRITE_ATTEMPTS):
        for number in pending_refs(body, repo) - states.keys():
            states[number] = ref_state(client.issue(number))
        new_body, ticks = tick_body(body, states, repo)
        if not ticks:
            return
        for line_no, _ in ticks:
            line = body.split("\n")[line_no - 1].rstrip("\r")
            print(f"{'would tick' if dry_run else 'ticked'} #{epic} line {line_no}: {line}")
        if dry_run:
            return
        current = (client.issue(epic) or {}).get("body") or ""
        if current == body:
            client.patch_body(epic, new_body)
            return
        body = current
    raise RuntimeError(f"body kept changing after {WRITE_ATTEMPTS} tries")


def run(
    client: Client,
    *,
    repo: str,
    pr_number: int | None,
    dry_run: bool,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """1 when any epic or the closer wait failed, else 0. Every run sweeps all open epics."""
    failures = 0
    if pr_number is not None:
        try:
            await_closers(client, pr_number, repo, sleep)
        except RuntimeError as exc:
            failures += 1
            print(f"::error::could not wait for PR #{pr_number}: {exc}")
    states: dict[int, RefState] = {}
    for epic in client.open_epics():
        try:
            sweep_epic(
                client, epic["number"], epic.get("body") or "", states, repo=repo, dry_run=dry_run
            )
        except Exception as exc:
            failures += 1
            print(f"::error::could not tick #{epic['number']}: {' '.join(str(exc).split())[:200]}")
    return 1 if failures else 0


def main(argv: Sequence[str] | None = None, *, client: Client | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    repo = os.environ["REPO"]
    pr_number = int(os.environ["PR_NUMBER"]) if os.environ.get("PR_NUMBER") else None
    dry_run = args.dry_run or os.environ.get("DRY_RUN", "").lower() == "true"
    return run(client or GhClient(repo), repo=repo, pr_number=pr_number, dry_run=dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
