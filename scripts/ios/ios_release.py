#!/usr/bin/env python3
"""Build, check, validate and upload the ShareCut iOS app for TestFlight.

    uv run python scripts/ios/ios_release.py build [--unsigned] [--dry-run]
    uv run python scripts/ios/ios_release.py validate [--build N] [--dry-run]
    uv run python scripts/ios/ios_release.py upload --confirm <build>:<sha12> [--build N] [--dry-run]

``build --unsigned`` is the rehearsal: every local check, nothing sent to anyone. The secrets (team,
key id, issuer, key path) come from a private ``0600`` file outside the repository or from the
environment; nothing prints them. ``docs/desktop-packaging.md`` § iOS release has the runbook.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from scripts.ios import bundle_checks as checks
from scripts.ios import private_paths
from scripts.ios.build_payload import PayloadError, rustup_toolchain_bin
from scripts.ios.release_classify import Failure
from scripts.ios.release_deliver import plan_deliver
from scripts.ios.release_inputs import (
    Checkout,
    InputError,
    InputProblem,
    Signing,
    load_identity,
    marketing_version,
    private_values,
    resolve_asc_key,
    resolve_build_inputs,
)
from scripts.ios.release_plan import (
    APPLE_NOTICE,
    Layout,
    Run,
    Step,
    Workspace,
    plan_build,
    tool_path,
)
from scripts.ios.release_record import (
    LockHeld,
    checkout_lock,
    newest,
    recorded_numbers,
)
from scripts.ios.release_run import capture, spawn
from scripts.ios.release_secrets import Redactor

IOS_TARGET = "aarch64-apple-ios"


def machine_directories(root: Path) -> dict[str, Path]:
    return {
        "checkout": root,
        "cache": private_paths.cache_dir(),
        "cargo": private_paths.cargo_home(),
        "rustup": private_paths.rustup_home(),
        "tmp": Path(os.environ.get("TMPDIR", "/tmp")),
        "home": Path.home(),
    }


def git_state(root: Path) -> tuple[str, bool]:
    commit = capture(["git", "rev-parse", "HEAD"], cwd=root).strip()
    dirty = bool(
        capture(["git", "status", "--porcelain", "--untracked-files=no"], cwd=root).strip()
    )
    return commit, dirty


class Session:
    """What one invocation shares: the layout, the redactor, and a way to print through it."""

    def __init__(self, root: Path, dry_run: bool) -> None:
        self.layout = Layout(root)
        self.dry_run = dry_run
        self.redactor = Redactor(directories=machine_directories(root))

    def say(self, text: str = "") -> None:
        print(self.redactor.redact(text), flush=True)

    def show(self, steps: Sequence[Step]) -> None:
        for number, step in enumerate(steps, 1):
            where = "APPLE" if step.contacts_apple else "local"
            detail = step.command.display(self.redactor) if isinstance(step, Run) else "in-process"
            self.say(f"{number:2} {step.name:24} {where:5}  {detail}")


def execute(session: Session, steps: Sequence[Step], ws: Workspace, log_dir: Path) -> int:
    ws.redact = session.redactor.redact
    if session.dry_run:
        session.show(steps)
        session.say("dry run: nothing was run")
        return 0
    for number, step in enumerate(steps, 1):
        where = "APPLE" if step.contacts_apple else "local"
        session.say(f"{number:2} {step.name:24} {where}")
        if isinstance(step, Run):
            slug = step.name.replace(" ", "-")
            result = spawn(step.command, session.redactor, log_dir / f"{number:02d}-{slug}.log")
            failure, sentence = step.interpret(result, ws)
            if failure is not None:
                session.say(result.tail)
                session.say(f"ios_release: {step.name} failed: {sentence}")
                return failure.value
            continue
        report = step.action(ws)
        if report is None:
            continue
        ws.reports[step.name] = report
        for warning in report.warnings:
            session.say(f"     warning: {warning}")
        if report.ok:
            session.say(f"     ok {dict(report.facts)}")
            continue
        for problem in report.problems:
            session.say(f"     {problem}")
        session.say(f"ios_release: {step.name} failed")
        return (Failure.GUARD if step.name == "upload guard" else Failure.HYGIENE).value
    return 0


def toolchain() -> tuple[str, InputProblem | None]:
    try:
        return tool_path(rustup_toolchain_bin(IOS_TARGET), os.environ), None
    except PayloadError as error:
        return os.environ.get("PATH", ""), InputProblem("rust toolchain", "rustup", str(error))


def build(session: Session, unsigned: bool) -> int:
    layout = session.layout
    signing = Signing.NONE if unsigned else Signing.APP_STORE
    values, file_problems = private_values(os.environ, layout.root, Path.home())
    path, toolchain_problem = toolchain()
    commit, dirty = git_state(layout.root)
    version, _ = marketing_version(layout.root)
    inputs = resolve_build_inputs(
        environ=os.environ,
        values=values,
        file_problems=file_problems,
        root=layout.root,
        now=datetime.now(UTC),
        signing=signing,
        checkout=Checkout(commit, dirty),
        recorded=recorded_numbers(layout.release_root, version or ""),
        toolchain_problem=toolchain_problem,
    )
    if inputs.team is not None:
        session.redactor = Redactor([inputs.team], machine_directories(layout.root))
    steps = plan_build(inputs, layout, os.environ, path)
    session.say(
        f"ios_release build {inputs.marketing_version} ({inputs.build_number}) "
        f'{inputs.identity.bundle_identifier} "{inputs.identity.name}" signing={signing.value} '
        f"commit {commit[:7]}{' dirty' if dirty else ''}"
    )
    if signing is Signing.APP_STORE:
        session.say(f"note: {APPLE_NOTICE}")
    partial = layout.release_root / f"{inputs.build_number}.partial"
    ws = Workspace(out=partial, build_number=str(inputs.build_number))
    if session.dry_run:
        return execute(session, steps, ws, partial / "logs")
    partial.mkdir(parents=True)
    try:
        code = execute(session, steps, ws, partial / "logs")
    finally:
        ws.cleanup()
    if code != 0:
        session.say(f"the partial build is kept for tracing: {partial}")
        return code
    final = layout.release_root / str(inputs.build_number)
    partial.rename(final)
    session.say(
        f"built {inputs.build_number}: {final / ws.ipa.name if ws.ipa else final} sha256 {ws.sha256[:12]}..."
    )
    session.say(
        "next: ios_release.py validate"
        if signing is Signing.APP_STORE
        else "rehearsal complete; nothing was sent to anyone"
    )
    return 0


def deliver(session: Session, confirm: str | None, build_number: str | None) -> int:
    layout = session.layout
    found = newest(layout.release_root, build_number)
    if found is None:
        raise InputError(
            [InputProblem("build", "release directory", "no finished build; run build first")]
        )
    record_dir, record = found
    values, file_problems = private_values(os.environ, layout.root, Path.home())
    key = resolve_asc_key(values, Path.home(), layout.root)
    identity, problems = load_identity(os.environ)
    version, version_problems = marketing_version(layout.root)
    if file_problems or problems or version_problems or identity is None:
        raise InputError([*file_problems, *problems, *version_problems])
    session.redactor = Redactor(
        [key.key_id, key.issuer, key.key_path], machine_directories(layout.root)
    )
    path, _ = toolchain()
    expect = checks.PlistExpectation(
        identity.bundle_identifier, identity.name, version or "", record.build_number
    )
    steps = plan_deliver(
        record_dir,
        record,
        key,
        layout,
        os.environ,
        path,
        expect,
        confirm=confirm,
        git_state=lambda: git_state(layout.root),
    )
    session.say(
        f"ios_release {'upload' if confirm else 'validate'} {record.build_number} "
        f"sha256 {record.ipa_sha256[:12]}"
    )
    ws = Workspace(out=record_dir, build_number=record.build_number)
    try:
        code = execute(session, steps, ws, record_dir / "logs")
    finally:
        ws.cleanup()
    if code == 0 and not session.dry_run:
        session.say(
            "uploaded; App Store processing usually takes 5 to 30 minutes"
            if confirm
            else f"to upload after the owner says so: ios_release.py upload --confirm {record.token()}"
        )
    return code


def parser() -> argparse.ArgumentParser:
    top = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = top.add_subparsers(dest="command", required=True)
    for name in ("build", "validate", "upload"):
        sub = commands.add_parser(name)
        sub.add_argument("--dry-run", action="store_true", help="print the steps and run nothing")
        if name == "build":
            sub.add_argument(
                "--unsigned", action="store_true", help="the rehearsal; contacts nobody"
            )
        else:
            sub.add_argument("--build", help="a build number; default the newest")
        if name == "upload":
            sub.add_argument(
                "--confirm", required=True, help="<build>:<sha12>, printed by validate"
            )
    return top


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    session = Session(ROOT, args.dry_run)
    try:
        with checkout_lock(session.layout.release_root):
            if args.command == "build":
                return build(session, args.unsigned)
            return deliver(session, getattr(args, "confirm", None), args.build)
    except InputError as error:
        session.say(f"ios_release: {error}")
        return Failure.INPUT.value
    except LockHeld as error:
        session.say(f"ios_release: {error}")
        return Failure.LOCKED.value
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        session.say(f"ios_release: {session.redactor.exception_line(error)}")
        return Failure.TOOL.value


if __name__ == "__main__":
    raise SystemExit(main())
