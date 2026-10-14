from __future__ import annotations

import subprocess
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from script_loader import load_script

gate = load_script("poteto_issue_gate")

SHA = "a" * 40
NEXT_SHA = "b" * 40
NOW = datetime(2026, 9, 23, 18, 0, tzinfo=UTC)
TOKEN = "poteto-claim-1"


def _pr(sha: str = SHA) -> dict[str, Any]:
    return {
        "headRefOid": sha,
        "state": "OPEN",
        "baseRefName": "main",
        "body": "Fixes #251",
        "mergeStateStatus": "CLEAN",
        "labels": [{"name": "pipeline:merging"}],
    }


def _issue() -> dict[str, Any]:
    return {"number": 251, "labels": [{"name": "in-progress"}, {"name": "pipeline:merging"}]}


def _claim(token: str = TOKEN, heartbeat: str = "2026-09-23T17:00:00Z") -> dict[str, Any]:
    return {
        "id": 1,
        "created_at": "2026-09-23T16:00:00Z",
        "body": (
            f"<!-- pipeline-claim token={token} stage=merging "
            f"heartbeat={heartbeat} released=no -->\n🤖 Claimed by Codex"
        ),
    }


def _checks() -> list[dict[str, str]]:
    return [{"name": name, "state": "SUCCESS"} for name in gate.REQUIRED_CHECKS]


