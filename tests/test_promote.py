"""scripts/promote.py against a temporary bare origin and a scripted GitHub."""

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from script_loader import load_script

promote = load_script("promote", register=True)

REQUIRED = ["pytest", "frontend", "frontend-e2e", "gitleaks-history"]
GREEN = ("completed", "success")


def sh(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


def commit(cwd: Path, name: str) -> str:
    (cwd / name).write_text(name)
    sh(cwd, "add", name)
    sh(cwd, "commit", "-q", "-m", name)
    return sh(cwd, "rev-parse", "HEAD")


@dataclass
class Repo:
    origin: Path
    clone: Path
    other: Path

    def remote_sha(self, branch: str) -> str | None:
        out = sh(self.origin, "for-each-ref", "--format=%(objectname)", f"refs/heads/{branch}")
        return out or None

    def remote_branches(self) -> list[str]:
        return sh(self.origin, "for-each-ref", "--format=%(refname:short)", "refs/heads").split()

    def advance(self, branch: str) -> str:
        sh(self.other, "fetch", "-q", "origin")
        sh(self.other, "checkout", "-q", "-B", branch, f"origin/{branch}")
        sha = commit(
            self.other, f"{branch}-{len(self.remote_branches())}-{self.remote_sha(branch)}"
        )
        sh(self.other, "push", "-q", "origin", f"{branch}:{branch}")
        return sha


@pytest.fixture
def repo(tmp_path: Path, monkeypatch) -> Repo:
    monkeypatch.setenv("SHARECUT_BASE_BRANCH", "develop")
    monkeypatch.delenv("GITHUB_REF", raising=False)
    origin = tmp_path / "origin.git"
    sh(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    seed = tmp_path / "seed"
    sh(tmp_path, "init", "-q", "-b", "main", str(seed))
    sh(seed, "config", "user.email", "t@example.com")
    sh(seed, "config", "user.name", "t")
    commit(seed, "one")
    sh(seed, "remote", "add", "origin", str(origin))
    sh(seed, "push", "-q", "origin", "main")
    sh(seed, "checkout", "-q", "-b", "develop")
    commit(seed, "two")
    sh(seed, "push", "-q", "origin", "develop")
    clone = tmp_path / "clone"
    sh(tmp_path, "clone", "-q", str(origin), str(clone))
    sh(clone, "config", "user.email", "t@example.com")
    sh(clone, "config", "user.name", "t")
    other = tmp_path / "other"
    sh(tmp_path, "clone", "-q", str(origin), str(other))
    sh(other, "config", "user.email", "t@example.com")
    sh(other, "config", "user.name", "t")
    assert sh(clone, "remote", "get-url", "origin") == str(origin)
    assert Path(sh(clone, "remote", "get-url", "origin")).is_relative_to(tmp_path)
    return Repo(origin, clone, other)


@dataclass
class FakeGh:
    outcomes: Mapping[str, tuple[str, str | None]] = field(default_factory=dict)
    jobs_by_workflow: Mapping[str, Mapping[str, str | None]] = field(default_factory=dict)
    missing: frozenset[str] = frozenset()
    fail_dispatch: frozenset[str] = frozenset()
    on_poll: Callable[[], None] | None = None
    dispatched: list[tuple[str, str, dict[str, str]]] = field(default_factory=list)
    polls: list[tuple[str, str, str]] = field(default_factory=list)
    cancelled: list[int] = field(default_factory=list)

    def dispatch(self, workflow: str, ref: str, inputs: Mapping[str, str]) -> None:
        if workflow in self.fail_dispatch and not ref.startswith("promote/"):
            raise subprocess.CalledProcessError(1, "gh", stderr="boom")
        self.dispatched.append((workflow, ref, dict(inputs)))

    def run_id(self, workflow: str) -> int:
        return 1000 + promote.CI_WORKFLOWS.index(workflow)

    def runs(self, workflow: str, branch: str, head_sha: str) -> list:
        self.polls.append((workflow, branch, head_sha))
        if self.on_poll:
            self.on_poll()
        dispatched = any(w == workflow and ref == branch for w, ref, _ in self.dispatched)
        if workflow in self.missing or not dispatched:
            return []
        status, conclusion = self.outcomes.get(workflow, GREEN)
        return [promote.Run(self.run_id(workflow), status, conclusion)]

    def jobs(self, run_id: int) -> list:
        workflow = promote.CI_WORKFLOWS[run_id - 1000]
        default = {
            "test.yml": {"pytest": "success", "frontend": "success", "frontend-e2e": "success"},
            "secret-scan.yml": {"gitleaks-history": "success"},
        }.get(workflow, {})
        jobs = self.jobs_by_workflow.get(workflow, default)
        return [promote.Job(name, conclusion) for name, conclusion in jobs.items()]

    def cancel(self, run_id: int) -> None:
        self.cancelled.append(run_id)

    def deploys(self) -> list[tuple[str, str, dict]]:
        return [
            d
            for d in self.dispatched
            if d[0] == "storybook.yml" and not d[1].startswith("promote/")
        ]

    def ci_dispatches(self) -> list[str]:
        return [
            w
            for w, ref, _ in self.dispatched
            if w in promote.CI_WORKFLOWS and ref.startswith("promote/")
        ]


@dataclass
class FakeClock:
    t: float = 0.0
    slept: float = 0.0

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += seconds
        self.slept += seconds


EPOCH = 1_700_000_000


def go(repo: Repo, gh: FakeGh, *, no_push: bool = False, target: str = "main", timeout=600) -> int:
    clock = FakeClock()
    return promote.promote(
        promote.Git(repo.clone),
        gh,
        target=target,
        no_push=no_push,
        run_id="77",
        attempt="2",
        timeout=timeout,
        interval=60,
        clock=promote.Clock(sleep=clock.sleep, now=clock.now, epoch=lambda: EPOCH),
    )


def test_green_run_fast_forwards_main_and_dispatches_storybook(repo: Repo) -> None:
    develop = repo.remote_sha("develop")
    main_before = repo.remote_sha("main")
    gh = FakeGh()

    assert go(repo, gh) == 0

    assert repo.remote_sha("main") == develop
    branch = f"promote/{develop[:12]}-{EPOCH}-77-2"
    assert gh.ci_dispatches() == list(promote.CI_WORKFLOWS)
    assert {
        ref
        for w, ref, _ in gh.dispatched
        if w in promote.CI_WORKFLOWS and ref.startswith("promote/")
    } == {branch}
    assert dict((w, i) for w, _, i in gh.dispatched)["test.yml"] == {
        "compatibility-base": main_before,
        "compatibility-base-ref": "refs/heads/main",
    }
    assert gh.dispatched[-1] == ("storybook.yml", "main", {})
    assert {(w, b, s) for w, b, s in gh.polls} == {
        (w, branch, develop) for w in promote.CI_WORKFLOWS
    }


def test_no_push_runs_everything_but_leaves_main_alone(repo: Repo, capsys) -> None:
    main_before = repo.remote_sha("main")
    gh = FakeGh()

    assert go(repo, gh, no_push=True) == 0

    assert repo.remote_sha("main") == main_before
    assert gh.ci_dispatches() == list(promote.CI_WORKFLOWS)
    assert gh.deploys() == []
    out = capsys.readouterr().out
    assert f"dry run: would push {repo.remote_sha('develop')}:refs/heads/main" in out
    assert "dry run: would dispatch storybook.yml on main" in out


@pytest.mark.parametrize(
    "outcomes",
    [
        {"desktop.yml": ("completed", "failure")},
        {"test.yml": ("completed", "cancelled")},
        {"secret-scan.yml": ("completed", "skipped")},
        {"registry-backup-windows.yml": ("in_progress", None)},
    ],
)
def test_a_run_that_is_not_green_blocks_the_push(repo: Repo, outcomes) -> None:
    main_before = repo.remote_sha("main")

    assert go(repo, FakeGh(outcomes=outcomes)) == 1

    assert repo.remote_sha("main") == main_before


def test_a_missing_run_blocks_the_push(repo: Repo) -> None:
    main_before = repo.remote_sha("main")
    gh = FakeGh(missing=frozenset({"desktop.yml"}))

    assert go(repo, gh, timeout=180) == 1

    assert repo.remote_sha("main") == main_before


def test_timeout_blocks_the_push_after_polling_until_the_deadline(repo: Repo, capsys) -> None:
    gh = FakeGh(outcomes={"test.yml": ("in_progress", None)})
    main_before = repo.remote_sha("main")

    assert go(repo, gh, timeout=300) == 1

    assert repo.remote_sha("main") == main_before
    assert "timed out" in capsys.readouterr().out
    assert len([p for p in gh.polls if p[0] == "test.yml"]) == 6
    assert gh.cancelled == [gh.run_id("test.yml")]


def test_a_finished_red_run_cancels_nothing(repo: Repo) -> None:
    gh = FakeGh(outcomes={"desktop.yml": ("completed", "failure")})

    assert go(repo, gh) == 1

    assert gh.cancelled == []


def test_job_conclusions_are_keyed_by_workflow_and_name() -> None:
    runs = {
        "test.yml": promote.Run(1, "completed", "success"),
        "secret-scan.yml": promote.Run(2, "completed", "success"),
    }
    jobs = {
        1: [promote.Job("pytest", "success")],
        2: [promote.Job("pytest", "failure"), promote.Job("gitleaks-history", "success")],
    }

    assert promote.failures(runs, jobs, ["pytest", "gitleaks-history"]) == [
        "required job pytest: failure"
    ]


def test_run_refuses_to_start_from_a_ref_other_than_the_release_branch(
    repo: Repo, monkeypatch
) -> None:
    gh = FakeGh()
    monkeypatch.setenv("GITHUB_REF", "refs/heads/feature/x")

    assert promote.main(["run"], git=promote.Git(repo.clone), gh=gh) == 1

    assert gh.dispatched == []


def test_run_starts_from_the_release_branch_ref(repo: Repo, monkeypatch) -> None:
    monkeypatch.setenv("GITHUB_REF", "refs/heads/main")
    monkeypatch.setattr(promote.time, "sleep", lambda _: None)

    assert promote.main(["run", "--no-push"], git=promote.Git(repo.clone), gh=FakeGh()) == 0


def write_fake_gh(directory: Path, responses: Mapping[str, str]) -> Path:
    script = directory / "gh"
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "with open(os.environ['GH_LOG'], 'a') as log:\n"
        "    log.write(json.dumps(sys.argv[1:]) + '\\n')\n"
        f"responses = {dict(responses)!r}\n"
        "key = next((k for k in responses if k in ' '.join(sys.argv[1:])), None)\n"
        "sys.stdout.write(responses.get(key, ''))\n"
    )
    script.chmod(0o755)
    return script


def test_gh_cli_builds_the_expected_calls_and_parses_responses(tmp_path: Path, monkeypatch) -> None:
    runs_body = json.dumps(
        {
            "workflow_runs": [
                {"id": 2, "status": "completed", "conclusion": "success", "created_at": "2"},
                {"id": 1, "status": "in_progress", "conclusion": None, "created_at": "1"},
            ]
        }
    )
    jobs_body = json.dumps(
        [
            {"jobs": [{"name": "pytest", "conclusion": "success"}]},
            {"jobs": [{"name": "frontend", "conclusion": None}]},
        ]
    )
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    write_fake_gh(bin_dir, {"/workflows/": runs_body, "/jobs": jobs_body})
    log = tmp_path / "gh.log"
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ['PATH']}")
    monkeypatch.setenv("GH_LOG", str(log))
    gh = promote.GhCli("o/r")

    gh.dispatch("test.yml", "promote/x", {"a": "1", "b": "2"})
    found = gh.runs("test.yml", "promote/x", "abc")
    jobs = gh.jobs(7)
    gh.cancel(7)

    assert found == [promote.Run(1, "in_progress", None), promote.Run(2, "completed", "success")]
    assert jobs == [promote.Job("pytest", "success"), promote.Job("frontend", None)]
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    assert calls[0] == [
        "workflow",
        "run",
        "test.yml",
        "--repo",
        "o/r",
        "--ref",
        "promote/x",
        "-f",
        "a=1",
        "-f",
        "b=2",
    ]
    assert calls[1][:3] == ["api", "repos/o/r/actions/workflows/test.yml/runs", "-X"]
    assert {"branch=promote/x", "head_sha=abc", "event=workflow_dispatch"} <= set(calls[1])
    assert calls[2] == [
        "api",
        "--paginate",
        "--slurp",
        "repos/o/r/actions/runs/7/jobs?per_page=100",
    ]
    assert calls[3] == ["api", "-X", "POST", "repos/o/r/actions/runs/7/cancel"]


