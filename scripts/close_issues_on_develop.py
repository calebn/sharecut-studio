"""Close the issues a PR merged to the base branch references with a closing keyword.

Usage:
  python3 scripts/close_issues_on_develop.py [--dry-run]

Reads `REPO` (owner/name) and `PR_NUMBER` from the environment and calls the GitHub API through
the `gh` CLI (`GH_TOKEN`). `--dry-run` (or `DRY_RUN=true`) prints what would happen and writes
nothing. The PR is fetched through the API and must be merged into the base branch; the event
payload is not trusted.

GitHub closes an issue from `Fixes #N` only when the PR merges into the default branch, and
lanes merge into `develop`. This applies the same rule one hop earlier. Only the PR body counts
(GitHub ignores titles), text in code, HTML comments and quotes is ignored, only `close(s/d)`,
`fix(es/ed)` and `resolve(s/d)` count (not `Part of` or `Refs`), and only this repository counts.
Negation ("does not fix #5") is not understood, as on GitHub. A PR body edited after the merge
is not seen, because the run happens once at merge.

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
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import branches

OPT_OUT_LABELS = frozenset({"needs-user-input", "owner-check"})
_CLOSING = re.compile(
    r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+(?:([\w.-]+/[\w.-]+))?#(\d+)\b",
    re.IGNORECASE,
)


def marker(pr: int) -> str:
    return f"<!-- close-on-develop pr={pr} -->"


_IGNORED = re.compile(
    r"(?sm)^[ \t]*(```|~~~).*?(?:^[ \t]*\1[^\n]*$|\Z)"  # fenced code block
    r"|(?s:<!--.*?-->)"  # HTML comment
    r"|(?m:^[ \t]*>[^\n]*$)"  # blockquote line
    r"|(`+)[^\n]*?\2"  # inline code
)


def closing_refs(body: str | None, repo: str) -> set[int]:
    """Issue numbers in `repo` that the PR `body` references with a closing keyword."""
    found: set[int] = set()
    for match in _CLOSING.finditer(_IGNORED.sub(" ", body or "")):
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
            result.close.append(Candidate(number, pr))
    return result


def comment_body(pr: Mapping[str, Any]) -> str:
    sha = pr.get("merge_commit_sha") or ""
    commit = f" in {sha}" if sha else ""
    return f"Closed by #{pr['number']}{commit}, merged to `{pr['base']['ref']}`.\n\n{marker(int(pr['number']))}"


def apply(client: Client, result: Plan, *, dry_run: bool) -> int:
    """Comment, then close. A marker already present means the comment was posted: close only.

    Returns the number of candidates that failed; the rest are still attempted.
    """
    failures = 0
    for cand in result.close:
        number, pr_number = cand.issue, int(cand.pr["number"])
        print(f"{'would close' if dry_run else 'closing'} #{number} (PR #{pr_number})")
        if dry_run:
            continue
        try:
            if not any(marker(pr_number) in body for body in client.comment_bodies(number)):
                client.comment(number, comment_body(cand.pr))
            client.close(number)
        except RuntimeError as exc:
            failures += 1
            print(f"::error::could not close #{number} for PR #{pr_number}: {exc}")
    return failures


Runner = Callable[..., "subprocess.CompletedProcess[str]"]


class GhClient:
    def __init__(self, repo: str, run: Runner = subprocess.run) -> None:
        self.repo = repo
        self._run = run

    def _api(self, *args: str) -> Any:
        proc = self._run(["gh", "api", *args], capture_output=True, text=True, check=False)
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
    """Exit status 1 when any issue could not be closed, else 0 (a PR not merged to `base` is a no-op)."""
    pr = client.pull(pr_number)
    if not pr.get("merged_at") or pr["base"]["ref"] != base:
        print(f"PR #{pr_number} is not merged into {base}; nothing to do")
        return 0
    result = plan(client, pr, repo)
    for number, reason in result.skipped:
        print(f"skip #{number}: {reason}")
    for number, error in result.failed:
        print(f"::error::could not read #{number}: {error}")
    return 1 if apply(client, result, dry_run=dry_run) or result.failed else 0


def main(argv: Sequence[str] | None = None, *, client: Client | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
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
