"""Read-only, fail-closed merge-gate check for Codex issue-pipeline PRs."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from datetime import UTC, datetime, timedelta
from typing import Any

REQUIRED_CHECKS = ("pytest", "frontend", "frontend-e2e", "gitleaks-history")
HOLD_LABELS = {"needs-user-input", "do-not-merge"}
STALL_LABEL = "pipeline:stalled"
HEAD_SHA = re.compile(r"[0-9a-f]{40}\Z")
CLAIM_MARK = re.compile(
    r"^<!-- pipeline-claim token=(\S+) stage=(planning|implementing|review|merging) "
    r"heartbeat=(\S+) released=(\S+) -->"
)
CLOSES_ISSUE = re.compile(r"(?im)^\s*(?:fixes|closes|resolves)\s+#(\d+)\s*$")


def gh_json(*args: str) -> Any:
    """Run gh without a shell; accept nonzero check status only with valid JSON."""
    result = subprocess.run(["gh", *args], capture_output=True, text=True, check=False)
    if result.returncode and args[:2] != ("pr", "checks"):
        raise RuntimeError(result.stderr.strip() or f"gh {' '.join(args)} failed")
    if not result.stdout.strip():
        raise RuntimeError(result.stderr.strip() or f"gh {' '.join(args)} failed")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("gh returned invalid JSON") from exc


def review_threads(repo: str, pr_number: int) -> list[dict[str, Any]]:
    """Fetch every review thread, including pages after the first 100."""
    owner, name = repo.split("/", 1)
    cursor: str | None = None
    threads: list[dict[str, Any]] = []
    while True:
        query = (
            "{repository(owner:"
            f"{json.dumps(owner)},name:{json.dumps(name)})"
            f"{{pullRequest(number:{pr_number})"
            "{reviewThreads(first:100,after:"
            f"{json.dumps(cursor)})"
            "{nodes{id isResolved} pageInfo{hasNextPage endCursor}}}}}"
        )
        data = gh_json("api", "graphql", "-f", f"query={query}")
        page = data["data"]["repository"]["pullRequest"]["reviewThreads"]
        threads.extend(page["nodes"])
        if not page["pageInfo"]["hasNextPage"]:
            return threads
        next_cursor = page["pageInfo"]["endCursor"]
        if not next_cursor or next_cursor == cursor:
            raise RuntimeError("review thread pagination did not advance")
        cursor = next_cursor


def issue_comments(repo: str, issue_number: int) -> list[dict[str, Any]]:
    """Read every issue comment; GitHub returns one array per slurped page."""
    pages = gh_json(
        "api",
        f"repos/{repo}/issues/{issue_number}/comments?per_page=100",
        "--paginate",
        "--slurp",
    )
    if not isinstance(pages, list) or any(not isinstance(page, list) for page in pages):
        raise RuntimeError("issue comments response was not a list of pages")
    return [comment for page in pages for comment in page]


def claim_blockers(
    issue: dict[str, Any],
    pr: dict[str, Any],
    comments: list[dict[str, Any]],
    token: str,
    now: datetime,
    stale_hours: int,
) -> list[str]:
    """Verify this run owns the oldest live claim at the merging stage."""
    blockers: list[str] = []
    issue_labels = {label.get("name") for label in issue.get("labels", [])}
    pr_labels = {label.get("name") for label in pr.get("labels", [])}
    if "in-progress" not in issue_labels:
        blockers.append("issue is missing in-progress label")
    if "pipeline:merging" not in issue_labels or "pipeline:merging" not in pr_labels:
        blockers.append("issue or PR is missing pipeline:merging label")

    live: list[tuple[str, int, str, str]] = []
    for comment in comments:
        match = CLAIM_MARK.match(comment.get("body", ""))
        if not match or match.group(4) != "no":
            continue
        try:
            heartbeat = datetime.fromisoformat(match.group(3).replace("Z", "+00:00"))
        except ValueError:
            continue
        if heartbeat.tzinfo is None or not now - timedelta(hours=stale_hours) < heartbeat <= now:
            continue
        live.append((comment["created_at"], comment["id"], match.group(1), match.group(2)))
    if not live:
        blockers.append("no live pipeline claim")
    else:
        winner = min(live)
        if winner[2] != token:
            blockers.append("another live claim owns the issue")
        elif winner[3] != "merging":
            blockers.append("claim comment is not at merging stage")
    return blockers


def evaluate_gate(
    before: dict[str, Any],
    after: dict[str, Any],
    checks: list[dict[str, Any]],
    threads: list[dict[str, Any]],
    wont_do: int,
    issue: dict[str, Any],
    comments: list[dict[str, Any]],
    claim_token: str,
    now: datetime,
    stale_hours: int,
) -> dict[str, Any]:
    """Derive the verdict from raw GitHub rows, never a model summary."""
    blockers: list[str] = []
    sha = before.get("headRefOid")
    if not isinstance(sha, str) or not HEAD_SHA.fullmatch(sha):
        blockers.append("invalid head SHA")
    if after.get("headRefOid") != sha:
        blockers.append("head moved during gate collection")
    if before.get("state") != "OPEN" or after.get("state") != "OPEN":
        blockers.append("PR is not open")
    if before.get("baseRefName") != "main" or after.get("baseRefName") != "main":
        blockers.append("PR does not target main")
    if before.get("mergeStateStatus") != "CLEAN" or after.get("mergeStateStatus") != "CLEAN":
        blockers.append("PR merge state is not CLEAN")
    issue_number = issue.get("number")
    refs = CLOSES_ISSUE.findall(after.get("body") or "")
    if not isinstance(issue_number, int) or issue_number not in [int(ref) for ref in refs]:
        blockers.append("PR body does not close the claimed issue")
    if before.get("body") != after.get("body"):
        blockers.append("PR body changed during gate collection")

    labels = {label["name"] for label in after.get("labels", []) if isinstance(label, dict)}
    issue_labels = {label["name"] for label in issue.get("labels", []) if isinstance(label, dict)}
    for label in sorted((labels | issue_labels) & HOLD_LABELS):
        blockers.append(f"hold label: {label}")
    if STALL_LABEL in labels:
        blockers.append("PR is technically stalled; resume it before gating")
    for name in REQUIRED_CHECKS:
        rows = [row for row in checks if row.get("name") == name]
        if not rows:
            blockers.append(f"missing required check: {name}")
        elif any(row.get("state") != "SUCCESS" for row in rows):
            blockers.append(f"required check not successful: {name}")
    unresolved = sum(not thread.get("isResolved", False) for thread in threads)
    if unresolved:
        blockers.append(f"{unresolved} unresolved review thread(s)")
    if wont_do:
        blockers.append(f"{wont_do} won't-do item(s) need owner sign-off")
    blockers.extend(claim_blockers(issue, after, comments, claim_token, now, stale_hours))
    return {"mergeable": not blockers, "head_sha": sha, "blockers": blockers}


def collect_gate(
    repo: str, pr_number: int, issue_number: int, claim_token: str, wont_do: int, stale_hours: int
) -> dict[str, Any]:
    fields = "headRefOid,state,baseRefName,body,mergeStateStatus,labels"
    command = ("pr", "view", str(pr_number), "-R", repo, "--json", fields)
    before = gh_json(*command)
    checks = gh_json(
        "pr", "checks", str(pr_number), "-R", repo, "--required", "--json", "name,state,bucket"
    )
    threads = review_threads(repo, pr_number)
    issue = gh_json("issue", "view", str(issue_number), "-R", repo, "--json", "number,labels")
    comments = issue_comments(repo, issue_number)
    after = gh_json(*command)
    if not isinstance(checks, list):
        raise RuntimeError("required checks response was not a list")
    return evaluate_gate(
        before,
        after,
        checks,
        threads,
        wont_do,
        issue,
        comments,
        claim_token,
        datetime.now(UTC),
        stale_hours,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="GitHub owner/repo")
    parser.add_argument("--pr", required=True, type=int, help="Pull request number")
    parser.add_argument("--issue", required=True, type=int, help="Claimed issue number")
    parser.add_argument("--claim-token", required=True, help="Token in this run's claim comment")
    parser.add_argument("--stale-hours", type=int, default=6, help="Claim heartbeat lifetime")
    parser.add_argument("--wont-do", required=True, type=int, help="Unresolved won't-do count")
    args = parser.parse_args()
    if (
        not re.fullmatch(r"[\w.-]+/[\w.-]+", args.repo)
        or args.pr < 1
        or args.issue < 1
        or not re.fullmatch(r"[\w.-]+", args.claim_token)
        or args.stale_hours < 1
        or args.wont_do < 0
    ):
        parser.error(
            "repo, PR/issue number, claim token, stale hours, or won't-do count is invalid"
        )
    try:
        verdict = collect_gate(
            args.repo, args.pr, args.issue, args.claim_token, args.wont_do, args.stale_hours
        )
    except (KeyError, TypeError, OSError, RuntimeError) as exc:
        verdict = {"mergeable": False, "head_sha": None, "blockers": [str(exc)]}
    print(json.dumps(verdict, indent=2))
    return 0 if verdict["mergeable"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