def test_gh_json_rejects_failed_reads_but_accepts_pending_check_rows(monkeypatch: Any) -> None:
    def failed_json(*args: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(args[0], 1, '{"ok": true}', "GitHub read failed")

    monkeypatch.setattr(gate.subprocess, "run", failed_json)
    with pytest.raises(RuntimeError, match="GitHub read failed"):
        gate.gh_json("pr", "view", "258")
    assert gate.gh_json("pr", "checks", "258") == {"ok": True}


def test_gate_accepts_verified_open_pr() -> None:
    verdict = gate.evaluate_gate(
        _pr(), _pr(), _checks(), [{"isResolved": True}], 0, _issue(), [_claim()], TOKEN, NOW, 6
    )
    assert verdict == {"mergeable": True, "head_sha": SHA, "blockers": []}


def test_gate_accepts_nonfinal_part_without_closing_issue() -> None:
    part = _pr()
    part["body"] = "Part of #251\nRelated #252"
    verdict = gate.evaluate_gate(part, part, _checks(), [], 0, _issue(), [_claim()], TOKEN, NOW, 6)
    assert verdict == {"mergeable": True, "head_sha": SHA, "blockers": []}


def test_gate_rejects_ambiguous_or_unrelated_issue_links() -> None:
    ambiguous = _pr()
    ambiguous["body"] = "Fixes #251\nPart of #251"
    verdict = gate.evaluate_gate(
        ambiguous, ambiguous, _checks(), [], 0, _issue(), [_claim()], TOKEN, NOW, 6
    )
    assert "PR body both closes and marks the claimed issue as a part" in verdict["blockers"]

    unrelated = _pr()
    unrelated["body"] = "Part of #252\nRelated #251"
    verdict = gate.evaluate_gate(
        unrelated, unrelated, _checks(), [], 0, _issue(), [_claim()], TOKEN, NOW, 6
    )
    assert "PR body does not link the claimed issue" in verdict["blockers"]


def test_gate_rejects_moved_head_and_missing_or_failed_checks() -> None:
    checks = _checks()[:-1]
    checks[0]["state"] = "FAILURE"
    verdict = gate.evaluate_gate(
        _pr(), _pr(NEXT_SHA), checks, [], 0, _issue(), [_claim()], TOKEN, NOW, 6
    )
    assert not verdict["mergeable"]
    assert "head moved during gate collection" in verdict["blockers"]
    assert f"missing required check: {gate.REQUIRED_CHECKS[-1]}" in verdict["blockers"]
    assert f"required check not successful: {gate.REQUIRED_CHECKS[0]}" in verdict["blockers"]


def test_gate_rejects_hold_labels_threads_wont_do_and_unmergeable_state() -> None:
    after = _pr()
    after["labels"] = [
        {"name": "do-not-merge"},
        {"name": "pipeline:merging"},
        {"name": "pipeline:stalled"},
    ]
    after["mergeStateStatus"] = "DIRTY"
    verdict = gate.evaluate_gate(
        _pr(), after, _checks(), [{"isResolved": False}], 1, _issue(), [_claim()], TOKEN, NOW, 6
    )
    assert not verdict["mergeable"]
    assert "hold label: do-not-merge" in verdict["blockers"]
    assert "PR is technically stalled; resume it before gating" in verdict["blockers"]
    assert "1 unresolved review thread(s)" in verdict["blockers"]
    assert "1 won't-do item(s) need owner sign-off" in verdict["blockers"]
    assert "PR merge state is not CLEAN" in verdict["blockers"]


def test_gate_rejects_wrong_base_issue_and_issue_hold() -> None:
    before = _pr()
    after = _pr()
    before["baseRefName"] = after["baseRefName"] = "release"
    after["body"] = "Fixes #252"
    issue = _issue()
    issue["labels"].append({"name": "needs-user-input"})
    verdict = gate.evaluate_gate(before, after, _checks(), [], 0, issue, [_claim()], TOKEN, NOW, 6)
    assert not verdict["mergeable"]
    assert "PR does not target main" in verdict["blockers"]
    assert "PR body does not link the claimed issue" in verdict["blockers"]
    assert "PR body changed during gate collection" in verdict["blockers"]
    assert "hold label: needs-user-input" in verdict["blockers"]


def test_claim_gate_respects_earliest_live_claim_and_expiry() -> None:
    other = _claim("other-token")
    other["created_at"] = "2026-09-23T15:00:00Z"
    blockers = gate.claim_blockers(_issue(), _pr(), [other, _claim()], TOKEN, NOW, 6)
    assert "another live claim owns the issue" in blockers

    stale = _claim(heartbeat="2026-09-23T10:00:00Z")
    blockers = gate.claim_blockers(_issue(), _pr(), [stale], TOKEN, NOW, 6)
    assert "no live pipeline claim" in blockers

    blockers = gate.claim_blockers(_issue(), _pr(), [_claim()], TOKEN, NOW, 6)
    assert blockers == []


def test_claim_gate_requires_stage_labels() -> None:
    blockers = gate.claim_blockers({"labels": []}, {"labels": []}, [_claim()], TOKEN, NOW, 6)
    assert "issue is missing in-progress label" in blockers
    assert "issue or PR is missing pipeline:merging label" in blockers

    planning = _claim()
    planning["body"] = planning["body"].replace("stage=merging", "stage=planning")
    blockers = gate.claim_blockers(_issue(), _pr(), [planning], TOKEN, NOW, 6)
    assert "claim comment is not at merging stage" in blockers


def test_review_threads_follows_every_page(monkeypatch: Any) -> None:
    calls: list[tuple[str, ...]] = []
    review_pages = [
        [{"id": 1, "in_reply_to_id": None}],
        [{"id": 2, "in_reply_to_id": None}],
    ]

    def fake_gh_json(*args: str) -> Any:
        calls.append(args)
        if args[1].endswith("/pulls/252/comments?per_page=100"):
            return review_pages
        raise AssertionError(f"unexpected gh_json call: {args}")

    monkeypatch.setattr(gate, "gh_json", fake_gh_json)
    pages = gate.rest_fetch_review_comment_pages("calebn/sharecut-studio", 252)
    threads = gate.adapt_review_comment_pages(pages)
    assert pages == review_pages
    assert threads == [{"isResolved": False}, {"isResolved": False}]
    assert calls[0][:2] == ("api", "repos/calebn/sharecut-studio/pulls/252/comments?per_page=100")
    assert "--paginate" in calls[0]
    assert "--slurp" in calls[0]


def test_gate_collection_rechecks_head_after_network_reads(monkeypatch: Any) -> None:
    pr_reads = [_rest_pr(), _rest_pr(sha=NEXT_SHA)]
    check_pages = _rest_check_pages([_rest_check_run(name) for name in gate.REQUIRED_CHECKS])

    def fake_gh_json(*args: str) -> Any:
        if not args or args[0] != "api" or args[1:2] == ("graphql",):
            raise RuntimeError(GRAPHQL_403)
        path = args[1]
        if path == "repos/calebn/sharecut-studio/pulls/252":
            return pr_reads.pop(0)
        if path.startswith("repos/calebn/sharecut-studio/commits/") and "/check-runs" in path:
            return check_pages
        if path.startswith("repos/calebn/sharecut-studio/pulls/252/comments"):
            return [[]]
        if path == "repos/calebn/sharecut-studio/issues/200":
            return _rest_issue()
        if path.startswith("repos/calebn/sharecut-studio/issues/200/comments"):
            return [[_claim()]]
        raise RuntimeError(GRAPHQL_403)

    monkeypatch.setattr(gate, "gh_json", fake_gh_json)
    verdict = gate.collect_gate("calebn/sharecut-studio", 252, 200, TOKEN, 0, 6)
    assert not verdict["mergeable"]
    assert "head moved during gate collection" in verdict["blockers"]


GRAPHQL_403 = "GraphQL: Resource not accessible by integration"


def _rest_pr(*, sha: str = SHA, mergeable_state: str = "clean") -> dict[str, Any]:
    return {
        "state": "open",
        "body": "Fixes #251",
        "head": {"sha": sha},
        "base": {"ref": "main"},
        "labels": [{"name": "pipeline:merging"}],
        "mergeable_state": mergeable_state,
    }


def _rest_issue() -> dict[str, Any]:
    return {"number": 251, "labels": [{"name": "in-progress"}, {"name": "pipeline:merging"}]}


def _rest_check_run(
    name: str, *, status: str = "completed", conclusion: str | None = "success"
) -> dict[str, Any]:
    return {"name": name, "status": status, "conclusion": conclusion}


def _rest_check_pages(*pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"total_count": sum(len(page) for page in pages), "check_runs": page} for page in pages]


