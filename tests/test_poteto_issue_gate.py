from __future__ import annotations

import json
import subprocess
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from script_loader import load_script

branches = load_script("branches", register=True)
gate = load_script("poteto_issue_gate")
BASE = branches.base()

SHA = "a" * 40
NEXT_SHA = "b" * 40
NOW = datetime(2026, 9, 23, 18, 0, tzinfo=UTC)
TOKEN = "poteto-claim-1"


def _pr(sha: str = SHA) -> dict[str, Any]:
    return {
        "headRefOid": sha,
        "state": "OPEN",
        "baseRefName": BASE,
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


def test_gate_qualifies_before_pr_handoff_label() -> None:
    pr = _pr()
    pr["labels"] = [{"name": "pipeline:review"}]
    verdict = gate.evaluate_gate(pr, pr, _checks(), [], 0, _issue(), [_claim()], TOKEN, NOW, 6)
    assert verdict == {"mergeable": True, "head_sha": SHA, "blockers": []}


def test_gate_rejects_missing_or_conflicting_pr_stages() -> None:
    for labels in ([], [{"name": "pipeline:review"}, {"name": "pipeline:merging"}]):
        pr = _pr()
        pr["labels"] = labels
        verdict = gate.evaluate_gate(pr, pr, _checks(), [], 0, _issue(), [_claim()], TOKEN, NOW, 6)
        assert not verdict["mergeable"]


def test_gate_still_requires_issue_merging_stage_before_handoff() -> None:
    pr = _pr()
    pr["labels"] = [{"name": "pipeline:review"}]
    issue = _issue()
    issue["labels"] = [{"name": "in-progress"}]
    verdict = gate.evaluate_gate(pr, pr, _checks(), [], 0, issue, [_claim()], TOKEN, NOW, 6)
    assert not verdict["mergeable"]


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
    before["baseRefName"] = after["baseRefName"] = "release-x"
    after["body"] = "Fixes #252"
    issue = _issue()
    issue["labels"].append({"name": "needs-user-input"})
    verdict = gate.evaluate_gate(before, after, _checks(), [], 0, issue, [_claim()], TOKEN, NOW, 6)
    assert not verdict["mergeable"]
    assert f"PR does not target {BASE}" in verdict["blockers"]
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
    assert "issue is missing pipeline:merging label" in blockers
    assert "PR must have exactly one review or merging stage" in blockers

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
    monkeypatch.setattr(gate, "collect_required_checks", lambda *_: _checks())
    verdict = gate.collect_gate("calebn/sharecut-studio", 252, 200, TOKEN, 0, 6)
    assert not verdict["mergeable"]
    assert "head moved during gate collection" in verdict["blockers"]


GRAPHQL_403 = "GraphQL: Resource not accessible by integration"
GH_PREFIXED_403 = "gh: GraphQL: Resource not accessible by integration"
GH_FIELD_PATH_403 = (
    "gh: GraphQL: Resource not accessible by integration (repository.pullRequest.reviewThreads)"
)


def _rest_pr(*, sha: str = SHA, mergeable_state: str = "clean") -> dict[str, Any]:
    return {
        "state": "open",
        "body": "Fixes #251",
        "head": {"sha": sha},
        "base": {"ref": BASE},
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


def _completed(
    stdout: str = "", stderr: str = "", returncode: int = 0
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(["gh"], returncode, stdout, stderr)


def _gh_run_through_json(
    fake_gh_json: Any, *, graphql_stderr: str, calls: list[tuple[str, ...]]
) -> Any:
    def fake_run(command: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        args = tuple(command[1:])
        calls.append(args)
        if args[:2] == ("api", "graphql"):
            return _completed(stderr=graphql_stderr, returncode=1)
        try:
            payload = fake_gh_json(*args)
        except RuntimeError as exc:
            return _completed(stderr=str(exc), returncode=1)
        return _completed(stdout=json.dumps(payload), returncode=0)

    return fake_run


def _assert_graphql_403_uses_rest(monkeypatch: Any, stderr: str) -> None:
    calls: list[tuple[str, ...]] = []
    inner = _graphql_forbidden_rest(
        review_pages=[
            [{"id": 10, "in_reply_to_id": None}, {"id": 20, "in_reply_to_id": None}],
        ]
    )
    monkeypatch.setattr(
        gate.subprocess, "run", _gh_run_through_json(inner, graphql_stderr=stderr, calls=calls)
    )
    monkeypatch.setattr(gate, "collect_required_checks", lambda *_: _checks())
    verdict = gate.collect_gate("calebn/sharecut-studio", 252, 251, TOKEN, 0, 6)
    assert verdict["head_sha"] == SHA
    assert verdict["mergeable"] is False
    assert "2 unresolved review thread(s)" in verdict["blockers"]
    assert any(args[:2] == ("api", "graphql") for args in calls)
    assert any(len(args) > 1 and "/pulls/252/comments" in args[1] for args in calls)


def test_collect_gate_falls_back_to_rest_when_graphql_returns_403(monkeypatch: Any) -> None:
    _assert_graphql_403_uses_rest(monkeypatch, GH_PREFIXED_403)


def test_collect_gate_falls_back_to_rest_when_gh_suffixes_graphql_403_field_path(
    monkeypatch: Any,
) -> None:
    _assert_graphql_403_uses_rest(monkeypatch, GH_FIELD_PATH_403)


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
    monkeypatch.setattr(gate, "collect_required_checks", lambda *_: _checks())
    verdict = gate.collect_gate("calebn/sharecut-studio", 252, 251, TOKEN, 0, 6)
    assert verdict == {"mergeable": True, "head_sha": SHA, "blockers": []}


def test_collection_rejects_incomplete_or_malformed_pages(monkeypatch: Any) -> None:
    monkeypatch.setattr(gate, "gh_json", lambda *_: [{"total_count": 2, "jobs": [{"id": 1}]}])
    with pytest.raises(RuntimeError, match="pagination"):
        gate._complete_pages("owner/repo", "jobs", "jobs")
    monkeypatch.setattr(gate, "gh_json", lambda *_: [{"total_count": 1, "jobs": ["bad"]}])
    with pytest.raises(RuntimeError, match="invalid"):
        gate._complete_pages("owner/repo", "jobs", "jobs")


def test_collect_gate_counts_each_rest_review_comment_thread_as_unresolved(
    monkeypatch: Any,
) -> None:
    review_pages = [
        [{"id": 10, "in_reply_to_id": None}],
        [{"id": 11, "in_reply_to_id": 10}, {"id": 20, "in_reply_to_id": None}],
    ]
    monkeypatch.setattr(gate, "gh_json", _graphql_forbidden_rest(review_pages=review_pages))
    monkeypatch.setattr(gate, "collect_required_checks", lambda *_: _checks())
    verdict = gate.collect_gate("calebn/sharecut-studio", 252, 251, TOKEN, 0, 6)
    assert "2 unresolved review thread(s)" in verdict["blockers"]


def test_current_required_checks_exclude_manual_and_historical_runs(monkeypatch: Any) -> None:
    def fake_gh(*args: str) -> Any:
        path = args[1]
        if path.endswith("actions/workflows/test.yml"):
            return {"id": 10, "path": ".github/workflows/test.yml"}
        if path.endswith("actions/workflows/secret-scan.yml"):
            return {"id": 20, "path": ".github/workflows/secret-scan.yml"}
        if "/runs?" in path:
            workflow = 10 if "/10/" in path else 20
            runs = [_eligible_run(workflow, number=2)]
            if workflow == 10:
                runs += [
                    _eligible_run(10, run_id=5),
                    _eligible_run(10, run_id=99, number=99, event="workflow_dispatch"),
                ]
            return [{"total_count": len(runs), "workflow_runs": runs}]
        if "/attempts/" in path:
            run_id = int(path.split("/runs/")[1].split("/")[0])
            names = ["pytest", "frontend", "frontend-e2e"] if run_id == 10 else ["gitleaks-history"]
            jobs = [_job(run_id, name, i) for i, name in enumerate(names, 1)]
            return [{"total_count": len(jobs), "jobs": jobs}]
        if "/check-runs/" in path:
            check_id = int(path.rsplit("/", 1)[1])
            name = {101: "pytest", 102: "frontend", 103: "frontend-e2e", 201: "gitleaks-history"}[
                check_id
            ]
            result = "success"
            return {
                "id": check_id,
                "name": name,
                "head_sha": SHA,
                "status": "completed",
                "conclusion": result,
                "check_suite": {"id": 100 if check_id < 200 else 200},
                "app": {"id": 15368},
            }
        if "/actions/runs/" in path:
            return _eligible_run(int(path.rsplit("/", 1)[1]), number=2)
        raise AssertionError(path)

    monkeypatch.setattr(gate, "gh_json", fake_gh)
    monkeypatch.setattr(gate, "rest_fetch_pull", lambda *_: _rest_pr())
    monkeypatch.setattr(gate, "collect_review_threads", lambda *_: [])
    monkeypatch.setattr(gate, "rest_fetch_issue", lambda *_: _rest_issue())
    fresh = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    monkeypatch.setattr(gate, "issue_comments", lambda *_: [_claim(heartbeat=fresh)])
    verdict = gate.collect_gate("owner/repo", 252, 251, TOKEN, 0, 6)
    assert verdict == {"mergeable": True, "head_sha": SHA, "blockers": []}


def _eligible_run(
    workflow: int, *, run_id: int | None = None, number: int = 1, event: str = "pull_request"
) -> dict[str, Any]:
    return {
        "id": run_id or workflow,
        "run_number": number,
        "run_attempt": 1,
        "workflow_id": workflow,
        "path": f".github/workflows/{'test.yml' if workflow == 10 else 'secret-scan.yml'}",
        "event": event,
        "head_sha": SHA,
        "check_suite_id": workflow * 10,
        "repository": {"full_name": "owner/repo", "id": 1},
        "head_repository": {"full_name": "owner/repo", "id": 1},
        "pull_requests": [
            {
                "number": 252,
                "head": {"sha": SHA, "repo": {"id": 1}},
                "base": {"ref": BASE, "repo": {"id": 1}},
            }
        ],
    }


def _job(run_id: int, name: str, index: int) -> dict[str, Any]:
    check_id = run_id * 10 + index
    return {
        "id": check_id,
        "name": name,
        "run_id": run_id,
        "run_attempt": 1,
        "head_sha": SHA,
        "check_run_url": f"https://api.github.com/repos/owner/repo/check-runs/{check_id}",
        "status": "completed",
        "conclusion": "success",
    }


@pytest.mark.parametrize(
    "defect",
    [
        "failure",
        "pending",
        "missing",
        "duplicate",
        "wrong_head",
        "wrong_app",
        "truncated",
        "race",
        "newer_pending",
        "attempt",
        "late_attempt",
        "late_run",
        "missing_event",
        "wrong_workflow",
        "missing_pr",
        "wrong_repo",
        "wrong_suite",
        "wrong_check_id",
        "wrong_url",
        "equal_sequence",
        "changed_check",
        "current_attempt_failure",
        "current_attempt_pending",
        "current_attempt_success",
        "older_rerun_newer_pending",
        "consistent_transition",
    ],
)
def test_required_check_evidence_fails_closed(monkeypatch: Any, defect: str) -> None:
    scans = 0
    checks_read = 0

    def fake_gh(*args: str) -> Any:
        nonlocal scans, checks_read
        path = args[1]
        if path.endswith("actions/workflows/test.yml"):
            return {"id": 10, "path": ".github/workflows/test.yml"}
        if path.endswith("actions/workflows/secret-scan.yml"):
            return {"id": 20, "path": ".github/workflows/secret-scan.yml"}
        if "/runs?" in path:
            workflow = 10 if "/10/" in path else 20
            if workflow == 10:
                scans += 1
            runs = [_eligible_run(workflow)]
            if workflow == 10 and defect == "missing_event":
                del runs[0]["event"]
            if workflow == 10 and defect == "wrong_workflow":
                runs[0]["workflow_id"] = 20
            if workflow == 10 and defect == "missing_pr":
                runs[0]["pull_requests"] = []
            if workflow == 10 and defect == "wrong_repo":
                runs[0]["repository"]["id"] = 2
            if workflow == 10 and defect == "equal_sequence":
                runs.append(_eligible_run(10, run_id=30))
            if workflow == 10 and defect in (
                "current_attempt_failure",
                "current_attempt_pending",
                "current_attempt_success",
                "older_rerun_newer_pending",
            ):
                runs[0]["run_attempt"] = 2
            if workflow == 10 and defect == "late_attempt" and checks_read >= 8:
                runs[0]["run_attempt"] = 2
            if workflow == 10 and defect == "late_run" and checks_read >= 8:
                runs.append(_eligible_run(10, run_id=30, number=2))
            if workflow == 10:
                runs.append(_eligible_run(10, run_id=99, number=99, event="workflow_dispatch"))
            if workflow == 10 and (
                defect in ("newer_pending", "older_rerun_newer_pending")
                or (defect == "race" and scans > 1)
            ):
                runs.append(_eligible_run(10, run_id=30, number=2))
            return [{"total_count": len(runs), "workflow_runs": runs}]
        if "/attempts/" in path:
            run = int(path.split("/runs/")[1].split("/")[0])
            names = (
                ["pytest", "frontend", "frontend-e2e"]
                if run in (10, 30, 99)
                else ["gitleaks-history"]
            )
            jobs = [_job(run, name, index) for index, name in enumerate(names, 1)]
            if run == 10 and defect == "missing":
                jobs.pop()
            if run == 10 and defect == "duplicate":
                jobs.append({**jobs[0], "id": 999})
            if (
                run == 10
                and defect
                in (
                    "current_attempt_failure",
                    "current_attempt_pending",
                    "current_attempt_success",
                    "older_rerun_newer_pending",
                )
                and "/attempts/2/" in path
            ):
                for job in jobs:
                    job["run_attempt"] = 2
                    job["id"] += 1000
                    job["check_run_url"] = (
                        f"https://api.github.com/repos/owner/repo/check-runs/{job['id']}"
                    )
                if defect in ("current_attempt_failure", "current_attempt_success"):
                    jobs[0]["conclusion"] = (
                        "failure" if defect == "current_attempt_failure" else "success"
                    )
                if defect == "current_attempt_pending":
                    jobs[0].update(status="in_progress", conclusion=None)
            if run == 10 and defect == "current_attempt_success" and "/attempts/1/" in path:
                jobs[0]["conclusion"] = "failure"
            if run == 10 and defect == "consistent_transition" and checks_read >= 4:
                jobs[0]["conclusion"] = "failure"
            if run == 10 and defect == "wrong_url":
                jobs[0]["check_run_url"] = "https://example.com/check-runs/101"
            if run == 10 and defect == "attempt":
                jobs[0]["run_attempt"] = 2
            if run == 10 and defect == "wrong_head":
                jobs[0]["head_sha"] = NEXT_SHA
            if run == 10 and defect == "failure":
                jobs[0]["conclusion"] = "failure"
            if (run == 10 and defect == "pending") or run == 30:
                jobs[0].update(status="in_progress", conclusion=None)
            return [{"total_count": len(jobs) + (defect == "truncated"), "jobs": jobs}]
        if "/check-runs/" in path:
            checks_read += 1
            check_id = int(path.rsplit("/", 1)[1])
            names = {
                101: "pytest",
                102: "frontend",
                103: "frontend-e2e",
                201: "gitleaks-history",
                301: "pytest",
                302: "frontend",
                303: "frontend-e2e",
                991: "pytest",
                992: "frontend",
                993: "frontend-e2e",
                1101: "pytest",
                1102: "frontend",
                1103: "frontend-e2e",
            }
            status, conclusion = "completed", "success"
            if (
                check_id == 101
                and defect in ("changed_check", "consistent_transition")
                and checks_read > 4
            ):
                conclusion = "failure"
            if (check_id == 101 and defect in ("failure", "current_attempt_success")) or (
                check_id == 1101 and defect == "current_attempt_failure"
            ):
                conclusion = "failure"
            if (
                (check_id == 101 and defect == "pending")
                or (check_id == 1101 and defect == "current_attempt_pending")
                or check_id == 301
            ):
                status, conclusion = "in_progress", None
            return {
                "id": 999 if defect == "wrong_check_id" else check_id,
                "name": names[check_id],
                "head_sha": SHA,
                "status": status,
                "conclusion": conclusion,
                "check_suite": {
                    "id": 999 if defect == "wrong_suite" else (200 if check_id == 201 else 100)
                },
                "app": {"id": 1 if defect == "wrong_app" else 15368},
            }
        if "/actions/runs/" in path:
            run = int(path.rsplit("/", 1)[1])
            if run == 30:
                return _eligible_run(10, run_id=30, number=2)
            if run == 99:
                return _eligible_run(10, run_id=99, number=99, event="workflow_dispatch")
            detail = _eligible_run(run)
            if run == 10 and (
                defect
                in (
                    "current_attempt_failure",
                    "current_attempt_pending",
                    "current_attempt_success",
                    "older_rerun_newer_pending",
                )
                or (defect == "late_attempt" and checks_read >= 8)
            ):
                detail["run_attempt"] = 2
            return detail
        raise AssertionError(path)

    monkeypatch.setattr(gate, "gh_json", fake_gh)
    expected = {
        "missing": "required job missing or ambiguous",
        "duplicate": "required job missing or ambiguous",
        "wrong_head": "required job source mismatch",
        "wrong_app": "required check source or state mismatch",
        "truncated": "pagination incomplete",
        "race": "required check evidence changed",
        "attempt": "required job source mismatch",
        "late_attempt": "workflow run or required check evidence changed",
        "late_run": "workflow run or required check evidence changed",
        "missing_event": "workflow run event missing",
        "wrong_workflow": "workflow run source mismatch",
        "missing_pr": "workflow run PR association missing",
        "wrong_repo": "workflow run PR source mismatch",
        "wrong_suite": "required check source or state mismatch",
        "wrong_check_id": "required check source or state mismatch",
        "wrong_url": "invalid check URL",
        "equal_sequence": "ambiguous eligible run",
        "changed_check": "required check source or state mismatch",
        "consistent_transition": "required check evidence changed",
    }
    if defect in expected:
        with pytest.raises(RuntimeError, match=expected[defect]):
            gate.collect_required_checks("owner/repo", 252, SHA)
    else:
        checks = gate.collect_required_checks("owner/repo", 252, SHA)
        if defect == "current_attempt_success":
            assert all(row["state"] == "SUCCESS" for row in checks)
        else:
            assert any(row["state"] != "SUCCESS" for row in checks)


@pytest.mark.parametrize(
    "pages",
    [
        [{"total_count": 2, "jobs": [{"id": 1}]}, {"total_count": 3, "jobs": [{"id": 2}]}],
        [{"total_count": 2, "jobs": [{"id": 1}]}, {"total_count": 2, "jobs": [{"id": 1}]}],
        [{"total_count": True, "jobs": []}],
        [{"total_count": 1000, "jobs": []}],
    ],
)
def test_job_pagination_rejects_ambiguous_collections(monkeypatch: Any, pages: Any) -> None:
    monkeypatch.setattr(gate, "gh_json", lambda *_: pages)
    with pytest.raises(RuntimeError, match="jobs"):
        gate._complete_pages("owner/repo", "jobs", "jobs")


def test_job_pagination_accepts_complete_multiple_pages(monkeypatch: Any) -> None:
    pages = [{"total_count": 2, "jobs": [{"id": 1}]}, {"total_count": 2, "jobs": [{"id": 2}]}]
    monkeypatch.setattr(gate, "gh_json", lambda *_: pages)
    assert gate._complete_pages("owner/repo", "jobs", "jobs") == [{"id": 1}, {"id": 2}]


@pytest.mark.parametrize("case", ["blocked", "api_error", "pass"])
def test_cli_receipt_guards_merge_stand_in(
    monkeypatch: Any, capsys: Any, tmp_path: Any, case: str
) -> None:
    monkeypatch.setattr(
        gate.sys,
        "argv",
        [
            "poteto_issue_gate.py",
            "--repo",
            "owner/repo",
            "--pr",
            "252",
            "--issue",
            "251",
            "--claim-token",
            TOKEN,
            "--wont-do",
            "0",
        ],
    )

    def collect(*_args: Any) -> dict[str, Any]:
        if case == "api_error":
            raise RuntimeError("HTTP 503")
        if case == "blocked":
            return {
                "mergeable": False,
                "head_sha": SHA,
                "blockers": ["required check not successful"],
            }
        return {"mergeable": True, "head_sha": SHA, "blockers": []}

    monkeypatch.setattr(gate, "collect_gate", collect)
    status = gate.main()
    receipt = json.loads(capsys.readouterr().out)
    marker = tmp_path / "merge-stand-in"
    if (
        status == 0
        and receipt.get("mergeable") is True
        and receipt.get("head_sha") == SHA
        and receipt.get("blockers") == []
    ):
        marker.write_text("invoked")
    assert marker.exists() is (case == "pass")
    if case == "api_error":
        assert receipt == {"mergeable": False, "head_sha": None, "blockers": ["HTTP 503"]}
    assert status == (0 if case == "pass" else 1)
