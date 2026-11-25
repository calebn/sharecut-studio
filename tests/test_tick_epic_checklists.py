"""Epic checklist lines tick from live ref state, never from a close event's payload."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from github_yaml import load_github_yaml
from script_loader import load_script

tec = load_script("tick_epic_checklists", register=True)

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "tick-epic-checklists.yml"
REPO = "calebn/sharecut-studio"

PHASE_4 = "- [ ] Phase 4 typed service results: #1811"
PHASE_2 = (
    "- [ ] Phase 2 one mutation entry and one committer: #1809 (partial: closed as superseded; "
    "#1824, #1842, #1848 and #1847 merged; #1849 words_revision, history behind the workspace "
    "and transcript tool move still open)"
)
CI_1446 = (
    "- [ ] #1446 Tests never wait on time (existing; the issue says it cuts CI cost, "
    "pairs with #1441 and #1410)"
)
POST_BETA = "- [ ] #1089 per-track timing map (post-beta)"
LEDGER = "- [ ] _(none yet)_"
COORDINATE = (
    "- [ ] 3. Role and permission vocabulary is defined about 14 times and the UI compares role "
    "strings 59 times. Fix: generate roles and the capability table for the frontend from "
    "`share_capabilities.py`; UI asks `can(capability)`; lint bans role-literal compares. "
    "Coordinate with #2729."
)
PRODUCER_LOBBY = (
    "- [ ] Producer lobby (SCR-REC-LOBBY-PRODUCER): producer preview merged (#3928, #3941, #3980)"
)
FLAKES = "- [ ] #1267, #1360, #1418 flakes"
SEE_ALSO = "- [ ] #10 foo; see #11"


def tick(body: str, states: Mapping[int, str]) -> tuple[str, list]:
    return tec.tick_body(body, states, REPO)


def done(*numbers: int) -> dict[int, str]:
    return {number: "done" for number in numbers}


def test_trailing_label_ref_ticks_only_when_done() -> None:
    assert tick(PHASE_4, {1811: "done"}) == (PHASE_4.replace("[ ]", "[x]"), [tec.Tick(1, (1811,))])
    assert tick(PHASE_4, {1811: "open"}) == (PHASE_4, [])
    assert tick(PHASE_4, {}) == (PHASE_4, [])


def test_partial_line_never_ticks_even_with_every_ref_done() -> None:
    assert tick(PHASE_2, done(1809, 1824, 1842, 1848, 1847, 1849)) == (PHASE_2, [])


def test_every_ref_on_the_line_must_be_done() -> None:
    assert tick(CI_1446, {1446: "open", 1441: "done", 1410: "done"}) == (CI_1446, [])
    assert tick(CI_1446, done(1446, 1441, 1410)) == (
        CI_1446.replace("[ ]", "[x]"),
        [tec.Tick(1, (1410, 1441, 1446))],
    )


def test_dead_and_ledger_lines_stay_open() -> None:
    body = f"{POST_BETA}\n{LEDGER}"
    assert tick(body, {1089: "dead"}) == (body, [])


def test_a_ref_after_the_leading_position_does_not_own_the_line() -> None:
    assert tick(COORDINATE, {2729: "done"}) == (COORDINATE, [])
    assert tick(PRODUCER_LOBBY, done(3928, 3941, 3980)) == (PRODUCER_LOBBY, [])


def test_a_trailing_open_ref_blocks_the_tick() -> None:
    assert tick(SEE_ALSO, {10: "done", 11: "open"}) == (SEE_ALSO, [])
    assert tick(SEE_ALSO, done(10, 11))[0] == "- [x] #10 foo; see #11"


def test_comma_list_ticks_only_when_all_done() -> None:
    assert tick(FLAKES, {1267: "done", 1360: "done", 1418: "open"}) == (FLAKES, [])
    assert tick(FLAKES, done(1267, 1360, 1418)) == (
        "- [x] #1267, #1360, #1418 flakes",
        [tec.Tick(1, (1267, 1360, 1418))],
    )


@pytest.mark.parametrize(
    "body",
    [
        f"```\n{PHASE_4}\n```",
        f"~~~\n{PHASE_4}\n~~~",
        f"```\n{PHASE_4}",
        f"<!--\n{PHASE_4}\n-->",
        f"<!-- {PHASE_4} -->",
        "- [ ] #5 other/repo#6",
        "- [ ] `#5` thing",
    ],
)
def test_hidden_or_foreign_lines_stay_unchanged(body: str) -> None:
    assert tick(body, done(1811, 5, 6)) == (body, [])


def test_text_after_a_closed_fence_ticks() -> None:
    assert (
        tick(f"```\nx\n```\n{PHASE_4}", done(1811))[0]
        == f"```\nx\n```\n{PHASE_4.replace('[ ]', '[x]')}"
    )


def test_checked_lines_are_never_touched_and_ticking_is_idempotent() -> None:
    checked = "- [x] #1920 Trim Python dependency setup"
    body = f"{checked}\n{PHASE_4}\r\n- [ ] #5 b\r\n"
    new, ticks = tick(body, done(1920, 1811, 5))
    assert new == f"{checked}\n{PHASE_4.replace('[ ]', '[x]')}\r\n- [x] #5 b\r\n"
    assert ticks == [tec.Tick(2, (1811,)), tec.Tick(3, (5,))]
    assert tick(new, done(1920, 1811, 5)) == (new, [])


def test_pending_refs_are_the_refs_of_visible_candidate_lines() -> None:
    body = f"{PHASE_4}\n```\n- [ ] #9 x\n```\n{CI_1446}\n{PHASE_2}\n- [x] #8 y"
    assert tec.pending_refs(body, REPO) == {1811, 1446, 1441, 1410}


def pull_request(merged: bool, state: str = "closed") -> dict:
    return {
        "state": state,
        "pull_request": {"merged_at": "2026-11-10T00:00:00Z" if merged else None},
    }


@pytest.mark.parametrize(
    ("issue", "expected"),
    [
        (pull_request(True), "done"),
        (pull_request(False), "dead"),
        (pull_request(False, state="open"), "open"),
        ({"state": "closed", "state_reason": "completed"}, "done"),
        ({"state": "closed", "state_reason": "not_planned"}, "dead"),
        ({"state": "closed", "state_reason": "duplicate"}, "dead"),
        ({"state": "open", "state_reason": None}, "open"),
        (None, "open"),
    ],
)
def test_ref_state(issue: dict | None, expected: str) -> None:
    assert tec.ref_state(issue) == expected


class FakeClient:
    def __init__(
        self, epics: list[dict], issues: dict[int, dict | None], pulls: dict | None = None
    ) -> None:
        self.epics = {epic["number"]: epic["body"] for epic in epics}
        self.issues = issues
        self.pulls = pulls or {}
        self.patches: list[tuple[int, str]] = []
        self.fail: set[int] = set()
        self.edit_on_refetch: dict[int, str] = {}

    def open_epics(self) -> list[Mapping[str, Any]]:
        return [{"number": n, "body": body} for n, body in self.epics.items()]

    def issue(self, number: int) -> Mapping[str, Any] | None:
        if number in self.epics:
            if number in self.fail:
                raise RuntimeError("boom")
            if number in self.edit_on_refetch:
                self.epics[number] = self.edit_on_refetch.pop(number)
            return {"number": number, "state": "open", "body": self.epics[number]}
        return self.issues.get(number)

    def pull(self, number: int) -> Mapping[str, Any]:
        return self.pulls[number]

    def patch_body(self, number: int, body: str) -> None:
        self.patches.append((number, body))
        self.epics[number] = body


def closed(reason: str = "completed") -> dict:
    return {"state": "closed", "state_reason": reason}


def go(
    client: FakeClient, *, dry_run: bool = False, pr_number: int | None = None, sleep=lambda _: None
) -> int:
    return tec.run(client, repo=REPO, pr_number=pr_number, dry_run=dry_run, sleep=sleep)


def test_run_patches_the_ticked_body(capsys: pytest.CaptureFixture[str]) -> None:
    client = FakeClient(
        [{"number": 1807, "body": f"intro\n{PHASE_4}\n{PHASE_2}"}], {1811: closed()}
    )
    assert go(client) == 0
    assert client.patches == [(1807, f"intro\n{PHASE_4.replace('[ ]', '[x]')}\n{PHASE_2}")]
    assert "ticked #1807 line 2: - [ ] Phase 4" in capsys.readouterr().out


def test_dry_run_prints_and_never_patches(capsys: pytest.CaptureFixture[str]) -> None:
    client = FakeClient([{"number": 1807, "body": PHASE_4}], {1811: closed()})
    assert go(client, dry_run=True) == 0
    assert client.patches == []
    assert capsys.readouterr().out == f"would tick #1807 line 1: {PHASE_4}\n"


def test_no_ticks_means_no_patch() -> None:
    client = FakeClient([{"number": 1807, "body": PHASE_4}], {1811: {"state": "open"}})
    assert go(client) == 0
    assert client.patches == []


def test_a_body_edited_mid_run_is_recomputed_not_overwritten() -> None:
    client = FakeClient([{"number": 1807, "body": PHASE_4}], {1811: closed(), 1813: closed()})
    client.edit_on_refetch[1807] = f"{PHASE_4}\n- [ ] Phase 6 cut pipeline DAG: #1813"
    assert go(client) == 0
    assert client.patches == [
        (1807, f"{PHASE_4.replace('[ ]', '[x]')}\n- [x] Phase 6 cut pipeline DAG: #1813")
    ]


def test_closer_race_waits_eight_times_then_leaves_the_line_open() -> None:
    pulls = {7: {"number": 7, "body": "Fixes #1811"}}
    client = FakeClient([{"number": 1807, "body": PHASE_4}], {1811: {"state": "open"}}, pulls)
    sleeps: list[float] = []
    assert go(client, pr_number=7, sleep=sleeps.append) == 0
    assert sleeps == [15] * 8
    assert client.patches == []


def test_closer_race_resolved_before_the_limit_ticks() -> None:
    pulls = {7: {"number": 7, "body": "Fixes #1811"}}
    client = FakeClient([{"number": 1807, "body": PHASE_4}], {1811: {"state": "open"}}, pulls)
    sleeps: list[float] = []

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        client.issues[1811] = closed()

    assert go(client, pr_number=7, sleep=sleep) == 0
    assert sleeps == [15]
    assert [number for number, _ in client.patches] == [1807]


def test_one_failing_epic_does_not_stop_the_rest(capsys: pytest.CaptureFixture[str]) -> None:
    client = FakeClient(
        [{"number": 1, "body": PHASE_4}, {"number": 2, "body": PHASE_4}], {1811: closed()}
    )
    client.fail = {1}
    assert go(client) == 1
    assert [number for number, _ in client.patches] == [2]
    assert "::error::could not tick #1: boom" in capsys.readouterr().out


def test_live_epic_shapes_tick_exactly_the_closed_children(
    capsys: pytest.CaptureFixture[str],
) -> None:
    body = f"## Children\n\n- [ ] #1914 Stop running\n{CI_1446}\n- [ ] #1409 Trim e2e\n"
    client = FakeClient(
        [{"number": 1913, "body": body}],
        {1914: closed(), 1409: closed(), 1446: {"state": "open"}, 1441: closed(), 1410: closed()},
    )
    assert go(client, dry_run=True) == 0
    assert capsys.readouterr().out.splitlines() == [
        "would tick #1913 line 3: - [ ] #1914 Stop running",
        "would tick #1913 line 5: - [ ] #1409 Trim e2e",
    ]


def test_main_reads_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    client = FakeClient([{"number": 1807, "body": PHASE_4}], {1811: closed()})
    monkeypatch.setenv("REPO", REPO)
    monkeypatch.setenv("DRY_RUN", "true")
    monkeypatch.delenv("PR_NUMBER", raising=False)
    assert tec.main([], client=client) == 0
    assert client.patches == []
    monkeypatch.setenv("DRY_RUN", "false")
    monkeypatch.setenv("PR_NUMBER", "")
    assert tec.main([], client=client) == 0
    assert [number for number, _ in client.patches] == [1807]


class Proc:
    def __init__(self, stdout: str = "", returncode: int = 0, stderr: str = "") -> None:
        self.stdout, self.returncode, self.stderr = stdout, returncode, stderr


def test_gh_client_lists_open_epics_without_pull_requests_and_patches_the_body() -> None:
    calls: list[list[str]] = []

    def runner(cmd: list[str], **_: Any) -> Proc:
        calls.append(cmd)
        return Proc('[[{"number": 1, "body": "a"}, {"number": 2, "pull_request": {}}]]')

    client = tec.GhClient(REPO, runner)
    assert client.open_epics() == [{"number": 1, "body": "a"}]
    assert calls[0][-1] == f"repos/{REPO}/issues?labels=epic&state=open&per_page=100"
    client.patch_body(1, "new")
    assert calls[1] == ["gh", "api", "-X", "PATCH", f"repos/{REPO}/issues/1", "-f", "body=new"]


def test_workflow_triggers_guards_permissions_and_group() -> None:
    data = load_github_yaml(WORKFLOW)
    assert data["on"]["issues"] == {"types": ["closed"]}
    assert data["on"]["pull_request"]["types"] == ["closed"]
    assert data["on"]["pull_request"]["branches"] == [tec.closer.branches.base()]
    assert data["on"]["schedule"] == [{"cron": "53 5 * * 1"}]
    assert data["on"]["workflow_dispatch"]["inputs"]["pr"]["required"] is False
    assert data["on"]["workflow_dispatch"]["inputs"]["dry-run"]["default"] is True
    assert data["permissions"] == {"issues": "write", "contents": "read", "pull-requests": "read"}
    assert data["concurrency"] == {"group": "tick-epic-checklists", "cancel-in-progress": False}
    job = data["jobs"]["tick"]
    assert job["timeout-minutes"] == 10
    assert "github.event.issue.state_reason == 'completed'" in job["if"]
    assert "github.event.pull_request.merged == true" in job["if"]
    assert "github.event.pull_request.head.repo.full_name == github.repository" in job["if"]
    assert "pull_request_target" not in data["on"]