@pytest.mark.parametrize(
    ("jobs", "problem"),
    [
        (
            {"pytest": "skipped", "frontend": "success", "frontend-e2e": "success"},
            "pytest: skipped",
        ),
        ({"pytest": "success", "frontend": "success"}, "frontend-e2e: missing"),
        (
            {"pytest": "success", "frontend": "failure", "frontend-e2e": "success"},
            "frontend: failure",
        ),
    ],
)
def test_every_required_job_must_succeed_even_when_the_runs_do(
    repo: Repo, jobs, problem: str, capsys
) -> None:
    main_before = repo.remote_sha("main")

    assert go(repo, FakeGh(jobs_by_workflow={"test.yml": jobs})) == 1

    assert repo.remote_sha("main") == main_before
    assert f"required job {problem}" in capsys.readouterr().out


def test_diverged_main_fails_before_anything_is_pushed_or_dispatched(repo: Repo, capsys) -> None:
    repo.advance("main")
    branches_before = repo.remote_branches()
    gh = FakeGh()

    assert go(repo, gh) == 1

    assert gh.dispatched == []
    assert repo.remote_branches() == branches_before
    assert "merge main into develop" in capsys.readouterr().out


def test_a_missing_base_branch_fails_with_a_clear_message(repo: Repo, capsys) -> None:
    sh(repo.origin, "branch", "-D", "develop")
    gh = FakeGh()

    assert go(repo, gh) == 1

    assert gh.dispatched == []
    assert "develop does not exist on origin" in capsys.readouterr().out


