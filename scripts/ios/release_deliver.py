"""Validate and upload: the App Store Connect half of the release.

One plan serves both. It stages a private copy of the IPA and reruns every local check on that
copy (with a confirmation, the upload guard too), so every refusal that needs no answer from Apple
comes before the first step that contacts Apple. Then it looks up the app record (read-only) and
asks Apple to validate the copy. With a confirmation it uploads the same copy. Apple's answers
are recorded in the release record; the record can only block a later upload.
"""

from __future__ import annotations

import secrets
import tempfile
from collections.abc import Callable, Mapping
from pathlib import Path

from scripts.ios import bundle_checks as checks
from scripts.ios.release_classify import (
    SENTENCES,
    UPLOAD_UNREACHABLE,
    AppleAnswer,
    Failure,
    Verdict,
    app_record_exists,
    classify_altool,
    classify_upload,
)
from scripts.ios.release_inputs import AscKey
from scripts.ios.release_plan import (
    OK,
    Layout,
    Local,
    Outcome,
    Run,
    Step,
    Workspace,
    artifact_checks,
    child_environment,
)
from scripts.ios.release_record import (
    GuardFacts,
    ReleaseRecord,
    now_iso,
    outcome_row,
    sha256_file,
    stage_copy,
    upload_preconditions,
    write_record,
)
from scripts.ios.release_run import Command, SpawnResult

GitState = Callable[[], tuple[str, bool]]


def altool(
    mode: list[str], key: AscKey, layout: Layout, path: str, environ: Mapping[str, str]
) -> Command:
    return Command(
        (
            "xcrun",
            "altool",
            *mode,
            "--output-format",
            "json",
            "--api-key",
            key.key_id,
            "--api-issuer",
            key.issuer,
            "--p8-file-path",
            key.key_path,
        ),
        layout.root,
        child_environment(environ, path=path),
    )


def answered(answer: AppleAnswer, ws: Workspace, verb: str) -> tuple[Outcome, AppleAnswer]:
    ws.answers.append(answer)
    if answer.verdict is Verdict.OK:
        return OK, answer
    failure = {
        Verdict.DUPLICATE: Failure.DUPLICATE_BUILD,
        Verdict.UNREACHABLE: Failure.TOOL,
    }.get(answer.verdict, Failure.APPLE_REJECTED)
    detail = " ".join(answer.messages) if answer.verdict is Verdict.REJECTED else ""
    return (failure, f"{verb}: {SENTENCES[answer.verdict]} {detail}".strip()), answer


def lookup_outcome(result: SpawnResult, bundle_identifier: str) -> Outcome:
    if result.exit_code != 0:
        answer = classify_altool(result.exit_code, result.output)
        return Failure.APPLE_REJECTED, SENTENCES[answer.verdict]
    if not app_record_exists(result.output, bundle_identifier):
        return (
            Failure.APPLE_REJECTED,
            "App Store Connect has no app record for this bundle identifier. Create the app in App Store Connect first.",
        )
    return OK


def plan_deliver(
    record_dir: Path,
    record: ReleaseRecord,
    key: AscKey,
    layout: Layout,
    environ: Mapping[str, str],
    path: str,
    expect: checks.PlistExpectation,
    *,
    confirm: str | None,
    git_state: GitState,
    retry_unknown_upload: bool = False,
) -> list[Step]:
    stage = Path(tempfile.gettempdir()) / f"sharecut-ios-stage-{secrets.token_hex(8)}"
    staged = stage / "app.ipa"

    def stage_step(ws: Workspace) -> None:
        ws.scratch.append(stage)
        ws.ipa = stage_copy(record_dir / record.ipa_name, stage)
        ws.sha256 = sha256_file(ws.ipa)

    def validated(result: SpawnResult, ws: Workspace) -> Outcome:
        outcome, answer = answered(classify_altool(result.exit_code, result.output), ws, "validate")
        row = outcome_row(answer.verdict, now_iso(), answer.messages)
        record.validations.append({**row, "ipa_sha256": ws.sha256})
        write_record(record_dir, record)
        return outcome

    def uploaded(result: SpawnResult, ws: Workspace) -> Outcome:
        outcome, answer = answered(classify_upload(result.exit_code, result.output), ws, "upload")
        row = outcome_row(answer.verdict, now_iso(), answer.messages)
        if answer.verdict is Verdict.UNREACHABLE:
            record.uploads[-1]["last_answer"] = row
            outcome = Failure.TOOL, f"upload: {UPLOAD_UNREACHABLE}"
        else:
            record.uploads[-1]["outcome"] = row
        write_record(record_dir, record)
        return outcome

    def start_attempt(ws: Workspace) -> None:
        attempt: dict[str, object] = {
            "ipa_sha256": ws.sha256,
            "started_at": now_iso(),
            "outcome": None,
        }
        if retry_unknown_upload and record.unresolved_uploads(ws.sha256):
            attempt["retried_unknown_upload"] = True
        record.uploads.append(attempt)
        write_record(record_dir, record)

    def guard(ws: Workspace) -> checks.CheckReport:
        commit, dirty = git_state()
        refusals = upload_preconditions(
            record,
            confirm or "",
            GuardFacts(ws.sha256, ws.signing, not dirty, commit, ws.build_number),
            retry_unknown=retry_unknown_upload,
        )
        return checks.CheckReport("upload guard", tuple(refusals))

    steps: list[Step] = [
        Local("stage ipa", stage_step),
        *artifact_checks(expect, layout, True),
    ]
    if confirm is not None:
        steps.append(Local("upload guard", guard))
    steps.append(
        Run(
            "app record",
            altool(
                ["--list-apps", "--filter-bundle-id", record.bundle_identifier],
                key,
                layout,
                path,
                environ,
            ),
            True,
            lambda result, ws: lookup_outcome(result, record.bundle_identifier),
        )
    )
    steps.append(
        Run(
            "validate",
            altool(["--validate-app", "-f", str(staged)], key, layout, path, environ),
            True,
            validated,
        )
    )
    if confirm is not None:
        steps.append(Local("record upload attempt", start_attempt))
        steps.append(
            Run(
                "upload",
                altool(["--upload-app", "-f", str(staged)], key, layout, path, environ),
                True,
                uploaded,
            )
        )
    return steps
