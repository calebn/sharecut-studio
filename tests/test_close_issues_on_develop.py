"""Issues referenced by PRs merged to develop close once, with the guards the issue lists."""

from __future__ import annotations

import json
import re
import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from github_yaml import load_github_yaml
from script_loader import load_script

cod = load_script("close_issues_on_develop", register=True)

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "close-issues-on-develop.yml"
REPO = "calebn/sharecut-studio"


def pr(
    number: int = 10,
    body: str = "",
    *,
    title: str = "t",
    base: str = "develop",
    merged: bool = True,
):
    return {
        "number": number,
        "title": title,
        "body": body,
        "base": {"ref": base},
        "merged_at": "2026-11-10T00:00:00Z" if merged else None,
        "merge_commit_sha": f"sha{number}",
    }


class FakeClient:
    def __init__(self, pull: Mapping[str, Any], issues=None, comments=None) -> None:
        self._pull = pull
        self.issues = issues or {}
        self.comments: dict[int, list[str]] = comments or {}
        self.closed: list[int] = []
        self.fail_comment: set[int] = set()

    def pull(self, number: int) -> Mapping[str, Any]:
        return self._pull

    def issue(self, number: int):
        return self.issues.get(number)

    def comment_bodies(self, number: int) -> list[str]:
        return self.comments.get(number, [])

    def comment(self, number: int, body: str) -> None:
        if number in self.fail_comment:
            raise RuntimeError("boom")
        self.comments.setdefault(number, []).append(body)

    def close(self, number: int) -> None:
        self.closed.append(number)


def go(client: FakeClient, *, dry_run: bool = False, base: str = "develop") -> int:
    return cod.run(client, repo=REPO, pr_number=10, base=base, dry_run=dry_run)


def open_issue(*labels: str, state: str = "open", is_pr: bool = False) -> dict:
    data: dict = {"state": state, "labels": [{"name": n} for n in labels]}
    if is_pr:
        data["pull_request"] = {}
    return data


@pytest.mark.parametrize(
    "keyword",
    ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"],
)
@pytest.mark.parametrize("form", ["{} #7", "{}: #7", "{} {}#7"])
def test_every_closing_keyword_form_counts(keyword: str, form: str) -> None:
    text = form.format(keyword, REPO) if form.count("{}") == 2 else form.format(keyword)
    assert cod.closing_refs(text, REPO) == {7}
    assert cod.closing_refs(text.upper(), REPO) == {7}


def test_only_closing_keywords_and_this_repo_count() -> None:
    text = "Part of #1. Refs #2. See #3. Fixes #4, closes other/repo#5, Resolves CALEBN/Sharecut-Studio#6 prefix #8"
    assert cod.closing_refs(text, REPO) == {4, 6}
    assert cod.closing_refs(None, REPO) == set()
    assert cod.closing_refs("Fixes#9 and prefixes #10", REPO) == set()


def test_code_comments_and_quotes_are_ignored() -> None:
    text = "\n".join(
        [
            "Fixes #1",
            "```",
            "Fixes #2",
            "```",
            "~~~py",
            "fixes #3",
            "~~~",
            "`fixes #4` and ``closes #5`` <!-- fixes #6 -->",
            "> fixes #7",
            "<!-- multi",
            "fixes #8 -->",
            "closes #9",
        ]
    )
    assert cod.closing_refs(text, REPO) == {1, 9}


def test_negation_is_not_understood() -> None:
    assert cod.closing_refs("This does not fix #5", REPO) == {5}


def test_title_is_ignored() -> None:
    client = FakeClient(pr(title="Fixes #5", body=""), issues={5: open_issue()})
    assert go(client) == 0
    assert client.closed == []


def test_closes_open_issue_and_comments_with_marker() -> None:
    client = FakeClient(pr(body="Fixes #5"), issues={5: open_issue()})
    assert go(client) == 0
    assert client.closed == [5]
    (body,) = client.comments[5]
    assert "#10" in body and "sha10" in body and cod.marker(10) in body


@pytest.mark.parametrize("label", ["needs-user-input", "owner-check"])
def test_opt_out_labels_skip(label: str) -> None:
    client = FakeClient(pr(body="Fixes #5"), issues={5: open_issue("bug", label)})
    go(client)
    assert client.closed == [] and client.comments == {}


def test_pull_requests_missing_and_closed_issues_skip() -> None:
    client = FakeClient(
        pr(body="Fixes #5 fixes #6 fixes #404"),
        issues={5: open_issue(is_pr=True), 6: open_issue(state="closed")},
    )
    assert go(client) == 0
    assert client.closed == [] and client.comments == {}


@pytest.mark.parametrize(
    "pull", [pr(body="Fixes #5", merged=False), pr(body="Fixes #5", base="main")]
)
def test_unmerged_or_wrong_base_pr_is_a_no_op(pull: dict) -> None:
    client = FakeClient(pull, issues={5: open_issue()})
    assert go(client) == 0
    assert client.closed == []


def test_rerun_adds_no_second_comment_and_finishes_a_half_done_close() -> None:
    client = FakeClient(pr(body="Fixes #5"), issues={5: open_issue()})
    go(client)
    go(client)  # the issue is still open in the fake: close again, no new comment
    assert len(client.comments[5]) == 1
    assert client.closed == [5, 5]
    client.issues[5] = open_issue(state="closed")
    go(client)
    assert client.closed == [5, 5]