def test_main_moving_during_the_run_blocks_the_push(repo: Repo, capsys) -> None:
    moved: list[str] = []

    def move_main() -> None:
        if not moved:
            moved.append(repo.advance("main"))

    gh = FakeGh(on_poll=move_main)

    assert go(repo, gh) == 1

    assert repo.remote_sha("main") == moved[0]
    assert "moved during the run" in capsys.readouterr().out


def test_when_main_equals_develop_only_storybook_is_dispatched(repo: Repo) -> None:
    sh(repo.other, "push", "-q", "origin", f"{repo.remote_sha('develop')}:refs/heads/main")
    gh = FakeGh()

    assert go(repo, gh) == 0

    assert gh.deploys() == [("storybook.yml", "main", {})]
    assert repo.remote_branches() == ["develop", "main"]


def test_a_failed_storybook_dispatch_fails_the_run_without_rolling_back(repo: Repo) -> None:
    develop = repo.remote_sha("develop")

    assert go(repo, FakeGh(fail_dispatch=frozenset({"storybook.yml"}))) == 1

    assert repo.remote_sha("main") == develop


def test_target_other_than_main_is_promoted_there(repo: Repo) -> None:
    sh(repo.other, "push", "-q", "origin", f"{repo.remote_sha('main')}:refs/heads/promote-canary")
    gh = FakeGh()

    assert go(repo, gh, target="promote-canary") == 0

    assert repo.remote_sha("promote-canary") == repo.remote_sha("develop")
    assert gh.dispatched[-1] == ("storybook.yml", "promote-canary", {})


