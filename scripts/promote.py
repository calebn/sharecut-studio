#!/usr/bin/env python3
"""Promote the base branch to the release branch once its full CI is green.

Usage:
  python3 scripts/promote.py run [--no-push] [--target main]
  python3 scripts/promote.py cleanup

`run` freezes the base tip S and the target tip M, pushes S to a temporary
`promote/<S12>-<epoch>-<run_id>-<attempt>` branch, dispatches the full CI there, waits for every run and
every required job to succeed, then fast-forwards the target to S with a plain push and
dispatches the storybook deploy. `--no-push` does everything up to the push and prints it.
`run` refuses to start from a ref other than the release branch when GITHUB_REF is set.
While the base branch is the release branch, `run` is the nightly: the same dispatch, wait and
required-job checks on the branch tip, with nothing pushed and no storybook dispatch.
`--target` must be the release branch or start with `promote-canary`.
`cleanup` deletes this run's temporary branch and sweeps any created over a day ago, by the epoch in its name.
Needs `GITHUB_REPOSITORY` and a `GITHUB_TOKEN` (or `GH_TOKEN`) the `gh` CLI can use.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import branches

ROOT = Path(__file__).resolve().parent.parent
REMOTE = "origin"
BRANCH_PREFIX = "promote/"
TEST_WORKFLOW = "test.yml"
CI_WORKFLOWS = (
    TEST_WORKFLOW,
    "secret-scan.yml",
    "desktop.yml",
    "registry-backup-windows.yml",
)
STORYBOOK_WORKFLOW = "storybook.yml"
STALE_SECONDS = 24 * 60 * 60
CANARY_PREFIX = "promote-canary"


@dataclass(frozen=True)
class Run:
    id: int
    status: str
    conclusion: str | None


@dataclass(frozen=True)
class Job:
    name: str
    conclusion: str | None


class PromoteError(Exception):
    pass


class Gh(Protocol):
    def dispatch(self, workflow: str, ref: str, inputs: Mapping[str, str]) -> None: ...

    def runs(self, workflow: str, branch: str, head_sha: str) -> list[Run]: ...

    def jobs(self, run_id: int) -> list[Job]: ...

    def cancel(self, run_id: int) -> None: ...


class GhCli:
    def __init__(self, repo: str) -> None:
        self.repo = repo

    def _gh(self, *args: str) -> str:
        return subprocess.run(
            ["gh", *args], check=True, capture_output=True, text=True, cwd=ROOT
        ).stdout

    def dispatch(self, workflow: str, ref: str, inputs: Mapping[str, str]) -> None:
        fields = [arg for key, value in inputs.items() for arg in ("-f", f"{key}={value}")]
        self._gh("workflow", "run", workflow, "--repo", self.repo, "--ref", ref, *fields)

    def runs(self, workflow: str, branch: str, head_sha: str) -> list[Run]:
        out = self._gh(
            "api",
            f"repos/{self.repo}/actions/workflows/{workflow}/runs",
            "-X",
            "GET",
            "-f",
            f"branch={branch}",
            "-f",
            f"head_sha={head_sha}",
            "-f",
            "event=workflow_dispatch",
            "-f",
            "per_page=100",
        )
        return [
            Run(row["id"], row["status"], row["conclusion"])
            for row in sorted(json.loads(out)["workflow_runs"], key=lambda r: r["created_at"])
        ]

    def jobs(self, run_id: int) -> list[Job]:
        out = self._gh(
            "api",
            "--paginate",
            "--slurp",
            f"repos/{self.repo}/actions/runs/{run_id}/jobs?per_page=100",
        )
        return [
            Job(job["name"], job["conclusion"]) for page in json.loads(out) for job in page["jobs"]
        ]

    def cancel(self, run_id: int) -> None:
        self._gh("api", "-X", "POST", f"repos/{self.repo}/actions/runs/{run_id}/cancel")


class Git:
    def __init__(self, cwd: Path = ROOT, remote: str = REMOTE) -> None:
        self.cwd = cwd
        self.remote = remote

    def _git(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *args], check=check, capture_output=True, text=True, cwd=self.cwd
        )

    def fetch(self) -> None:
        self._git("fetch", "--prune", self.remote)

    def rev_parse(self, branch: str) -> str:
        ref = f"refs/remotes/{self.remote}/{branch}^{{commit}}"
        return self._git("rev-parse", "--verify", ref).stdout.strip()

    def is_ancestor(self, ancestor: str, descendant: str) -> bool:
        return (
            self._git("merge-base", "--is-ancestor", ancestor, descendant, check=False).returncode
            == 0
        )

    def push(self, sha: str, branch: str) -> None:
        self._git("push", self.remote, f"{sha}:refs/heads/{branch}")

    def delete(self, branch: str) -> None:
        self._git("push", self.remote, "--delete", branch)

    def promote_branches(self) -> list[str]:
        out = self._git(
            "for-each-ref",
            "--format=%(refname:strip=3)",
            f"refs/remotes/{self.remote}/{BRANCH_PREFIX}",
        ).stdout
        return out.split()


@dataclass(frozen=True)
class Clock:
    sleep: Callable[[float], None] = time.sleep
    now: Callable[[], float] = time.monotonic
    epoch: Callable[[], float] = time.time


def temp_branch(sha: str, epoch: int, run_id: str, attempt: str) -> str:
    return f"{BRANCH_PREFIX}{sha[:12]}-{epoch}-{run_id}-{attempt}"


TEMP_BRANCH_SHAPE = re.compile(r"[0-9a-f]{12}-(\d+)-\d+-\d+")


def created_at(name: str) -> int | None:
    match = TEMP_BRANCH_SHAPE.fullmatch(name.removeprefix(BRANCH_PREFIX))
    return int(match[1]) if match else None


def valid_target(target: str, release: str) -> bool:
    return target == release or target.startswith(CANARY_PREFIX)


def failures(
    runs: Mapping[str, Run | None], jobs: Mapping[int, Sequence[Job]], required: Sequence[str]
) -> list[str]:
    problems = []
    for workflow, run in runs.items():
        if run is None:
            problems.append(f"{workflow}: no run found")
        elif run.conclusion != "success":
            problems.append(f"{workflow}: run {run.id} {run.conclusion or run.status}")
    conclusions = {
        (workflow, job.name): job.conclusion
        for workflow, run in runs.items()
        if run is not None
        for job in jobs.get(run.id, ())
    }
    for name in required:
        found = [
            conclusion for (_, job_name), conclusion in conclusions.items() if job_name == name
        ]
        if not found:
            problems.append(f"required job {name}: missing")
        elif bad := [conclusion for conclusion in found if conclusion != "success"]:
            problems.append(f"required job {name}: {bad[0]}")
    return problems


def cancel_unfinished(gh: Gh, runs: Iterable[Run | None]) -> None:
    for run in runs:
        if run is not None and run.status != "completed":
            try:
                gh.cancel(run.id)
            except subprocess.CalledProcessError as exc:
                print(f"could not cancel run {run.id}: {exc.stderr}")


def wait_for_runs(
    gh: Gh,
    branch: str,
    sha: str,
    required: Sequence[str],
    *,
    timeout: float,
    interval: float,
    clock: Clock,
) -> list[str]:
    deadline = clock.now() + timeout
    while True:
        runs = {
            workflow: (found[-1] if (found := gh.runs(workflow, branch, sha)) else None)
            for workflow in CI_WORKFLOWS
        }
        finished = [run for run in runs.values() if run is not None and run.status == "completed"]
        timed_out = len(finished) < len(runs) and clock.now() >= deadline
        if len(finished) == len(runs) or timed_out:
            jobs = {run.id: gh.jobs(run.id) for run in finished}
            problems = failures(runs, jobs, required)
            if timed_out:
                cancel_unfinished(gh, runs.values())
                problems.append("timed out")
            return problems
        clock.sleep(interval)


def promote(
    git: Git,
    gh: Gh,
    *,
    target: str,
    no_push: bool,
    run_id: str,
    attempt: str,
    timeout: float,
    interval: float = 60,
    clock: Clock | None = None,
) -> int:
    clock = clock or Clock()
    cfg = branches.load()
    base = branches.base()
    if not valid_target(target, cfg.release):
        print(f"refusing target {target}: use {cfg.release} or a {CANARY_PREFIX}* branch")
        return 1
    git.fetch()
    try:
        source_sha = git.rev_parse(base)
    except subprocess.CalledProcessError:
        print(f"{base} does not exist on origin: create it from {cfg.release} before promoting")
        return 1
    target_sha = git.rev_parse(target)
    print(f"{base} {source_sha[:12]} -> {target} {target_sha[:12]}")
    nightly = base == cfg.release and target == cfg.release
    if source_sha == target_sha and not nightly:
        print(f"{target} is already at {base}; dispatching only {STORYBOOK_WORKFLOW}")
        return dispatch_storybook(gh, target, no_push)
    if not git.is_ancestor(target_sha, source_sha):
        print(f"{target} is not an ancestor of {base}: merge {target} into {base}")
        return 1
    branch = temp_branch(source_sha, int(clock.epoch()), run_id, attempt)
    git.push(source_sha, branch)
    for workflow in CI_WORKFLOWS:
        inputs = (
            {
                "compatibility-base": target_sha,
                "compatibility-base-ref": f"refs/heads/{target}",
            }
            if workflow == TEST_WORKFLOW
            else {}
        )
        gh.dispatch(workflow, branch, inputs)
    problems = wait_for_runs(
        gh,
        branch,
        source_sha,
        cfg.required_jobs,
        timeout=timeout,
        interval=interval,
        clock=clock,
    )
    if problems:
        print("not promoting:\n  " + "\n  ".join(problems))
        return 1
    git.fetch()
    if git.rev_parse(target) != target_sha:
        print(f"{target} moved during the run; not promoting")
        return 1
    if nightly:
        print(f"{base} {source_sha[:12]} is green; nothing to promote")
        return 0
    if no_push:
        print(f"dry run: would push {source_sha}:refs/heads/{target}")
    else:
        git.push(source_sha, target)
        print(f"fast-forwarded {target} to {source_sha[:12]}")
    return dispatch_storybook(gh, target, no_push)


def dispatch_storybook(gh: Gh, target: str, no_push: bool) -> int:
    if no_push:
        print(f"dry run: would dispatch {STORYBOOK_WORKFLOW} on {target}")
        return 0
    try:
        gh.dispatch(STORYBOOK_WORKFLOW, target, {})
    except subprocess.CalledProcessError as exc:
        print(f"{target} is promoted but dispatching {STORYBOOK_WORKFLOW} failed: {exc.stderr}")
        return 1
    return 0


def cleanup(git: Git, *, run_id: str, attempt: str, now: float) -> None:
    git.fetch()
    suffix = f"-{run_id}-{attempt}"
    for name in git.promote_branches():
        stamp = created_at(name)
        if stamp is not None and (name.endswith(suffix) or now - stamp > STALE_SECONDS):
            git.delete(name)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("run", "cleanup"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--run-id", default=os.environ.get("GITHUB_RUN_ID", "0"))
        cmd.add_argument("--attempt", default=os.environ.get("GITHUB_RUN_ATTEMPT", "1"))
        if name == "run":
            cmd.add_argument("--no-push", action="store_true")
            cmd.add_argument("--target", default=branches.release())
            cmd.add_argument("--timeout-minutes", type=float, default=320)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None, *, git: Git | None = None, gh: Gh | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    git = git or Git()
    if args.command == "run":
        ref = os.environ.get("GITHUB_REF")
        if ref and ref != f"refs/heads/{branches.release()}":
            print(f"refusing to promote from {ref}: run from {branches.release()}")
            return 1
    if args.command == "cleanup":
        cleanup(git, run_id=args.run_id, attempt=args.attempt, now=time.time())
        return 0
    gh = gh or GhCli(os.environ["GITHUB_REPOSITORY"])
    return promote(
        git,
        gh,
        target=args.target,
        no_push=args.no_push,
        run_id=args.run_id,
        attempt=args.attempt,
        timeout=args.timeout_minutes * 60,
    )


if __name__ == "__main__":
    raise SystemExit(main())