def _graphql_forbidden_rest(
    *,
    pr: dict[str, Any] | None = None,
    after_pr: dict[str, Any] | None = None,
    check_pages: list[dict[str, Any]] | None = None,
    review_pages: list[list[dict[str, Any]]] | None = None,
    issue: dict[str, Any] | None = None,
    comments: list[list[dict[str, Any]]] | None = None,
    graphql_threads: list[dict[str, Any]] | None = None,
) -> Any:
    pr = _rest_pr() if pr is None else pr
    after_pr = pr if after_pr is None else after_pr
    check_pages = (
        _rest_check_pages([_rest_check_run(name) for name in gate.REQUIRED_CHECKS])
        if check_pages is None
        else check_pages
    )
    review_pages = [[]] if review_pages is None else review_pages
    issue = _rest_issue() if issue is None else issue
    if comments is None:
        fresh = (datetime.now(UTC) - timedelta(hours=1)).replace(microsecond=0)
        comments = [[_claim(heartbeat=fresh.isoformat().replace("+00:00", "Z"))]]
    pr_reads = [pr, after_pr]

    def fake_gh_json(*args: str) -> Any:
        if args[:2] == ("api", "graphql"):
            if graphql_threads is None:
                raise RuntimeError(GRAPHQL_403)
            return {
                "data": {
                    "repository": {
                        "pullRequest": {
                            "reviewThreads": {
                                "nodes": graphql_threads,
                                "pageInfo": {"hasNextPage": False, "endCursor": None},
                            }
                        }
                    }
                }
            }
        if not args or args[0] != "api":
            raise RuntimeError(GRAPHQL_403)
        path = args[1]
        if path == "repos/calebn/sharecut-studio/pulls/252":
            return pr_reads.pop(0)
        if path.startswith("repos/calebn/sharecut-studio/commits/") and "/check-runs" in path:
            return check_pages
        if path.startswith("repos/calebn/sharecut-studio/pulls/252/comments"):
            return review_pages
        if path == "repos/calebn/sharecut-studio/issues/251":
            return issue
        if path.startswith("repos/calebn/sharecut-studio/issues/251/comments"):
            return comments
        raise RuntimeError(GRAPHQL_403)

    return fake_gh_json