def test_base_equal_to_release_runs_the_full_ci_and_pushes_nothing(
    repo: Repo, monkeypatch, capsys
) -> None:
    monkeypatch.setenv("SHARECUT_BASE_BRANCH", "main")
    gh = FakeGh()
    main = repo.remote_sha("main")
    branches_before = repo.remote_branches()

    assert go(repo, gh) == 0

    branch = f"promote/{main[:12]}-{EPOCH}-77-2"
    assert gh.ci_dispatches() == list(promote.CI_WORKFLOWS)
    assert {
        ref
        for w, ref, _ in gh.dispatched
        if w in promote.CI_WORKFLOWS and ref.startswith("promote/")
    } == {branch}
    assert gh.deploys() == []
    assert dict((w, i) for w, _, i in gh.dispatched)["test.yml"] == {
        "compatibility-base": main,
        "compatibility-base-ref": "refs/heads/main",
    }
    assert repo.remote_sha("main") == main
    assert sorted(repo.remote_branches()) == sorted([*branches_before, branch])
    assert "nothing to promote" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("outcomes", "jobs"),
    [
        ({"desktop.yml": ("completed", "failure")}, None),
        ({"storybook.yml": ("completed", "failure")}, None),
        ({"test.yml": ("completed", "skipped")}, None),
        ({}, {"test.yml": {"pytest": "failure", "frontend": "success", "frontend-e2e": "success"}}),
    ],
)
def test_a_red_nightly_on_the_release_branch_exits_non_zero(
    repo: Repo, monkeypatch, outcomes, jobs
) -> None:
    monkeypatch.setenv("SHARECUT_BASE_BRANCH", "main")
    gh = FakeGh(outcomes=outcomes, jobs_by_workflow=jobs or {})
    main = repo.remote_sha("main")

    assert go(repo, gh) == 1

    assert repo.remote_sha("main") == main
    assert gh.deploys() == []


