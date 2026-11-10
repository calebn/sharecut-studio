"""Issues referenced by PRs merged to develop close once, with the guards the issue lists."""

from __future__ import annotations

import re
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
    number: int, body: str = "", *, title: str = "t", base: str = "develop", merged: bool = True
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
    def __init__(self, issues=None, pulls=None, commits=None, comments=None) -> None:
        self.issues = issues or {}
        self.pulls = pulls or {}
        self.commits = commits or []
        self.comments: dict[int, list[str]] = comments or {}
        self.closed: list[int] = []
        self.range_args: tuple[str, str] | None = None

    def commits_in_range(self, before: str, after: str) -> list[str]:
        self.range_args = (before, after)
        return [after] if before == cod.ZERO_SHA else self.commits

    def pulls_for_commit(self, sha: str) -> list[Mapping[str, Any]]:
        return self.pulls.get(sha, [])

    def issue(self, number: int):
        return self.issues.get(number)

    def comment_bodies(self, number: int) -> list[str]:
        return self.comments.get(number, [])

    def comment(self, number: int, body: str) -> None:
        self.comments.setdefault(number, []).append(body)

    def close(self, number: int) -> None:
        self.closed.append(number)


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


def test_plan_closes_open_issue_and_comments_with_marker() -> None:
    client = FakeClient(
        issues={5: open_issue()}, commits=["c1"], pulls={"c1": [pr(10, "Fixes #5")]}
    )
    cod.run(client, repo=REPO, before="a", after="b", base="develop", dry_run=False)
    assert client.closed == [5]
    (body,) = client.comments[5]
    assert "#10" in body and "sha10" in body and cod.marker(10) in body


def test_title_counts_as_well_as_body() -> None:
    client = FakeClient(
        issues={5: open_issue()}, commits=["c1"], pulls={"c1": [pr(10, title="Fixes #5")]}
    )
    cod.run(client, repo=REPO, before="a", after="b", base="develop", dry_run=False)
    assert client.closed == [5]


@pytest.mark.parametrize("label", ["needs-user-input", "owner-check"])
def test_opt_out_labels_skip(label: str) -> None:
    client = FakeClient(
        issues={5: open_issue("bug", label)}, commits=["c"], pulls={"c": [pr(1, "Fixes #5")]}
    )
    cod.run(client, repo=REPO, before="a", after="b", base="develop", dry_run=False)
    assert client.closed == [] and client.comments == {}


def test_pull_request_numbers_missing_and_closed_issues_skip() -> None:
    client = FakeClient(
        issues={5: open_issue(is_pr=True), 6: open_issue(state="closed")},
        commits=["c"],
        pulls={"c": [pr(1, "Fixes #5 fixes #6 fixes #404")]},
    )
    cod.run(client, repo=REPO, before="a", after="b", base="develop", dry_run=False)
    assert client.closed == [] and client.comments == {}


def test_rerun_adds_no_second_comment_and_finishes_a_half_done_close() -> None:
    client = FakeClient(issues={5: open_issue()}, commits=["c"], pulls={"c": [pr(1, "Fixes #5")]})
    cod.run(client, repo=REPO, before="a", after="b", base="develop", dry_run=False)
    assert len(client.comments[5]) == 1
    # The close failed after the comment: the issue is still open on the re-run.
    cod.run(client, repo=REPO, before="a", after="b", base="develop", dry_run=False)
    assert len(client.comments[5]) == 1
    assert client.closed == [5, 5]
    client.issues[5] = open_issue(state="closed")
    cod.run(client, repo=REPO, before="a", after="b", base="develop", dry_run=False)
    assert client.closed == [5, 5]


def test_dry_run_writes_nothing() -> None:
    client = FakeClient(issues={5: open_issue()}, commits=["c"], pulls={"c": [pr(1, "Fixes #5")]})
    cod.run(client, repo=REPO, before="a", after="b", base="develop", dry_run=True)
    assert client.closed == [] and client.comments == {}


def test_range_dedupes_prs_and_keeps_only_merged_prs_into_base() -> None:
    same = pr(1, "Fixes #5")
    client = FakeClient(
        issues={5: open_issue(), 6: open_issue(), 7: open_issue()},
        commits=["c1", "c2", "c3", "c4"],
        pulls={
            "c1": [same],
            "c2": [same],
            "c3": [pr(2, "Fixes #6", base="main")],
            "c4": [pr(3, "Fixes #7", merged=False)],
        },
    )
    cod.run(client, repo=REPO, before="a", after="b", base="develop", dry_run=False)
    assert client.closed == [5]
    assert len(client.comments[5]) == 1


def test_two_prs_referencing_one_issue_comment_once() -> None:
    client = FakeClient(
        issues={5: open_issue()},
        commits=["c1", "c2"],
        pulls={"c1": [pr(1, "Fixes #5")], "c2": [pr(2, "Closes #5")]},
    )
    cod.run(client, repo=REPO, before="a", after="b", base="develop", dry_run=False)
    assert client.closed == [5]
    assert len(client.comments[5]) == 1


def test_first_push_uses_only_the_after_commit() -> None:
    client = FakeClient(issues={5: open_issue()}, pulls={"b": [pr(1, "Fixes #5")]})
    cod.run(client, repo=REPO, before=cod.ZERO_SHA, after="b", base="develop", dry_run=False)
    assert client.range_args == (cod.ZERO_SHA, "b")
    assert client.closed == [5]


def test_main_reads_range_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REPO", REPO)
    monkeypatch.setenv("BEFORE", "")
    monkeypatch.setenv("AFTER", "b")
    monkeypatch.setenv("DRY_RUN", "true")
    client = FakeClient(issues={5: open_issue()}, pulls={"b": [pr(1, "Fixes #5")]})
    assert cod.main([], client=client) == 0
    assert client.range_args == (cod.ZERO_SHA, "b")
    assert client.closed == []


def test_workflow_triggers_permissions_and_untrusted_text_handling() -> None:
    data = load_github_yaml(WORKFLOW)
    triggers = data["on"]
    assert triggers["push"]["branches"] == ["develop"]
    assert set(triggers) == {"push", "workflow_dispatch"}
    assert set(triggers["workflow_dispatch"]["inputs"]) == {"before", "after", "dry-run"}
    assert data["permissions"] == {"issues": "write", "contents": "read", "pull-requests": "read"}
    assert data["concurrency"]["cancel-in-progress"] is False
    steps = data["jobs"]["close"]["steps"]
    assert steps[0]["uses"] == "actions/checkout@v7"
    run_steps = [step for step in steps if "run" in step]
    assert [step["run"] for step in run_steps] == ["python scripts/close_issues_on_develop.py"]
    env = run_steps[0]["env"]
    assert env["GH_TOKEN"] == "${{ github.token }}"
    assert {"BEFORE", "AFTER", "REPO"} <= set(env)
    for step in run_steps:
        assert not re.search(r"\$\{\{\s*(github\.event|inputs)", step["run"])
    assert "pull_request_target" not in WORKFLOW.read_text(encoding="utf-8")
