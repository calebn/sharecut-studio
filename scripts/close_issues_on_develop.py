#!/usr/bin/env python3
"""Close the issues that PRs merged to the base branch reference with a closing keyword.

Usage:
  python3 scripts/close_issues_on_develop.py [--dry-run]

Reads `REPO` (owner/name), `BEFORE` and `AFTER` (the pushed range) from the environment and
calls the GitHub API through the `gh` CLI (`GH_TOKEN`). `--dry-run` (or `DRY_RUN=true`) prints
what would happen and writes nothing.

GitHub closes an issue from `Fixes #N` only when the PR merges into the default branch, and
lanes merge into `develop`. This applies the same rule one hop earlier. Only the PR title and
body count (not commit messages), only `close(s/d)`, `fix(es/ed)` and `resolve(s/d)` count (not
`Part of` or `Refs`), only this repository counts, and PR text only reaches the API as data.

Data shape: `Candidate(issue, pr)` is one closing reference; `Plan` holds the candidates to act
on (`close`) and, per skipped candidate, the reason (`skipped`). `plan()` is pure over a `Client`.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import branches

MAX_COMMITS = 250
ZERO_SHA = "0" * 40
OPT_OUT_LABELS = frozenset({"needs-user-input", "owner-check"})
_CLOSING = re.compile(
    r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+(?:([\w.-]+/[\w.-]+))?#(\d+)\b",
    re.IGNORECASE,
)


def marker(pr: int) -> str:
    return f"<!-- close-on-develop pr={pr} -->"


def closing_refs(text: str | None, repo: str) -> set[int]:
    """Issue numbers in `repo` that `text` references with a closing keyword."""
    found: set[int] = set()
    for match in _CLOSING.finditer(text or ""):
        owner_repo = match.group(1)
        if owner_repo is None or owner_repo.lower() == repo.lower():
            found.add(int(match.group(2)))
    return found


@dataclass(frozen=True)
class Candidate:
    issue: int
    pr: Mapping[str, Any]


@dataclass
class Plan:
    close: list[Candidate] = field(default_factory=list)
    skipped: list[tuple[int, str]] = field(default_factory=list)


class Client(Protocol):
    def commits_in_range(self, before: str, after: str) -> list[str]: ...

    def pulls_for_commit(self, sha: str) -> list[Mapping[str, Any]]: ...

    def issue(self, number: int) -> Mapping[str, Any] | None: ...

    def comment_bodies(self, number: int) -> list[str]: ...

    def comment(self, number: int, body: str) -> None: ...

    def close(self, number: int) -> None: ...


def merged_pulls(client: Client, shas: Sequence[str], base: str) -> list[Mapping[str, Any]]:
    """Merged PRs into `base` that the commits belong to, once each, in first-seen order."""
    seen: dict[int, Mapping[str, Any]] = {}
    for sha in shas:
        for pr in client.pulls_for_commit(sha):
            if pr.get("merged_at") and pr["base"]["ref"] == base:
                seen.setdefault(int(pr["number"]), pr)
    return list(seen.values())


def plan(client: Client, pulls: Sequence[Mapping[str, Any]], repo: str) -> Plan:
    result = Plan()
    queued: set[int] = set()
    for pr in pulls:
        refs = closing_refs(pr.get("title"), repo) | closing_refs(pr.get("body"), repo)
        for number in sorted(refs):
            if number in queued:
                result.skipped.append(
                    (number, f"already closed by an earlier PR in range, not #{pr['number']}")
                )
                continue
            issue = client.issue(number)
            if issue is None:
                result.skipped.append((number, "not found"))
            elif "pull_request" in issue:
                result.skipped.append((number, "is a pull request"))
            elif issue["state"] != "open":
                result.skipped.append((number, "already closed"))
            elif OPT_OUT_LABELS & {label["name"] for label in issue.get("labels", [])}:
                result.skipped.append((number, "opt-out label"))
            else:
                queued.add(number)
                result.close.append(Candidate(number, pr))
    return result


def comment_body(pr: Mapping[str, Any]) -> str:
    sha = pr.get("merge_commit_sha") or ""
    commit = f" in {sha}" if sha else ""
    return f"Closed by #{pr['number']}{commit}, merged to `{pr['base']['ref']}`.\n\n{marker(int(pr['number']))}"


def apply(client: Client, result: Plan, *, dry_run: bool) -> None:
    """Comment, then close. A marker already present means the comment was posted: close only."""
    for cand in result.close:
        number, pr_number = cand.issue, int(cand.pr["number"])
        has_comment = any(marker(pr_number) in body for body in client.comment_bodies(number))
        print(f"{'would close' if dry_run else 'closing'} #{number} (PR #{pr_number})")
        if dry_run:
            continue
        if not has_comment:
            client.comment(number, comment_body(cand.pr))
        client.close(number)


class GhClient:
    def __init__(self, repo: str) -> None:
        self.repo = repo

    def _api(self, *args: str) -> Any:
        proc = subprocess.run(["gh", "api", *args], capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            raise RuntimeError(f"gh api {args[-1]} failed: {proc.stderr.strip()}")
        return json.loads(proc.stdout) if proc.stdout.strip() else None

    def commits_in_range(self, before: str, after: str) -> list[str]:
        if before == ZERO_SHA:
            return [after]
        shas: list[str] = []
        page = 1
        while len(shas) < MAX_COMMITS:
            try:
                data = self._api(
                    f"repos/{self.repo}/compare/{before}...{after}?per_page=100&page={page}"
                )
            except RuntimeError as exc:
                print(
                    f"compare {before[:12]}...{after[:12]} unavailable ({exc}); using {after[:12]} only"
                )
                return [after]
            batch = [c["sha"] for c in data["commits"]]
            shas += batch
            if len(batch) < 100:
                break
            page += 1
        if len(shas) > MAX_COMMITS:
            print(
                f"range has more than {MAX_COMMITS} commits; only the first {MAX_COMMITS} are checked"
            )
        return shas[:MAX_COMMITS]

    def pulls_for_commit(self, sha: str) -> list[Mapping[str, Any]]:
        return self._api(f"repos/{self.repo}/commits/{sha}/pulls?per_page=100") or []

    def issue(self, number: int) -> Mapping[str, Any] | None:
        try:
            return self._api(f"repos/{self.repo}/issues/{number}")
        except RuntimeError as exc:
            if "404" in str(exc) or "Not Found" in str(exc):
                return None
            raise

    def comment_bodies(self, number: int) -> list[str]:
        data = self._api("--paginate", f"repos/{self.repo}/issues/{number}/comments?per_page=100")
        return [c["body"] or "" for c in data or []]

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


def run(client: Client, *, repo: str, before: str, after: str, base: str, dry_run: bool) -> Plan:
    shas = client.commits_in_range(before, after)
    result = plan(client, merged_pulls(client, shas, base), repo)
    for number, reason in result.skipped:
        print(f"skip #{number}: {reason}")
    apply(client, result, dry_run=dry_run)
    return result


def main(argv: Sequence[str] | None = None, *, client: Client | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    repo, before, after = (os.environ[k] for k in ("REPO", "BEFORE", "AFTER"))
    dry_run = args.dry_run or os.environ.get("DRY_RUN", "").lower() == "true"
    run(
        client or GhClient(repo),
        repo=repo,
        before=before or ZERO_SHA,
        after=after,
        base=branches.base(),
        dry_run=dry_run,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