def test_a_canary_target_still_pushes_while_base_equals_release(repo: Repo, monkeypatch) -> None:
    monkeypatch.setenv("SHARECUT_BASE_BRANCH", "main")
    sh(repo.other, "push", "-q", "origin", f"{repo.remote_sha('main')}:refs/heads/promote-canary")
    main = repo.advance("main")
    gh = FakeGh()

    assert go(repo, gh, target="promote-canary") == 0

    assert repo.remote_sha("promote-canary") == main
    assert gh.dispatched[-1] == ("storybook.yml", "promote-canary", {})


def test_unlisted_targets_are_refused_before_anything_is_pushed(repo: Repo, capsys) -> None:
    gh = FakeGh()
    branches_before = repo.remote_branches()

    assert go(repo, gh, target="develop") == 1
    assert go(repo, gh, target="release/x") == 1

    assert "refusing target" in capsys.readouterr().out
    assert gh.dispatched == []
    assert repo.remote_branches() == branches_before


def test_no_git_command_forces_a_push(repo: Repo, monkeypatch) -> None:
    calls: list[list[str]] = []
    real = subprocess.run

    def spy(cmd, *args, **kwargs):
        calls.append(list(cmd))
        return real(cmd, *args, **kwargs)

    monkeypatch.setattr(promote.subprocess, "run", spy)

    assert go(repo, FakeGh()) == 0
    promote.cleanup(promote.Git(repo.clone), run_id="77", attempt="2", now=0)

    pushes = [c for c in calls if c[:2] == ["git", "push"]]
    assert len(pushes) >= 3
    for argv in pushes:
        assert not [
            a
            for a in argv
            if a in ("-f", "--force") or a.startswith("--force-with") or a.startswith("+")
        ]