def test_collect_gate_falls_back_to_rest_when_graphql_returns_403(monkeypatch: Any) -> None:
    calls: list[tuple[str, ...]] = []
    inner = _graphql_forbidden_rest(
        review_pages=[
            [{"id": 10, "in_reply_to_id": None}, {"id": 20, "in_reply_to_id": None}],
        ]
    )

    def fake_gh_json(*args: str) -> Any:
        calls.append(args)
        return inner(*args)

    monkeypatch.setattr(gate, "gh_json", fake_gh_json)
    verdict = gate.collect_gate("calebn/sharecut-studio", 252, 251, TOKEN, 0, 6)
    assert verdict["head_sha"] == SHA
    assert verdict["mergeable"] is False
    assert "2 unresolved review thread(s)" in verdict["blockers"]
    assert any(args[:2] == ("api", "graphql") for args in calls)
    assert any(len(args) > 1 and "/pulls/252/comments" in args[1] for args in calls)


def test_collect_gate_resolved_graphql_threads_match_trunk_when_rest_comments_remain(
    monkeypatch: Any,
) -> None:
    rest_comments = [
        {"id": 1, "in_reply_to_id": None},
        {"id": 2, "in_reply_to_id": 1},
        {"id": 3, "in_reply_to_id": None},
        {"id": 4, "in_reply_to_id": 3},
        {"id": 5, "in_reply_to_id": None},
        {"id": 6, "in_reply_to_id": 5},
        {"id": 7, "in_reply_to_id": None},
        {"id": 8, "in_reply_to_id": 7},
        {"id": 9, "in_reply_to_id": None},
        {"id": 10, "in_reply_to_id": 9},
    ]
    monkeypatch.setattr(
        gate,
        "gh_json",
        _graphql_forbidden_rest(
            graphql_threads=[{"isResolved": True} for _ in range(5)],
            review_pages=[rest_comments],
        ),
    )
    verdict = gate.collect_gate("calebn/sharecut-studio", 252, 251, TOKEN, 0, 6)
    assert verdict == {"mergeable": True, "head_sha": SHA, "blockers": []}


def test_flatten_check_run_pages_aborts_when_rows_miss_total_count() -> None:
    first = [_rest_check_run(name) for name in gate.REQUIRED_CHECKS]
    with pytest.raises(RuntimeError, match="total_count"):
        gate.flatten_check_run_pages([{"total_count": 5, "check_runs": first}])


def test_flatten_check_run_pages_aborts_on_non_dict_rows() -> None:
    with pytest.raises(RuntimeError, match="not an object"):
        gate.flatten_check_run_pages([{"total_count": 1, "check_runs": ["bad"]}])


def test_collect_gate_incomplete_check_run_pages_are_not_mergeable(monkeypatch: Any) -> None:
    first = [_rest_check_run(name) for name in gate.REQUIRED_CHECKS]
    monkeypatch.setattr(
        gate,
        "gh_json",
        _graphql_forbidden_rest(check_pages=[{"total_count": 5, "check_runs": first}]),
    )
    with pytest.raises(RuntimeError, match="total_count"):
        gate.collect_gate("calebn/sharecut-studio", 252, 251, TOKEN, 0, 6)


def test_collect_gate_paginates_rest_check_runs_and_blocks_pending(
    monkeypatch: Any,
) -> None:
    first = [_rest_check_run("pytest"), _rest_check_run("frontend")]
    second = [
        _rest_check_run("frontend-e2e"),
        _rest_check_run("gitleaks-history", status="in_progress", conclusion=None),
    ]
    monkeypatch.setattr(
        gate,
        "gh_json",
        _graphql_forbidden_rest(check_pages=_rest_check_pages(first, second)),
    )
    verdict = gate.collect_gate("calebn/sharecut-studio", 252, 251, TOKEN, 0, 6)
    assert verdict["head_sha"] == SHA
    assert "required check not successful: gitleaks-history" in verdict["blockers"]
    assert "missing required check: frontend-e2e" not in verdict["blockers"]


def test_collect_gate_counts_each_rest_review_comment_thread_as_unresolved(
    monkeypatch: Any,
) -> None:
    review_pages = [
        [{"id": 10, "in_reply_to_id": None}],
        [{"id": 11, "in_reply_to_id": 10}, {"id": 20, "in_reply_to_id": None}],
    ]
    monkeypatch.setattr(gate, "gh_json", _graphql_forbidden_rest(review_pages=review_pages))
    verdict = gate.collect_gate("calebn/sharecut-studio", 252, 251, TOKEN, 0, 6)
    assert "2 unresolved review thread(s)" in verdict["blockers"]
