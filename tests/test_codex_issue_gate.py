"""The Codex issue gate derives a verdict from raw GitHub data."""

from __future__ import annotations

import subprocess
from datetime import UTC, datetime
from typing import Any

import pytest

from script_loader import load_script

gate = load_script("codex_issue_gate")

SHA = "a" * 40
NEXT_SHA = "b" * 40
NOW = datetime(2026, 9, 23, 18, 0, tzinfo=UTC)
TOKEN = "codex-claim-1"


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
    assert "PR body does not close the claimed issue" in verdict["blockers"]
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