def test_cleanup_deletes_this_runs_branch_and_sweeps_by_creation_epoch(repo: Repo) -> None:
    develop = repo.remote_sha("develop")
    names = (
        f"promote/{'a' * 12}-{EPOCH}-5-1",
        f"promote/{'b' * 12}-{EPOCH + 7200}-77-2",
        f"promote/{'c' * 12}-{EPOCH + 7200}-77-1",
    )
    for name in names:
        sh(repo.other, "push", "-q", "origin", f"{develop}:refs/heads/{name}")

    promote.cleanup(promote.Git(repo.clone), run_id="77", attempt="2", now=EPOCH + 3600)
    assert sorted(repo.remote_branches()) == ["develop", "main", names[0], names[2]]

    promote.cleanup(promote.Git(repo.clone), run_id="78", attempt="1", now=EPOCH + 86400 + 3600)
    assert sorted(repo.remote_branches()) == ["develop", "main", names[2]]

    promote.cleanup(promote.Git(repo.clone), run_id="78", attempt="1", now=EPOCH + 3 * 86400)
    assert sorted(repo.remote_branches()) == ["develop", "main"]


def test_cleanup_keeps_promote_branches_outside_the_generated_name_shape(repo: Repo) -> None:
    develop = repo.remote_sha("develop")
    names = ("promote/hand-made", "promote/aaa-1-5-1", f"promote/{'a' * 12}-1-5")
    for name in names:
        sh(repo.other, "push", "-q", "origin", f"{develop}:refs/heads/{name}")

    promote.cleanup(promote.Git(repo.clone), run_id="5", attempt="1", now=10 * 86400)

    assert set(names) <= set(repo.remote_branches())


def test_cleanup_ignores_the_commit_date_of_the_branch_tip(repo: Repo) -> None:
    develop = repo.remote_sha("develop")
    commit_time = int(sh(repo.clone, "log", "-1", "--format=%ct", develop))
    name = f"promote/{'a' * 12}-{commit_time + 2 * 86400}-5-1"
    sh(repo.other, "push", "-q", "origin", f"{develop}:refs/heads/{name}")

    promote.cleanup(promote.Git(repo.clone), run_id="9", attempt="1", now=commit_time + 2 * 86400)

    assert name in repo.remote_branches()


def test_cli_cleanup_uses_the_env_run_identity(repo: Repo, monkeypatch) -> None:
    develop = repo.remote_sha("develop")
    sh(repo.other, "push", "-q", "origin", f"{develop}:refs/heads/promote/abcabcabcabc-1-9-3")
    monkeypatch.setenv("GITHUB_RUN_ID", "9")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "3")

    assert promote.main(["cleanup"], git=promote.Git(repo.clone)) == 0

    assert "promote/abcabcabcabc-1-9-3" not in repo.remote_branches()


def test_cli_run_passes_flags_through(repo: Repo, monkeypatch) -> None:
    gh = FakeGh()
    monkeypatch.setattr(promote.time, "sleep", lambda _: None)

    assert (
        promote.main(
            ["run", "--no-push", "--target", "main", "--run-id", "5", "--attempt", "1"],
            git=promote.Git(repo.clone),
            gh=gh,
        )
        == 0
    )

    assert repo.remote_sha("main") != repo.remote_sha("develop")
    assert any(ref.endswith("-5-1") for _, ref, _ in gh.dispatched)


def test_base_env_override_selects_the_frozen_source(repo: Repo, monkeypatch) -> None:
    sh(repo.other, "push", "-q", "origin", f"{repo.remote_sha('develop')}:refs/heads/trunk")
    monkeypatch.setenv("SHARECUT_BASE_BRANCH", "trunk")
    commit_sha = repo.advance("trunk")
    gh = FakeGh()

    assert go(repo, gh) == 0

    assert repo.remote_sha("main") == commit_sha