def test_dry_run_writes_nothing() -> None:
    client = FakeClient(pr(body="Fixes #5"), issues={5: open_issue()})
    assert go(client, dry_run=True) == 0
    assert client.closed == [] and client.comments == {}


def test_one_failure_does_not_stop_the_rest_and_fails_the_run(
    capsys: pytest.CaptureFixture[str],
) -> None:
    client = FakeClient(pr(body="Fixes #5, fixes #6"), issues={5: open_issue(), 6: open_issue()})
    client.fail_comment.add(5)
    assert go(client) == 1
    assert client.closed == [6]
    assert "::error::" in capsys.readouterr().out


def test_unreadable_issue_fails_the_run_but_not_the_others() -> None:
    class Flaky(FakeClient):
        def issue(self, number: int):
            if number == 5:
                raise RuntimeError("HTTP 502")
            return super().issue(number)

    client = Flaky(pr(body="Fixes #5, fixes #6"), issues={6: open_issue()})
    assert go(client) == 1
    assert client.closed == [6]


def test_main_reads_the_pr_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REPO", REPO)
    monkeypatch.setenv("PR_NUMBER", "10")
    monkeypatch.setenv("DRY_RUN", "true")
    client = FakeClient(pr(body="Fixes #5"), issues={5: open_issue()})
    assert cod.main([], client=client) == 0
    assert client.closed == []


class Runner:
    """Stands in for subprocess.run: answers by the endpoint (the last arg) it is asked for."""

    def __init__(self, replies: dict[str, tuple[int, str, str]]) -> None:
        self.replies = replies
        self.calls: list[list[str]] = []

    def __call__(self, cmd: list[str], **_: Any) -> subprocess.CompletedProcess[str]:
        self.calls.append(cmd)
        key = next((arg for arg in cmd if arg.startswith("repos/")), "")
        code, out, err = self.replies.get(key, (0, "{}", ""))
        return subprocess.CompletedProcess(cmd, code, out, err)


def test_gh_client_issue_treats_only_http_404_as_missing() -> None:
    runner = Runner(
        {
            f"repos/{REPO}/issues/1": (1, "", "gh: Not Found (HTTP 404)"),
            f"repos/{REPO}/issues/2": (1, "", "gh: Bad Gateway (HTTP 502) req 4042"),
            f"repos/{REPO}/issues/3": (0, '{"state": "open", "labels": []}', ""),
        }
    )
    client = cod.GhClient(REPO, run=runner)
    assert client.issue(1) is None
    with pytest.raises(RuntimeError, match="502"):
        client.issue(2)
    assert client.issue(3) == {"state": "open", "labels": []}


def test_gh_client_pull_feeds_the_merged_and_base_guards() -> None:
    payloads = {
        1: pr(1, "Fixes #5"),
        2: pr(2, "Fixes #5", merged=False),
        3: pr(3, "Fixes #5", base="main"),
    }
    runner = Runner(
        {f"repos/{REPO}/pulls/{n}": (0, json.dumps(p), "") for n, p in payloads.items()}
    )
    client = cod.GhClient(REPO, run=runner)
    for number in payloads:
        assert client.pull(number) == payloads[number]
    assert cod.run(client, repo=REPO, pr_number=2, base="develop", dry_run=False) == 0
    assert cod.run(client, repo=REPO, pr_number=3, base="develop", dry_run=False) == 0
    assert not any("PATCH" in call for call in runner.calls)


def test_gh_client_writes_send_the_documented_payloads() -> None:
    runner = Runner({})
    client = cod.GhClient(REPO, run=runner)
    body = cod.comment_body(pr(10))
    client.comment(5, body)
    client.close(5)
    post, patch = runner.calls
    assert post[:4] == ["gh", "api", "-X", "POST"] and post[-1] == f"body={body}"
    assert cod.marker(10) in post[-1]
    assert patch[3] == "PATCH"
    assert "state=closed" in patch and "state_reason=completed" in patch


def test_workflow_triggers_permissions_and_untrusted_text_handling() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")
    data = load_github_yaml(WORKFLOW)
    triggers = data["on"]
    assert set(triggers) == {"pull_request", "workflow_dispatch"}
    assert triggers["pull_request"] == {"types": ["closed"], "branches": ["develop"]}
    inputs = triggers["workflow_dispatch"]["inputs"]
    assert set(inputs) == {"pr", "dry-run"}
    assert inputs["pr"]["required"] is True and inputs["dry-run"]["default"] is True
    assert data["permissions"] == {"issues": "write", "contents": "read", "pull-requests": "read"}
    assert data["concurrency"]["cancel-in-progress"] is False
    job = data["jobs"]["close"]
    assert "github.event.pull_request.merged == true" in job["if"]
    steps = job["steps"]
    assert steps[0]["uses"] == "actions/checkout@v7"
    run_steps = [step for step in steps if "run" in step]
    assert [step["run"] for step in run_steps] == ["python scripts/close_issues_on_develop.py"]
    env = run_steps[0]["env"]
    assert env["GH_TOKEN"] == "${{ github.token }}"
    assert {"PR_NUMBER", "REPO", "DRY_RUN"} <= set(env)
    assert not re.search(r"github\.event\.pull_request\.(title|body)", text)
    assert "pull_request_target" not in text
    for step in run_steps:
        assert "${{" not in step["run"]
