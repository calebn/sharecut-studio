from __future__ import annotations

import subprocess
from datetime import UTC, datetime
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
    queries: list[str] = []
    pages = [
        {"nodes": [{"isResolved": True}], "pageInfo": {"hasNextPage": True, "endCursor": "next"}},
        {"nodes": [{"isResolved": False}], "pageInfo": {"hasNextPage": False, "endCursor": None}},
    ]

    def fake_gh_json(*args: str) -> dict[str, Any]:
        queries.append(args[-1])
        return {"data": {"repository": {"pullRequest": {"reviewThreads": pages.pop(0)}}}}

    monkeypatch.setattr(gate, "gh_json", fake_gh_json)
    threads = gate.review_threads("calebn/sharecut-studio", 252)
    assert threads == [{"isResolved": True}, {"isResolved": False}]
    assert "after:null" in queries[0]
    assert 'after:"next"' in queries[1]


def test_gate_collection_rechecks_head_after_network_reads(monkeypatch: Any) -> None:
    responses: list[Any] = [_pr(), _checks(), _issue(), _pr(NEXT_SHA)]

    def fake_gh_json(*_args: str) -> Any:
        return responses.pop(0)

    monkeypatch.setattr(gate, "gh_json", fake_gh_json)
    monkeypatch.setattr(gate, "review_threads", lambda *_args: [])
    monkeypatch.setattr(gate, "issue_comments", lambda *_args: [_claim()])
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
    comments = [[_claim()]] if comments is None else comments
    pr_reads = [pr, after_pr]

    def fake_gh_json(*args: str) -> Any:
        if not args or args[0] != "api" or args[1:2] == ("graphql",):
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
    monkeypatch.setattr(gate, "gh_json", _graphql_forbidden_rest())
    verdict = gate.collect_gate("calebn/sharecut-studio", 252, 251, TOKEN, 0, 6)
    assert verdict == {"mergeable": True, "head_sha": SHA, "blockers": []}


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