class SpyGit(promote.Git):
    def __init__(self, cwd: Path) -> None:
        super().__init__(cwd)
        self.pushes: list[tuple[str, Mapping[str, str] | None]] = []

    def _git(self, *args, check=True, env=None):
        if args[0] == "push" and "--delete" not in args:
            self.pushes.append((args[2].split(":refs/heads/")[1], env))
        return super()._git(*args, check=check, env=env)


def run_with_spy(repo: Repo) -> SpyGit:
    spy = SpyGit(repo.clone)
    clock = FakeClock()
    code = promote.promote(
        spy,
        FakeGh(),
        target="main",
        no_push=False,
        run_id="77",
        attempt="2",
        timeout=600,
        interval=60,
        clock=promote.Clock(sleep=clock.sleep, now=clock.now, epoch=lambda: EPOCH),
    )
    assert code == 0
    return spy


def test_promote_token_is_not_used_when_the_range_has_no_workflow_change(
    repo: Repo, monkeypatch
) -> None:
    monkeypatch.setenv("PROMOTE_TOKEN", "pat-secret")

    spy = run_with_spy(repo)

    assert [env for _, env in spy.pushes] == [None, None]


def test_promote_token_pushes_both_the_temp_branch_and_the_final_fast_forward_when_workflows_change(
    repo: Repo, monkeypatch
) -> None:
    monkeypatch.setenv("PROMOTE_TOKEN", "pat-secret")
    sh(repo.other, "fetch", "-q", "origin")
    sh(repo.other, "checkout", "-q", "-B", "develop", "origin/develop")
    workflow = repo.other / ".github" / "workflows" / "x.yml"
    workflow.parent.mkdir(parents=True)
    commit(repo.other, ".github/workflows/x.yml")
    sh(repo.other, "push", "-q", "origin", "develop")

    spy = run_with_spy(repo)

    expected = promote.token_env("pat-secret")
    assert [(branch.split("-")[0].split("/")[0], env) for branch, env in spy.pushes] == [
        ("promote", expected),
        ("main", expected),
    ]
    assert repo.remote_sha("main") == repo.remote_sha("develop")


def test_token_env_carries_the_token_only_in_git_config_environment() -> None:
    env = promote.token_env("pat-secret")

    assert env["GIT_CONFIG_COUNT"] == "2"
    assert env["GIT_CONFIG_VALUE_0"] == ""
    assert env["GIT_CONFIG_VALUE_1"].startswith("AUTHORIZATION: basic ")
    assert "pat-secret" not in "".join(env.values())


class RejectingGit(promote.Git):
    def __init__(self, cwd: Path, reject: str) -> None:
        super().__init__(cwd)
        self.reject = reject

    def push(self, sha: str, branch: str, token: str | None = None) -> None:
        if branch.startswith(self.reject):
            raise subprocess.CalledProcessError(
                128, ["git", "push"], stderr="remote: Authorization: basic cGF0LXNlY3JldA=="
            )
        super().push(sha, branch, token)


def add_workflow_change(repo: Repo) -> None:
    sh(repo.other, "fetch", "-q", "origin")
    sh(repo.other, "checkout", "-q", "-B", "develop", "origin/develop")
    (repo.other / ".github" / "workflows").mkdir(parents=True)
    commit(repo.other, ".github/workflows/x.yml")
    sh(repo.other, "push", "-q", "origin", "develop")


def run_rejecting(repo: Repo, reject: str, gh: FakeGh) -> int:
    clock = FakeClock()
    return promote.promote(
        RejectingGit(repo.clone, reject),
        gh,
        target="main",
        no_push=False,
        run_id="77",
        attempt="2",
        timeout=600,
        interval=60,
        clock=promote.Clock(sleep=clock.sleep, now=clock.now, epoch=lambda: EPOCH),
    )


