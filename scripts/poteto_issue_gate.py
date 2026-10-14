"""Read-only, fail-closed repository merge predicates for issue-backed Poteto PRs."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from datetime import UTC, datetime, timedelta
from typing import Any, Final

REQUIRED_CHECKS = ("pytest", "frontend", "frontend-e2e", "gitleaks-history")
HOLD_LABELS = {"needs-user-input", "do-not-merge"}
STALL_LABEL = "pipeline:stalled"
HEAD_SHA = re.compile(r"[0-9a-f]{40}\Z")
CLAIM_MARK = re.compile(
    r"^<!-- pipeline-claim token=(\S+) stage=(planning|implementing|review|merging) "
    r"heartbeat=(\S+) released=(\S+) -->"
)
CLOSES_ISSUE = re.compile(r"(?im)^\s*(?:fixes|closes|resolves)\s+#(\d+)\s*$")
PART_OF_ISSUE = re.compile(r"(?im)^\s*part\s+of\s+#(\d+)\s*$")
_GRAPHQL_FORBIDDEN = "Resource not accessible by integration"

_CHECK_RUNS_PER_PAGE: Final = "100"
_REVIEW_COMMENTS_PER_PAGE: Final = "100"


def gh_json(*args: str) -> Any:
    result = subprocess.run(["gh", *args], capture_output=True, text=True, check=False)
    if result.returncode and args[:2] != ("pr", "checks"):
        raise RuntimeError(result.stderr.strip() or f"gh {' '.join(args)} failed")
    if not result.stdout.strip():
        raise RuntimeError(result.stderr.strip() or f"gh {' '.join(args)} failed")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("gh returned invalid JSON") from exc


def _api_path(repo: str, suffix: str) -> str:
    return f"repos/{repo}/{suffix}"


def rest_fetch_pull(repo: str, pr_number: int) -> dict[str, Any]:
    wire = gh_json("api", _api_path(repo, f"pulls/{pr_number}"))
    if not isinstance(wire, dict):
        raise RuntimeError("pull request response was not an object")
    return wire


def rest_fetch_check_run_pages(repo: str, head_sha: str) -> list[dict[str, Any]]:
    pages = gh_json(
        "api",
        _api_path(repo, f"commits/{head_sha}/check-runs?per_page={_CHECK_RUNS_PER_PAGE}"),
        "--paginate",
        "--slurp",
    )
    if not isinstance(pages, list) or any(not isinstance(page, dict) for page in pages):
        raise RuntimeError("check runs response was not a list of pages")
    return pages


def rest_fetch_review_comment_pages(repo: str, pr_number: int) -> list[list[dict[str, Any]]]:
    pages = gh_json(
        "api",
        _api_path(repo, f"pulls/{pr_number}/comments?per_page={_REVIEW_COMMENTS_PER_PAGE}"),
        "--paginate",
        "--slurp",
    )
    if not isinstance(pages, list) or any(not isinstance(page, list) for page in pages):
        raise RuntimeError("review comments response was not a list of pages")
    return pages


def rest_fetch_issue(repo: str, issue_number: int) -> dict[str, Any]:
    wire = gh_json("api", _api_path(repo, f"issues/{issue_number}"))
    if not isinstance(wire, dict):
        raise RuntimeError("issue response was not an object")
    return {"number": wire["number"], "labels": wire.get("labels", [])}


def adapt_rest_pull(wire: dict[str, Any]) -> dict[str, Any]:
    head = wire.get("head")
    if not isinstance(head, dict) or not isinstance(head.get("sha"), str):
        raise RuntimeError("pull request head.sha missing")
    base = wire.get("base")
    base_ref = base.get("ref") if isinstance(base, dict) else None
    if not isinstance(base_ref, str):
        raise RuntimeError("pull request base.ref missing")
    state = wire.get("state")
    if not isinstance(state, str):
        raise RuntimeError("pull request state missing")
    mergeable = wire.get("mergeable_state")
    if not isinstance(mergeable, str):
        raise RuntimeError("pull request mergeable_state missing")
    labels = wire.get("labels")
    if not isinstance(labels, list):
        labels = []
    body = wire.get("body") or ""
    return {
        "headRefOid": head["sha"],
        "state": state.upper(),
        "baseRefName": base_ref,
        "body": body,
        "mergeStateStatus": mergeable.upper(),
        "labels": labels,
    }


def adapt_check_run_to_gate_row(run: dict[str, Any]) -> dict[str, str]:
    name = run.get("name")
    if not isinstance(name, str):
        raise RuntimeError("check run name missing")
    status = run.get("status")
    conclusion = run.get("conclusion")
    state = "SUCCESS" if status == "completed" and conclusion == "success" else "FAILURE"
    return {"name": name, "state": state}


def flatten_check_run_pages(pages: list[dict[str, Any]]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    expected_total: int | None = None
    for page in pages:
        check_runs = page.get("check_runs")
        if not isinstance(check_runs, list):
            raise RuntimeError("check runs page missing check_runs")
        total_count = page.get("total_count")
        if not isinstance(total_count, int):
            raise RuntimeError("check runs page missing total_count")
        if expected_total is None:
            expected_total = total_count
        elif total_count != expected_total:
            raise RuntimeError("check run pages disagree on total_count")
        for run in check_runs:
            if not isinstance(run, dict):
                raise RuntimeError("check run entry is not an object")
            rows.append(adapt_check_run_to_gate_row(run))
    if expected_total is not None and len(rows) != expected_total:
        raise RuntimeError(
            f"flattened {len(rows)} check run(s) but total_count is {expected_total}"
        )
    return rows


def _thread_root_id(comment_id: int, by_id: dict[int, dict[str, Any]]) -> int:
    current = comment_id
    seen: set[int] = set()
    while True:
        if current in seen:
            return current
        seen.add(current)
        comment = by_id.get(current)
        if comment is None:
            return current
        parent = comment.get("in_reply_to_id")
        if parent is None:
            return current
        if not isinstance(parent, int):
            return current
        current = parent


def review_threads(repo: str, pr_number: int) -> list[dict[str, Any]]:
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


def adapt_review_comment_pages(pages: list[list[dict[str, Any]]]) -> list[dict[str, bool]]:
    comments = [comment for page in pages for comment in page if isinstance(comment, dict)]
    by_id: dict[int, dict[str, Any]] = {}
    for comment in comments:
        comment_id = comment.get("id")
        if isinstance(comment_id, int):
            by_id[comment_id] = comment
    roots: set[int] = set()
    for comment_id in by_id:
        roots.add(_thread_root_id(comment_id, by_id))
    return [{"isResolved": False} for _ in sorted(roots)]


def collect_review_threads(repo: str, pr_number: int) -> list[dict[str, Any]]:
    try:
        return review_threads(repo, pr_number)
    except RuntimeError as exc:
        if _GRAPHQL_FORBIDDEN not in str(exc):
            raise
        return adapt_review_comment_pages(rest_fetch_review_comment_pages(repo, pr_number))


def issue_comments(repo: str, issue_number: int) -> list[dict[str, Any]]:
    pages = gh_json(
        "api",
        _api_path(repo, f"issues/{issue_number}/comments?per_page=100"),
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
    body = after.get("body") or ""
    closing_refs = {int(ref) for ref in CLOSES_ISSUE.findall(body)}
    part_refs = {int(ref) for ref in PART_OF_ISSUE.findall(body)}
    if not isinstance(issue_number, int) or issue_number not in closing_refs | part_refs:
        blockers.append("PR body does not link the claimed issue")
    elif issue_number in closing_refs & part_refs:
        blockers.append("PR body both closes and marks the claimed issue as a part")
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
    before = adapt_rest_pull(rest_fetch_pull(repo, pr_number))
    head_sha = before["headRefOid"]
    checks = flatten_check_run_pages(rest_fetch_check_run_pages(repo, head_sha))
    threads = collect_review_threads(repo, pr_number)
    issue = rest_fetch_issue(repo, issue_number)
    comments = issue_comments(repo, issue_number)
    after = adapt_rest_pull(rest_fetch_pull(repo, pr_number))
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