def test_a_rejected_temp_branch_push_names_the_branch_and_stops(
    repo: Repo, monkeypatch, capsys
) -> None:
    monkeypatch.setenv("PROMOTE_TOKEN", "pat-secret")
    add_workflow_change(repo)
    main_before = repo.remote_sha("main")
    gh = FakeGh()

    assert run_rejecting(repo, "promote/", gh) == 1

    out = capsys.readouterr().out
    assert "push of promote/" in out and "was rejected" in out
    assert "pat-secret" not in out and "cGF0LXNlY3JldA" not in out and "Authorization" not in out
    assert gh.dispatched == []
    assert repo.remote_sha("main") == main_before


def test_a_rejected_final_push_names_main_and_does_not_dispatch_storybook(
    repo: Repo, monkeypatch, capsys
) -> None:
    monkeypatch.setenv("PROMOTE_TOKEN", "pat-secret")
    add_workflow_change(repo)
    main_before = repo.remote_sha("main")
    gh = FakeGh()

    assert run_rejecting(repo, "main", gh) == 1

    out = capsys.readouterr().out
    assert "push of main was rejected" in out
    assert "pat-secret" not in out and "cGF0LXNlY3JldA" not in out and "Authorization" not in out
    assert gh.deploys() == []
    assert all(not (w == "storybook.yml" and ref == "main") for w, ref, _ in gh.dispatched)
    assert repo.remote_sha("main") == main_before


def write_failing_gh(directory: Path, stderr: str) -> None:
    script = directory / "gh"
    script.write_text(
        f"#!/usr/bin/env python3\nimport sys\nsys.stderr.write({stderr!r})\nsys.exit(1)\n"
    )
    script.chmod(0o755)


def test_gh_cli_failure_prints_the_stderr_and_reraises(tmp_path: Path, monkeypatch, capsys) -> None:
    write_failing_gh(tmp_path, "HTTP 422: Workflow does not have 'workflow_dispatch' trigger\n")
    monkeypatch.setenv("PATH", f"{tmp_path}:{os.environ['PATH']}")

    with pytest.raises(subprocess.CalledProcessError):
        promote.GhCli("o/r").dispatch("storybook.yml", "promote/x", {})

    assert capsys.readouterr().out == (
        "gh workflow run failed: HTTP 422: Workflow does not have 'workflow_dispatch' trigger\n"
    )


@pytest.mark.parametrize("name", ["PROMOTE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"])
def test_gh_cli_failure_scrubs_token_values(tmp_path: Path, monkeypatch, capsys, name: str) -> None:
    write_failing_gh(tmp_path, "bad credentials tok-secret-123\n")
    monkeypatch.setenv("PATH", f"{tmp_path}:{os.environ['PATH']}")
    for other in ("PROMOTE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"):
        monkeypatch.delenv(other, raising=False)
    monkeypatch.setenv(name, "tok-secret-123")

    with pytest.raises(subprocess.CalledProcessError):
        promote.GhCli("o/r").dispatch("test.yml", "promote/x", {})

    out = capsys.readouterr().out
    assert "tok-secret-123" not in out
    assert out == "gh workflow run failed: bad credentials ***\n"


def test_a_failed_ci_dispatch_returns_1_and_leaves_the_temp_branch(repo: Repo, capsys) -> None:
    class FailingGh(FakeGh):
        def dispatch(self, workflow: str, ref: str, inputs: Mapping[str, str]) -> None:
            raise subprocess.CalledProcessError(1, "gh", stderr="boom")

    main_before = repo.remote_sha("main")

    assert go(repo, FailingGh()) == 1

    out = capsys.readouterr().out
    assert "dispatching test.yml on promote/" in out
    assert any(b.startswith("promote/") for b in repo.remote_branches())
    assert repo.remote_sha("main") == main_before
