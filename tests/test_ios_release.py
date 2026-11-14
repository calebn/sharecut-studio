"""scripts/ios release tooling: inputs, plans, the upload guard, classifiers and the canary."""

from __future__ import annotations

import ast
import contextlib
import json
import os
import plistlib
import stat
import sys
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import NamedTuple

import pytest
from scripts.ios import bundle_checks as checks
from scripts.ios import (
    ios_release,
    release_classify,
    release_deliver,
    release_inputs,
    release_plan,
    release_run,
)
from scripts.ios import release_record as record_module
from scripts.ios.release_classify import Failure, Verdict
from scripts.ios.release_inputs import BuildNumber, Checkout, Identity, InputError, Signing
from scripts.ios.release_run import Command
from scripts.ios.release_secrets import Redactor, Secret

from script_loader import SCRIPTS

TEAM = "BBBBBBBBBB"
KEY_ID = "CCCCCCCCCC"
ISSUER = "11111111-2222-3333-4444-555555555555"
IDENTITY = Identity("studio.sharecut.app", "ShareCut")
NOW = datetime(2026, 11, 14, 15, 30, 45, tzinfo=UTC)
LAYOUT = release_plan.Layout(Path("/work/repo"))


def test_the_build_number_is_three_integers_from_the_utc_clock() -> None:
    assert str(BuildNumber.at(NOW)) == "2026.1114.153045"
    assert str(BuildNumber.at(datetime(2027, 1, 5, 0, 5, 9, tzinfo=UTC))) == "2027.105.509"
    local = datetime(2026, 11, 14, 8, 30, 45, tzinfo=timezone(timedelta(hours=-7)))
    assert BuildNumber.at(local) == BuildNumber.at(NOW)
    with pytest.raises(ValueError, match="timezone"):
        BuildNumber.at(datetime(2026, 11, 14, 1, 2, 3))


def test_build_numbers_order_by_time_across_day_month_and_year() -> None:
    moments = [
        datetime(2026, 11, 14, 23, 59, 59, tzinfo=UTC),
        datetime(2026, 11, 15, 0, 0, 0, tzinfo=UTC),
        datetime(2026, 12, 1, 0, 0, 1, tzinfo=UTC),
        datetime(2027, 1, 1, 0, 0, 0, tzinfo=UTC),
    ]
    numbers = [BuildNumber.at(moment) for moment in moments]
    assert numbers == sorted(numbers)
    assert all(BuildNumber.parse(str(n)) == n for n in numbers)
    for bad in ("1.2", "1.2.3.4", "01.2.3", "a.b.c", ""):
        with pytest.raises(ValueError):
            BuildNumber.parse(bad)


def write_profile(path: Path, **changes: object) -> Path:
    profile = json.loads((SCRIPTS.parent / "config/distribution.dev.json").read_text())
    profile.pop("$schema")
    profile.update({"bundle_identifier": "studio.sharecut.app", "short_name": "ShareCut"})
    profile.update(changes)
    path.write_text(json.dumps(profile))
    return path


def inputs_for(tmp_path: Path, **overrides: object):
    profile = write_profile(tmp_path / "profile.json")
    arguments = {
        "environ": {"PODCAST_DISTRIBUTION_PROFILE": str(profile)},
        "values": {"APPLE_DEVELOPMENT_TEAM": TEAM},
        "file_problems": [],
        "root": SCRIPTS.parent,
        "now": NOW,
        "signing": Signing.APP_STORE,
        "checkout": Checkout("a" * 40, False),
        "recorded": [],
    }
    arguments.update(overrides)
    return release_inputs.resolve_build_inputs(**arguments)


def test_inputs_resolve_into_frozen_values_with_the_team_as_a_secret(tmp_path: Path) -> None:
    resolved = inputs_for(tmp_path)
    assert resolved.identity == IDENTITY
    assert (resolved.signing, str(resolved.build_number)) == (Signing.APP_STORE, "2026.1114.153045")
    assert repr(resolved.team) == "<team>"
    with pytest.raises(AttributeError):
        resolved.signing = Signing.NONE


def test_every_input_problem_is_reported_together(tmp_path: Path) -> None:
    with pytest.raises(InputError) as caught:
        inputs_for(
            tmp_path,
            environ={},
            values={"APPLE_DEVELOPMENT_TEAM": "AAAAAAAAAA"},
            checkout=Checkout("a" * 40, True),
            recorded=[BuildNumber.parse("2026.1114.153045")],
        )
    assert [(p.name, p.why[:24]) for p in caught.value.problems] == [
        ("PODCAST_DISTRIBUTION_PROFILE", "missing; the checked-in "),
        ("APPLE_DEVELOPMENT_TEAM", "is the Simulator placeho"),
        ("working tree", "has uncommitted changes;"),
        ("clock", "2026.1114.153045 is not "),
    ]


def test_the_development_profile_and_a_long_name_are_refused(tmp_path: Path) -> None:
    dev = write_profile(tmp_path / "dev.json", bundle_identifier="studio.sharecut.dev")
    with pytest.raises(InputError, match="development identifier"):
        inputs_for(tmp_path, environ={"PODCAST_DISTRIBUTION_PROFILE": str(dev)})
    long = write_profile(tmp_path / "long.json", product_name="A Name Of Many Characters")
    raw = json.loads(long.read_text())
    raw.pop("short_name")
    long.write_text(json.dumps(raw))
    with pytest.raises(InputError, match="allows 15"):
        inputs_for(tmp_path, environ={"PODCAST_DISTRIBUTION_PROFILE": str(long)})


def test_an_unsigned_rehearsal_needs_no_team_and_allows_a_dirty_tree(tmp_path: Path) -> None:
    resolved = inputs_for(
        tmp_path, signing=Signing.NONE, values={}, checkout=Checkout("b" * 40, True)
    )
    assert resolved.team is None and resolved.checkout.dirty


def test_the_private_file_must_be_private_outside_the_repo_and_known(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    secrets_file = tmp_path / "ios-release.env"
    secrets_file.write_text(f"# note\nAPPLE_DEVELOPMENT_TEAM={TEAM}\nAPPLE_API_KEY='{KEY_ID}'\n")
    secrets_file.chmod(0o644)
    _, problems = release_inputs.read_private_file(secrets_file, repo)
    assert [p.why for p in problems] == ["is readable by others; run chmod 600 on it"]
    secrets_file.chmod(0o600)
    values, problems = release_inputs.read_private_file(secrets_file, repo)
    assert (values, problems) == ({"APPLE_DEVELOPMENT_TEAM": TEAM, "APPLE_API_KEY": KEY_ID}, [])
    inside = repo / "ios.env"
    inside.write_text("x")
    inside.chmod(0o600)
    assert [p.why for p in release_inputs.read_private_file(inside, repo)[1]] == [
        "is inside the repository"
    ]
    secrets_file.write_text("TYPO_NAME=1\nnot a pair\n")
    _, problems = release_inputs.read_private_file(secrets_file, repo)
    assert len(problems) == 2 and "TYPO_NAME" not in "".join(p.name for p in problems)


def test_the_environment_overrides_the_file_and_the_key_file_is_checked_by_metadata(
    tmp_path: Path,
) -> None:
    secrets_file = tmp_path / "ios.env"
    secrets_file.write_text(f"APPLE_API_KEY={KEY_ID}\n")
    secrets_file.chmod(0o600)
    environ = {"SHARECUT_IOS_RELEASE_ENV": str(secrets_file), "APPLE_API_ISSUER": ISSUER}
    values, problems = release_inputs.private_values(environ, tmp_path / "repo", tmp_path)
    assert values == {"APPLE_API_KEY": KEY_ID, "APPLE_API_ISSUER": ISSUER} and not problems
    _, found = release_inputs.resolve_asc_key(values, tmp_path, tmp_path / "repo")
    assert [p.why for p in found] == ["the key file does not exist"]
    key = tmp_path / ".appstoreconnect/private_keys" / f"AuthKey_{KEY_ID}.p8"
    key.parent.mkdir(parents=True)
    key.write_text("not read")
    key.chmod(0o644)
    _, found = release_inputs.resolve_asc_key(values, tmp_path, tmp_path / "repo")
    assert [p.why for p in found] == ["is readable by others; run chmod 600 on it"]
    key.chmod(0o600)
    resolved, found = release_inputs.resolve_asc_key(values, tmp_path, tmp_path / "repo")
    assert found == [] and resolved is not None
    assert [repr(resolved.key_id), repr(resolved.issuer), repr(resolved.key_path)] == [
        "<key-id>",
        "<issuer>",
        "<key-path>",
    ]


NOISY = {
    "HOME": "/Users/someone",
    "PATH": "/caller/bin",
    "TMPDIR": "/var/tmp/x/",
    "LANG": "C",
    "LC_ALL": "C",
    "APPLE_API_KEY": KEY_ID,
    "APPLE_API_ISSUER": ISSUER,
    "APPLE_API_KEY_PATH": "/k.p8",
    "IOS_CERTIFICATE": "x",
    "IOS_CERTIFICATE_PASSWORD": "x",
    "IOS_MOBILE_PROVISION": "x",
    "RUSTFLAGS": "-C x",
    "CARGO_ENCODED_RUSTFLAGS": "x",
    "APPLE_ID": "x",
    "APPLE_PASSWORD": "x",
    "APPLE_CERTIFICATE": "x",
    "TAURI_SIGNING_PRIVATE_KEY": "x",
    "GITHUB_TOKEN": "x",
    "HTTPS_PROXY": "http://proxy",
    "SSL_CERT_FILE": "/ca.pem",
    "DEVELOPER_DIR": "/Xcode",
    "CARGO_BUILD_JOBS": "4",
    "USER": "someone",
    "LOGNAME": "someone",
}


def test_the_child_environment_is_an_allowlist() -> None:
    env = release_plan.child_environment(NOISY, path="/rustup:/usr/bin", team=Secret(TEAM, "team"))
    assert sorted(env) == [
        "APPLE_DEVELOPMENT_TEAM",
        "CARGO_BUILD_JOBS",
        "DEVELOPER_DIR",
        "HOME",
        "HTTPS_PROXY",
        "LANG",
        "LOGNAME",
        "PATH",
        "SSL_CERT_FILE",
        "TMPDIR",
        "USER",
    ]
    assert env["PATH"] == "/rustup:/usr/bin" and env["LANG"] == "en_US.UTF-8"
    assert "APPLE_DEVELOPMENT_TEAM" not in release_plan.child_environment(NOISY, path="p")


def test_the_overlay_has_three_keys_and_the_build_number_never_uses_the_cli_flag() -> None:
    assert release_plan.ios_overlay(IDENTITY, "2026.1114.153045") == {
        "identifier": "studio.sharecut.app",
        "productName": "ShareCut",
        "bundle": {"iOS": {"bundleVersion": "2026.1114.153045"}},
    }
    for path in sorted((SCRIPTS / "ios").glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        strings = [
            n.value
            for n in ast.walk(tree)
            if isinstance(n, ast.Constant) and isinstance(n.value, str)
        ]
        assert "--build-number" not in strings, path.name


def build_inputs(signing: Signing) -> release_inputs.BuildInputs:
    return release_inputs.BuildInputs(
        IDENTITY,
        "0.1.4",
        BuildNumber.parse("2026.1114.153045"),
        signing,
        Secret(TEAM, "team") if signing is Signing.APP_STORE else None,
        Checkout("a" * 40, False),
    )


def steps_by_name(steps):
    return {step.name: step for step in steps}


def test_the_signed_plan_archives_only_exports_and_may_touch_apple() -> None:
    steps = steps_by_name(
        release_plan.plan_build(build_inputs(Signing.APP_STORE), LAYOUT, NOISY, "/rustup:/usr/bin")
    )
    assert list(steps) == [
        "web dependencies",
        "web build",
        "desktop dependencies",
        "device payload",
        "reset generated project",
        "xcode project",
        "archive",
        "export",
        "collect ipa",
        "path scan",
        "info plist",
        "bundle layout",
        "privacy",
        "signature",
        "record",
    ]
    archive = steps["archive"].command
    assert archive.argv[:6] == ("npx", "tauri", "ios", "build", "--ci", "-v")
    assert archive.argv[-1] == "--archive-only"
    assert "--no-sign" not in archive.argv and "--build-number" not in archive.argv
    assert steps["archive"].contacts_apple and steps["export"].contacts_apple
    assert not steps["xcode project"].contacts_apple
    assert repr(archive.env["APPLE_DEVELOPMENT_TEAM"]) == "<team>"
    export = steps["export"].command
    assert export.argv[:3] == ("xcodebuild", "-exportArchive", "-allowProvisioningUpdates")
    options = plistlib.loads(
        "".join(
            TEAM if isinstance(part, Secret) else part for part in export.files[0].parts
        ).encode()
    )
    assert options == {
        "method": "app-store-connect",
        "signingStyle": "automatic",
        "teamID": TEAM,
        "uploadSymbols": False,
        "destination": "export",
        "manageAppVersionAndBuildNumber": False,
    }


def test_the_unsigned_plan_signs_nothing_and_contacts_nobody() -> None:
    steps = release_plan.plan_build(build_inputs(Signing.NONE), LAYOUT, NOISY, "/p")
    names = [step.name for step in steps]
    assert "export" not in names and "signature" not in names
    assert not any(step.contacts_apple for step in steps)
    archive = steps_by_name(steps)["archive"].command
    assert archive.argv[-2:] == ("--archive-only", "--no-sign")
    assert names.index("record xcodebuild arguments") < names.index("archive")
    assert archive.env["APPLE_DEVELOPMENT_TEAM"] == "AAAAAAAAAA"


def test_the_dry_run_prints_the_apple_notice_before_any_step(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    secrets_file = tmp_path / "ios.env"
    secrets_file.write_text(f"APPLE_DEVELOPMENT_TEAM={TEAM}\n")
    secrets_file.chmod(0o600)
    profile = write_profile(tmp_path / "profile.json")
    monkeypatch.setenv("SHARECUT_IOS_RELEASE_ENV", str(secrets_file))
    monkeypatch.setenv("PODCAST_DISTRIBUTION_PROFILE", str(profile))
    monkeypatch.setattr(ios_release, "git_state", lambda root: ("c" * 40, False))
    monkeypatch.setattr(ios_release, "toolchain", lambda: ("/rustup:/usr/bin", None))
    monkeypatch.setattr(ios_release, "checkout_lock", lambda root: contextlib.nullcontext())
    assert ios_release.main(["build", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert out.index("may create an Apple Distribution certificate") < out.index(" 1 ")
    assert TEAM not in out and "APPLE_DEVELOPMENT_TEAM=<team>" in out
    assert out.endswith("dry run: nothing was run\n")


def good_facts(record: record_module.ReleaseRecord, **changes: object) -> record_module.GuardFacts:
    facts = {
        "sha256": record.ipa_sha256,
        "signing": Signing.APP_STORE,
        "tree_clean": True,
        "head": record.commit,
        "build_number_in_ipa": record.build_number,
    }
    facts.update(changes)
    return record_module.GuardFacts(**facts)


def make_record(**changes: object) -> record_module.ReleaseRecord:
    row = {
        "build_number": "2026.1114.153045",
        "marketing_version": "0.1.4",
        "bundle_identifier": "studio.sharecut.app",
        "signing": "app-store",
        "commit": "a" * 40,
        "ipa_sha256": "9f" * 32,
        "ipa_name": "2026.1114.153045.ipa",
    }
    row.update(changes)
    return record_module.ReleaseRecord(**row)


def test_the_guard_passes_only_with_the_exact_token_and_a_matching_artifact() -> None:
    record = make_record()
    assert record.token() == "2026.1114.153045:" + "9f" * 6
    assert record_module.upload_preconditions(record, record.token(), good_facts(record)) == []


@pytest.mark.parametrize(
    ("change", "refusal"),
    [
        ({"sha256": "00" * 32}, "hash changed"),
        ({"signing": Signing.NONE}, "not signed for the App Store"),
        ({"tree_clean": False}, "uncommitted changes"),
        ({"head": "f" * 40}, "HEAD is not the commit"),
        ({"build_number_in_ipa": "2026.1114.153046"}, "build number is not the recorded build"),
    ],
)
def test_each_guard_clause_refuses_alone(change: dict[str, object], refusal: str) -> None:
    record = make_record()
    facts = good_facts(record, **change)
    confirm = f"{facts.build_number_in_ipa}:{facts.sha256[:12]}"
    refusals = record_module.upload_preconditions(record, confirm, facts)
    assert len(refusals) == 1 and refusal in refusals[0]


def test_a_wrong_token_or_a_delivered_build_is_refused() -> None:
    record = make_record()
    assert (
        "--confirm must be"
        in record_module.upload_preconditions(record, "2026.1114.153045", good_facts(record))[0]
    )
    record.uploads.append({"outcome": {"verdict": "ok"}})
    assert (
        "already delivered"
        in record_module.upload_preconditions(record, record.token(), good_facts(record))[0]
    )
    duplicate = make_record()
    duplicate.validations.append({"verdict": "apple_reports_duplicate"})
    assert duplicate.delivered()
    interrupted = make_record()
    interrupted.uploads.append({"outcome": None})
    assert not interrupted.delivered()


def test_the_record_round_trips_holds_public_fields_and_refuses_a_secret(tmp_path: Path) -> None:
    record = make_record(checks={"path scan": {"hits": 0}})
    record_module.write_record(tmp_path, record)
    assert oct((tmp_path / "release.json").stat().st_mode & 0o777) == "0o600"
    assert record_module.read_record(tmp_path) == record
    record.checks["leak"] = Secret(TEAM, "team")
    with pytest.raises(TypeError):
        record_module.write_record(tmp_path, record)
    (tmp_path / "release.json").write_text('{"schema": 99}')
    with pytest.raises(record_module.RecordError, match="unknown schema"):
        record_module.read_record(tmp_path)


def test_the_record_replaces_a_planted_link_and_a_loose_older_temp_file(tmp_path: Path) -> None:
    target = tmp_path / "victim.txt"
    target.write_text("untouched")
    target.chmod(0o644)
    temporary = tmp_path / ".release.json.tmp"
    temporary.symlink_to(target)
    record = make_record()
    record_module.write_record(tmp_path, record)
    assert target.read_text() == "untouched"
    assert oct(target.stat().st_mode & 0o777) == "0o644"
    assert not temporary.exists()

    temporary.write_text("old")
    temporary.chmod(0o644)
    record_module.write_record(tmp_path, record)
    assert oct((tmp_path / "release.json").stat().st_mode & 0o777) == "0o600"
    assert record_module.read_record(tmp_path) == record


def test_the_newest_build_is_keyed_by_version_and_partials_are_ignored(tmp_path: Path) -> None:
    rows = [("2026.1114.153045", "0.1.4"), ("2026.1201.1", "0.1.4"), ("2026.1102.1", "0.2.0")]
    for number, version in rows:
        directory = tmp_path / number
        directory.mkdir()
        record_module.write_record(
            directory, make_record(build_number=number, marketing_version=version)
        )
    (tmp_path / "2027.101.1.partial").mkdir()
    found = record_module.newest(tmp_path)
    assert found is not None and found[1].build_number == "2026.1102.1"
    assert record_module.newest(tmp_path, "2026.1114.153045")[1].marketing_version == "0.1.4"
    assert sorted(record_module.recorded_numbers(tmp_path, "0.1.4")) == [
        BuildNumber.parse("2026.1114.153045"),
        BuildNumber.parse("2026.1201.1"),
    ]


def test_the_lock_serializes_runs_and_the_stage_is_private_and_refuses_symlinks(
    tmp_path: Path,
) -> None:
    with record_module.checkout_lock(tmp_path):
        with pytest.raises(record_module.LockHeld), record_module.checkout_lock(tmp_path):
            pass
    ipa = tmp_path / "a.ipa"
    ipa.write_bytes(b"ipa")
    copy = record_module.stage_copy(ipa, tmp_path / "stage")
    assert copy.read_bytes() == b"ipa"
    assert oct((tmp_path / "stage").stat().st_mode & 0o777) == "0o700"
    link = tmp_path / "link.ipa"
    link.symlink_to(ipa)
    with pytest.raises(record_module.RecordError, match="symlinks are refused"):
        record_module.stage_copy(link, tmp_path / "stage2")


ALTOOL_OK = json.dumps(
    {"tool-version": "26.10.1", "success-message": "No errors validating archive."}
)


def altool_error(message: str) -> str:
    return json.dumps({"product-errors": [{"code": -19232, "message": message}]})


def apple_error(message: str, **fields: object) -> str:
    return json.dumps({"product-errors": [{"code": "ITMS-90022", "message": message, **fields}]})


@pytest.mark.parametrize(
    ("code", "text", "verdict"),
    [
        (0, ALTOOL_OK, Verdict.OK),
        (
            1,
            altool_error("Redundant Binary Upload. There already exists a binary upload"),
            Verdict.DUPLICATE,
        ),
        (
            1,
            altool_error("The bundle version must be higher than the previously uploaded version"),
            Verdict.DUPLICATE,
        ),
        (1, altool_error("Authentication failed: 401 unauthorized"), Verdict.AUTH_FAILED),
        (1, altool_error("Could not connect to the server"), Verdict.UNREACHABLE),
        (1, altool_error("Invalid Bundle. The bundle is missing an icon"), Verdict.REJECTED),
        (1, "plain text failure", Verdict.REJECTED),
    ],
)
def test_altool_answers_are_classified(code: int, text: str, verdict: Verdict) -> None:
    assert release_classify.classify_altool(code, text).verdict is verdict


def test_the_app_record_lookup_reads_the_filtered_list() -> None:
    listing = json.dumps(
        {"applications": [{"BundleId": "studio.sharecut.app", "Name": "ShareCut"}]}
    )
    assert release_classify.app_record_exists(listing, "studio.sharecut.app")
    assert not release_classify.app_record_exists(
        json.dumps({"applications": []}), "studio.sharecut.app"
    )
    assert not release_classify.app_record_exists("not json", "studio.sharecut.app")


@pytest.mark.parametrize(
    ("tail", "fragment"),
    [
        ("error: No Accounts: Add a new account in Accounts settings", "no signed-in account"),
        (
            "error: You already have a current Apple Distribution certificate or a pending request",
            "limit of distribution certificates",
        ),
        ("Missing private key for signing certificate", "private key is on another Mac"),
        ("Forbidden: You are not allowed to create certificates", "role cannot create"),
        (
            "A required agreement is missing: Program License Agreement has been updated",
            "agreement is waiting",
        ),
        (
            "Your team has no devices from which to generate a provisioning profile",
            "no registered device",
        ),
        ("error: No profiles for 'x' were found", "could not make a signing certificate"),
    ],
)
def test_signing_failures_get_one_sentence(tail: str, fragment: str) -> None:
    hint = release_classify.signing_hint(tail)
    assert hint is not None and fragment in hint
    assert release_classify.signing_hint("compiler error") is None


def fake_key() -> release_inputs.AscKey:
    return release_inputs.AscKey(
        Secret(KEY_ID, "key-id"), Secret(ISSUER, "issuer"), Secret("/k.p8", "key-path")
    )


def test_validate_and_upload_plans_differ_by_the_guard_and_the_upload(tmp_path: Path) -> None:
    record = make_record()
    expect = checks.PlistExpectation(
        "studio.sharecut.app", "ShareCut", "0.1.4", record.build_number
    )
    arguments = (tmp_path, record, fake_key(), LAYOUT, NOISY, "/p", expect)
    validate = release_deliver.plan_deliver(
        *arguments, confirm=None, git_state=lambda: ("a" * 40, False)
    )
    upload = release_deliver.plan_deliver(
        *arguments, confirm=record.token(), git_state=lambda: ("a" * 40, False)
    )
    assert [s.name for s in validate] == [
        "stage ipa",
        "path scan",
        "info plist",
        "bundle layout",
        "privacy",
        "signature",
        "app record",
        "validate",
    ]
    assert [s.name for s in upload][-6:] == [
        "signature",
        "upload guard",
        "app record",
        "validate",
        "record upload attempt",
        "upload",
    ]
    for plan in (validate, upload):
        first = next(i for i, step in enumerate(plan) if step.contacts_apple)
        assert not any(step.contacts_apple for step in plan[:first])
        assert {s.name for s in plan[:first]} >= {"signature"}
    assert (
        sum("--upload-app" in s.command.argv for s in upload if isinstance(s, release_plan.Run))
        == 1
    )
    lookup = validate[-2].command
    assert lookup.argv[1:6] == (
        "altool",
        "--list-apps",
        "--filter-bundle-id",
        "studio.sharecut.app",
        "--output-format",
    )
    assert lookup.env.keys().isdisjoint({"APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"})
    shown = validate[-1].command.display(Redactor([Secret(KEY_ID, "key-id")]))
    assert KEY_ID not in shown and "--api-key <key-id>" in shown


def test_the_make_targets_never_upload() -> None:
    makefile = (SCRIPTS.parent / "Makefile").read_text()
    testflight = makefile.split("ios-testflight:\n", 1)[1].split("\n\n", 1)[0]
    assert "upload" not in testflight and "build" in testflight and "validate" in testflight
    rehearsal = makefile.split("ios-release-rehearsal:\n", 1)[1].split("\n\n", 1)[0]
    assert "build --unsigned" in rehearsal and "validate" not in rehearsal


CANARY = "CANARYSECRET42"


def test_a_canary_secret_reaches_no_output_log_or_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    secret = Secret(CANARY, "team")
    session = ios_release.Session(tmp_path, dry_run=False)
    session.redactor = Redactor([secret], {"checkout": tmp_path})
    code = (
        "import json,sys,urllib.parse\n"
        f"c='{CANARY}'\n"
        "print('plain', c); print('json', json.dumps(c + '/'))\n"
        "print('pct', urllib.parse.quote(c)); sys.stderr.write('err ' + c[:6]); sys.stderr.flush()\n"
        "sys.stderr.write(c[6:] + '\\n'); sys.exit(1)\n"
    )
    failing = release_plan.Run(
        "child",
        Command((sys.executable, "-c", code), tmp_path, {"CANARY": secret}),
        False,
        release_plan.tool_outcome,
    )
    workspace = release_plan.Workspace(out=tmp_path)
    assert (
        ios_release.execute(session, [failing], workspace, tmp_path / "logs") == Failure.TOOL.value
    )
    shown = capsys.readouterr()
    assert CANARY not in shown.out + shown.err
    assert "<team>" in shown.out
    for log in (tmp_path / "logs").iterdir():
        assert CANARY not in log.read_text()

    def explode(session: ios_release.Session, unsigned: bool) -> int:
        session.redactor = Redactor([secret], {})
        raise RuntimeError(f"bad value {CANARY} in {tmp_path}")

    monkeypatch.setattr(ios_release, "build", explode)
    monkeypatch.setattr(ios_release, "checkout_lock", lambda root: contextlib.nullcontext())
    assert ios_release.main(["build", "--unsigned"]) == Failure.TOOL.value
    out = capsys.readouterr().out
    assert CANARY not in out and "Traceback" not in out and "<team>" in out
    assert not any(CANARY in path.read_text() for path in tmp_path.rglob("*") if path.is_file())


def test_the_environment_is_never_mentioned_by_value_in_an_input_error(tmp_path: Path) -> None:
    _, found = release_inputs.resolve_asc_key(
        {"APPLE_API_KEY": "short", "APPLE_API_ISSUER": "nope"}, tmp_path, tmp_path
    )
    text = " ".join(p.why for p in found)
    assert "short" not in text and "nope" not in text
    assert "is not 10 capital letters or digits" in text and "is not a UUID" in text


def test_the_unsigned_rehearsal_records_the_arguments_xcodebuild_receives(tmp_path: Path) -> None:
    shim = tmp_path / "partial" / "xcodebuild-shim"
    release_plan.write_shim(shim)
    script = (shim / "xcodebuild").read_text()
    assert script.endswith('exec /usr/bin/xcodebuild "$@"\n')
    assert os.access(shim / "xcodebuild", os.X_OK)
    (shim / release_plan.SHIM_LOG).write_text(
        "xcodebuild archive -project /Users/someone/p.xcodeproj\n"
    )
    workspace = release_plan.Workspace(
        out=tmp_path / "partial", redact=Redactor(directories={"home": "/Users/someone"}).redact
    )
    assert release_plan.keep_shim_log(workspace, shim) is None
    assert (tmp_path / "partial/logs/xcodebuild-args.log").read_text() == (
        "xcodebuild archive -project <home>/p.xcodeproj\n"
    )
    assert not shim.exists()


def test_the_kept_arguments_log_is_private_and_never_written_through_a_link(
    tmp_path: Path,
) -> None:
    shim = tmp_path / "partial" / "xcodebuild-shim"
    release_plan.write_shim(shim)
    (shim / release_plan.SHIM_LOG).write_text("xcodebuild archive\n")
    workspace = release_plan.Workspace(out=tmp_path / "partial")
    log = tmp_path / "partial/logs/xcodebuild-args.log"
    log.parent.mkdir(parents=True)
    elsewhere = tmp_path / "elsewhere.txt"
    elsewhere.write_text("untouched")
    log.symlink_to(elsewhere)
    assert release_plan.keep_shim_log(workspace, shim) is None
    assert not log.is_symlink() and stat.S_IMODE(log.stat().st_mode) == 0o600
    assert log.read_text() == "xcodebuild archive\n" and elsewhere.read_text() == "untouched"


def test_url_userinfo_is_masked_in_output_and_exception_lines() -> None:
    redactor = Redactor()
    assert redactor.redact("fetch http://user:hunter2@proxy:8080/x and https://tok@host/y") == (
        "fetch http://<userinfo>@proxy:8080/x and https://<userinfo>@host/y"
    )
    line = redactor.exception_line(OSError("tunnel via http://user:hunter2@proxy:8080 failed"))
    assert "hunter2" not in line and "http://<userinfo>@proxy:8080" in line


def test_a_dry_run_never_prints_a_proxy_password_or_an_unlisted_value(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    secrets_file = tmp_path / "ios.env"
    secrets_file.write_text(f"APPLE_DEVELOPMENT_TEAM={TEAM}\n")
    secrets_file.chmod(0o600)
    monkeypatch.setenv("SHARECUT_IOS_RELEASE_ENV", str(secrets_file))
    monkeypatch.setenv("PODCAST_DISTRIBUTION_PROFILE", str(write_profile(tmp_path / "p.json")))
    monkeypatch.setenv("HTTPS_PROXY", "http://user:hunter2@proxy.example:8080")
    monkeypatch.setenv("SSL_CERT_FILE", "/ca/CERTVALUE.pem")
    monkeypatch.setenv("CARGO_BUILD_JOBS", "4")
    monkeypatch.setattr(ios_release, "git_state", lambda root: ("c" * 40, False))
    monkeypatch.setattr(ios_release, "toolchain", lambda: ("/rustup:/usr/bin", None))
    monkeypatch.setattr(ios_release, "checkout_lock", lambda root: contextlib.nullcontext())
    assert ios_release.main(["build", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "hunter2" not in out and "CERTVALUE" not in out
    assert "HTTPS_PROXY=<set>" in out and "SSL_CERT_FILE=<set>" in out
    assert "CARGO_BUILD_JOBS=4" in out and "APPLE_DEVELOPMENT_TEAM=<team>" in out


def test_a_device_id_is_masked_by_shape() -> None:
    assert Redactor().redact("id:00001111-AAAABBBBCCCCDDDD, name:x") == "id:<device-id>, name:x"


def stage_deliver(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> record_module.ReleaseRecord:
    home = tmp_path / "home"
    key = home / ".appstoreconnect/private_keys" / f"AuthKey_{KEY_ID}.p8"
    key.parent.mkdir(parents=True)
    key.write_text("not read")
    key.chmod(0o600)
    secrets_file = tmp_path / "ios.env"
    secrets_file.write_text(f"APPLE_API_KEY={KEY_ID}\nAPPLE_API_ISSUER={ISSUER}\n")
    secrets_file.chmod(0o600)
    profile = write_profile(tmp_path / "profile.json")
    release_root = tmp_path / "repo/gui/desktop/src-tauri/target/ios-release"
    record = make_record()
    (release_root / record.build_number).mkdir(parents=True)
    record_module.write_record(release_root / record.build_number, record)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setenv("SHARECUT_IOS_RELEASE_ENV", str(secrets_file))
    monkeypatch.setenv("PODCAST_DISTRIBUTION_PROFILE", str(profile))
    monkeypatch.setattr(ios_release, "ROOT", tmp_path / "repo")
    monkeypatch.setattr(ios_release, "toolchain", lambda: ("/p", None))
    monkeypatch.setattr(ios_release, "git_state", lambda root: (record.commit, False))
    monkeypatch.setattr(ios_release, "marketing_version", lambda root: ("0.1.4", []))
    return record


def test_validate_and_upload_dry_runs_show_the_plan_and_the_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    record = stage_deliver(tmp_path, monkeypatch)
    assert ios_release.main(["validate", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert KEY_ID not in out and ISSUER not in out and "--api-key <key-id>" in out
    assert "upload --confirm" not in out.split("dry run")[0] and " 8 validate" in out
    assert ios_release.main(["upload", "--dry-run", "--confirm", record.token()]) == 0
    out = capsys.readouterr().out
    assert " upload guard" in out and "--upload-app" in out


def stage_missing_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, explicit: bool) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home)
    for name in release_inputs.SECRET_NAMES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("PODCAST_DISTRIBUTION_PROFILE", str(write_profile(tmp_path / "p.json")))
    monkeypatch.setattr(ios_release, "toolchain", lambda: ("/p", None))
    monkeypatch.setattr(ios_release, "git_state", lambda root: ("c" * 40, False))
    monkeypatch.setattr(ios_release, "checkout_lock", lambda root: contextlib.nullcontext())
    missing = tmp_path / "gone" / "ios.env"
    if explicit:
        monkeypatch.setenv("SHARECUT_IOS_RELEASE_ENV", str(missing))
    else:
        monkeypatch.delenv("SHARECUT_IOS_RELEASE_ENV", raising=False)
    return missing


def test_a_missing_explicit_file_is_named_and_every_value_the_build_needs_is_listed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    missing = stage_missing_file(tmp_path, monkeypatch, explicit=True)
    assert ios_release.main(["build", "--dry-run"]) == Failure.INPUT.value
    out = capsys.readouterr().out
    assert "gone/ios.env (private file): does not exist" in out and str(missing) not in out
    assert "APPLE_DEVELOPMENT_TEAM (private file or environment): missing" in out
    first = next(line for line in out.splitlines() if line.startswith("  "))
    assert "gone/ios.env (private file): does not exist" in first


def test_a_signed_build_needs_only_the_team_so_a_set_team_and_no_file_is_fine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    stage_missing_file(tmp_path, monkeypatch, explicit=True)
    monkeypatch.setenv("APPLE_DEVELOPMENT_TEAM", TEAM)
    ios_release.main(["build", "--dry-run"])
    assert "does not exist" not in capsys.readouterr().out


def test_a_dangling_link_at_the_private_file_is_refused_not_called_absent(tmp_path: Path) -> None:
    link = tmp_path / "ios.env"
    link.symlink_to(tmp_path / "nowhere")
    values, problems = release_inputs.private_values(
        {"SHARECUT_IOS_RELEASE_ENV": str(link)},
        tmp_path / "repo",
        tmp_path,
        release_inputs.TEAM_SECRETS,
    )
    assert values == {}
    assert "is not a regular file" in [p.why for p in problems]
    assert not any("does not exist" in p.why for p in problems)


def test_a_missing_key_id_is_one_problem_not_two(tmp_path: Path) -> None:
    key, problems = release_inputs.resolve_asc_key({"APPLE_API_ISSUER": ISSUER}, tmp_path, tmp_path)
    assert key is None and [p.name for p in problems] == ["APPLE_API_KEY"]
    key, problems = release_inputs.resolve_asc_key(
        {"APPLE_API_ISSUER": ISSUER, "APPLE_API_KEY": KEY_ID}, tmp_path, tmp_path
    )
    assert [(p.name, p.why) for p in problems] == [
        ("APPLE_API_KEY_PATH", "the key file does not exist")
    ]


def test_key_problems_alone_are_an_input_error_not_a_crash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    stage_deliver(tmp_path, monkeypatch)
    monkeypatch.setenv("APPLE_API_KEY", "bad")
    assert ios_release.main(["validate", "--dry-run"]) == Failure.INPUT.value
    out = capsys.readouterr().out
    assert "APPLE_API_KEY (private file or environment): is not 10 capital letters" in out
    assert "private file): does not exist" not in out


def test_the_banner_follows_the_subcommand_even_for_an_empty_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    stage_deliver(tmp_path, monkeypatch)
    ios_release.main(["upload", "--dry-run", "--confirm", ""])
    assert "ios_release upload 2026" in capsys.readouterr().out
    ios_release.main(["validate", "--dry-run"])
    assert "ios_release validate 2026" in capsys.readouterr().out


def test_the_unsigned_rehearsal_needs_no_secrets_file_at_all(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    stage_missing_file(tmp_path, monkeypatch, explicit=True)
    assert ios_release.main(["build", "--unsigned", "--dry-run"]) == 0
    assert "does not exist" not in capsys.readouterr().out


@pytest.mark.parametrize("command", [["validate"], ["upload", "--confirm", "x:y"]])
def test_a_missing_explicit_file_lists_every_key_value_for_validate_and_upload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    command: list[str],
) -> None:
    missing = stage_missing_file(tmp_path, monkeypatch, explicit=True)
    monkeypatch.setattr(ios_release, "ROOT", tmp_path / "repo")
    monkeypatch.setattr(ios_release, "marketing_version", lambda root: ("0.1.4", []))
    release_root = tmp_path / "repo/gui/desktop/src-tauri/target/ios-release"
    record = make_record()
    (release_root / record.build_number).mkdir(parents=True)
    record_module.write_record(release_root / record.build_number, record)
    assert ios_release.main(command) == Failure.INPUT.value
    out = capsys.readouterr().out
    assert "gone/ios.env (private file): does not exist" in out and str(missing) not in out
    first = next(line for line in out.splitlines() if line.startswith("  "))
    assert "gone/ios.env (private file): does not exist" in first
    for name in ("APPLE_API_KEY", "APPLE_API_ISSUER"):
        assert f"{name} (private file or environment): missing" in out
    assert "APPLE_API_KEY_PATH" not in out


def test_a_missing_default_file_says_where_it_is_expected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    stage_missing_file(tmp_path, monkeypatch, explicit=False)
    assert ios_release.main(["build", "--dry-run"]) == Failure.INPUT.value
    out = capsys.readouterr().out
    assert ".config/sharecut/ios-release.env (default private file): does not exist" in out
    assert "set SHARECUT_IOS_RELEASE_ENV" in out
    assert ios_release.main(["build", "--unsigned", "--dry-run"]) == 0


def test_validate_without_a_build_or_key_is_an_input_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    stage_deliver(tmp_path, monkeypatch)
    assert ios_release.main(["validate", "--dry-run", "--build", "2020.1.1"]) == Failure.INPUT.value
    assert "no finished build" in capsys.readouterr().out
    monkeypatch.setenv("SHARECUT_IOS_RELEASE_ENV", str(tmp_path / "missing.env"))
    assert ios_release.main(["validate", "--dry-run"]) == Failure.INPUT.value
    assert "APPLE_API_KEY (private file or environment): missing" in capsys.readouterr().out


@pytest.mark.parametrize("command", [["validate"], ["upload", "--confirm", "x:y"]])
def test_an_unsigned_rehearsal_is_refused_before_anything_is_run(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    command: list[str],
) -> None:
    record = stage_deliver(tmp_path, monkeypatch)
    release_root = tmp_path / "repo/gui/desktop/src-tauri/target/ios-release"
    rehearsal = make_record(build_number="2026.1115.1", signing="none")
    (release_root / rehearsal.build_number).mkdir()
    record_module.write_record(release_root / rehearsal.build_number, rehearsal)
    ran: list[Command] = []
    monkeypatch.setattr(ios_release, "spawn", lambda cmd, *rest: ran.append(cmd))
    assert ios_release.main(command) == Failure.INPUT.value
    out = capsys.readouterr().out
    assert ran == [] and "unsigned rehearsal and cannot be sent to Apple" in out
    assert "build (2026.1115.1)" in out and record.build_number not in out


def upload_plan(tmp_path: Path, record: record_module.ReleaseRecord, **options: bool):
    expect = checks.PlistExpectation(
        "studio.sharecut.app", "ShareCut", "0.1.4", record.build_number
    )
    steps = release_deliver.plan_deliver(
        tmp_path,
        record,
        fake_key(),
        LAYOUT,
        NOISY,
        "/p",
        expect,
        confirm=record.token(),
        git_state=lambda: (record.commit, False),
        **options,
    )
    workspace = release_plan.Workspace(
        out=tmp_path,
        sha256=record.ipa_sha256,
        build_number=record.build_number,
        signing=Signing.APP_STORE,
    )
    return steps_by_name(steps), workspace


def interrupted_record() -> record_module.ReleaseRecord:
    record = make_record()
    record.uploads.append({"ipa_sha256": record.ipa_sha256, "started_at": "t", "outcome": None})
    return record


def test_an_upload_with_no_recorded_outcome_blocks_a_retry_until_overridden(
    tmp_path: Path,
) -> None:
    record = interrupted_record()
    steps, workspace = upload_plan(tmp_path, record)
    report = steps["upload guard"].action(workspace)
    assert len(report.problems) == 1
    assert "check TestFlight for build 2026.1114.153045" in report.problems[0]
    assert "--retry-unknown-upload" in report.problems[0]

    steps, workspace = upload_plan(tmp_path, record, retry_unknown_upload=True)
    assert steps["upload guard"].action(workspace).problems == ()


def test_a_finished_attempt_or_another_files_open_attempt_does_not_block(tmp_path: Path) -> None:
    record = make_record()
    record.uploads.append(
        {"ipa_sha256": record.ipa_sha256, "outcome": {"verdict": "rejected", "at": "t"}}
    )
    record.uploads.append({"ipa_sha256": "00" * 32, "outcome": None})
    steps, workspace = upload_plan(tmp_path, record)
    assert steps["upload guard"].action(workspace).problems == ()


def test_the_attempt_is_on_disk_before_the_upload_and_the_override_is_recorded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    synced: list[int] = []
    monkeypatch.setattr(os, "fsync", synced.append)
    record = interrupted_record()
    steps, workspace = upload_plan(tmp_path, record, retry_unknown_upload=True)
    steps["record upload attempt"].action(workspace)
    assert synced
    on_disk = record_module.read_record(tmp_path).uploads
    assert [row["outcome"] for row in on_disk] == [None, None]
    assert on_disk[-1]["retried_unknown_upload"] is True
    assert "retried_unknown_upload" not in on_disk[0]

    fresh = make_record()
    steps, workspace = upload_plan(tmp_path, fresh, retry_unknown_upload=True)
    steps["record upload attempt"].action(workspace)
    assert "retried_unknown_upload" not in record_module.read_record(tmp_path).uploads[-1]


def test_the_retry_flag_belongs_to_upload_only() -> None:
    parsed = ios_release.parser().parse_args(
        ["upload", "--confirm", "x:y", "--retry-unknown-upload"]
    )
    assert parsed.retry_unknown_upload is True
    with pytest.raises(SystemExit):
        ios_release.parser().parse_args(["validate", "--retry-unknown-upload"])


GUARD_EXIT = 10
GOOD_LISTING = json.dumps({"applications": [{"BundleId": "studio.sharecut.app"}]})


def fake_apple(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    ipa_bytes: bytes = b"the ipa",
    ipa_build: str = "2026.1114.153045",
    signing: Signing = Signing.APP_STORE,
    answers: dict[str, tuple[int, str]] | None = None,
) -> list[Command]:
    """Fake the Mac-only checks and altool; *answers* maps an altool flag to its exit code and
    output, and a flag without one gets a success."""
    answers = {} if answers is None else answers

    def plist(ws: release_plan.Workspace, expect: object) -> checks.CheckReport:
        ws.build_number = ipa_build
        return checks.CheckReport("info plist")

    def signature(ws: release_plan.Workspace) -> checks.CheckReport:
        ws.signing = signing
        return checks.CheckReport("signature")

    monkeypatch.setattr(release_plan, "unpack", lambda ws: tmp_path)
    monkeypatch.setattr(
        release_plan, "scan_check", lambda ws, root: checks.CheckReport("path scan")
    )
    monkeypatch.setattr(release_plan, "plist_check", plist)
    monkeypatch.setattr(release_plan, "privacy_check", lambda ws: checks.CheckReport("privacy"))
    monkeypatch.setattr(release_plan, "signature_check", signature)
    monkeypatch.setattr(checks, "check_layout", lambda app: checks.CheckReport("bundle layout"))

    ran: list[Command] = []

    def fake_spawn(command: Command, redactor: Redactor, log: Path | None = None):
        ran.append(command)
        assert all(isinstance(part, (str, Secret)) for part in command.argv)
        flag = next(
            (f for f in ("--list-apps", "--validate-app", "--upload-app") if f in command.argv), ""
        )
        default = (0, GOOD_LISTING if flag == "--list-apps" else ALTOOL_OK)
        code, text = answers.get(flag, default)
        staged = [str(p) for p in command.argv if str(p).endswith("app.ipa")]
        assert all(Path(p).read_bytes() == ipa_bytes for p in staged)
        return release_run.SpawnResult(code, "", text)

    monkeypatch.setattr(ios_release, "spawn", fake_spawn)
    return ran


def drive_upload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    dirty: bool = False,
    head: str = "a" * 40,
    ipa_bytes: bytes = b"the ipa",
    ipa_build: str = "2026.1114.153045",
    signing: Signing = Signing.APP_STORE,
    answers: dict[str, tuple[int, str]] | None = None,
    record: record_module.ReleaseRecord | None = None,
    retry_unknown_upload: bool = False,
) -> tuple[int, list[Command], record_module.ReleaseRecord, Path]:
    """Run the real upload plan with the Mac-only checks and altool faked; pass the returned
    record back in to run a second attempt against what the first one wrote."""
    ipa = tmp_path / "2026.1114.153045.ipa"
    if record is None:
        ipa.write_bytes(b"the ipa")
        record = make_record(ipa_sha256=record_module.sha256_file(ipa), ipa_name=ipa.name)
    ipa.write_bytes(ipa_bytes)
    record_module.write_record(tmp_path, record)
    ran = fake_apple(
        monkeypatch,
        tmp_path,
        ipa_bytes=ipa_bytes,
        ipa_build=ipa_build,
        signing=signing,
        answers=answers,
    )
    expect = checks.PlistExpectation(
        "studio.sharecut.app", "ShareCut", "0.1.4", record.build_number
    )
    steps = release_deliver.plan_deliver(
        tmp_path,
        record,
        fake_key(),
        LAYOUT,
        NOISY,
        "/p",
        expect,
        confirm=f"{record.build_number}:{record.ipa_sha256[:12]}",
        git_state=lambda: (head, dirty),
        retry_unknown_upload=retry_unknown_upload,
    )
    session = ios_release.Session(tmp_path, dry_run=False)
    workspace = release_plan.Workspace(out=tmp_path, build_number=record.build_number)
    try:
        code = ios_release.execute(session, steps, workspace, tmp_path / "logs")
    finally:
        workspace.cleanup()
    return code, ran, record, ipa


def test_an_upload_that_agrees_everywhere_sends_the_staged_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    code, ran, record, ipa = drive_upload(tmp_path, monkeypatch)
    assert code == 0
    sent = [c for c in ran if any(a in c.argv for a in ("--validate-app", "--upload-app"))]
    assert [("--validate-app" in c.argv) for c in sent] == [True, False]
    for command in sent:
        file = Path(str(command.argv[command.argv.index("-f") + 1]))
        assert file != ipa and file.name == "app.ipa"
        assert file.parent.name.startswith("sharecut-ios-stage-")
    attempt = record_module.read_record(tmp_path).uploads[0]
    assert attempt["outcome"]["verdict"] == "ok" and attempt["ipa_sha256"] == record.ipa_sha256


@pytest.mark.parametrize(
    "change",
    [
        {"dirty": True},
        {"head": "f" * 40},
        {"ipa_bytes": b"another ipa"},
        {"ipa_build": "2026.1114.153046"},
        {"signing": Signing.NONE},
    ],
    ids=["dirty-tree", "other-head", "other-ipa-bytes", "other-ipa-build", "not-app-store"],
)
def test_the_upload_guard_judges_the_ipa_and_the_checkout_not_the_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: dict[str, object]
) -> None:
    code, ran, _, _ = drive_upload(tmp_path, monkeypatch, **change)
    assert code == GUARD_EXIT != Failure.HYGIENE.value
    assert ran == []


UNREACHABLE = (1, altool_error("Could not connect to the server"))
REFUSED = (1, apple_error("Invalid binary"))


def uploads_sent(ran: list[Command]) -> int:
    return sum("--upload-app" in command.argv for command in ran)


def test_an_unreachable_upload_is_unresolved_and_a_retry_needs_the_flag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    unreachable = {"--upload-app": UNREACHABLE}
    code, ran, record, _ = drive_upload(tmp_path, monkeypatch, answers=unreachable)
    assert code == Failure.TOOL.value and uploads_sent(ran) == 1
    attempt = record_module.read_record(tmp_path).uploads[0]
    assert attempt["outcome"] is None
    assert attempt["last_answer"]["verdict"] == "unreachable"
    assert attempt["last_answer"]["messages"] == [
        "altool exited 1 without an answer",
        UNREACHABLE[1],
    ]
    assert "nothing was changed" not in capsys.readouterr().out

    code, ran, record, _ = drive_upload(tmp_path, monkeypatch, record=record)
    assert code == GUARD_EXIT and ran == []
    assert "--retry-unknown-upload" in capsys.readouterr().out

    code, ran, record, _ = drive_upload(
        tmp_path, monkeypatch, record=record, retry_unknown_upload=True
    )
    assert code == 0 and uploads_sent(ran) == 1
    retry = record_module.read_record(tmp_path).uploads[1]
    assert retry["retried_unknown_upload"] is True and retry["outcome"]["verdict"] == "ok"


def test_a_rejected_upload_is_a_finished_attempt_that_does_not_block(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    code, _, record, _ = drive_upload(tmp_path, monkeypatch, answers={"--upload-app": REFUSED})
    assert code == Failure.APPLE_REJECTED.value
    attempt = record_module.read_record(tmp_path).uploads[0]
    assert attempt["outcome"]["verdict"] == "rejected" and "last_answer" not in attempt

    code, ran, _, _ = drive_upload(tmp_path, monkeypatch, record=record)
    assert code == 0 and uploads_sent(ran) == 1


def test_the_unreachable_sentence_says_the_upload_may_have_arrived(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    drive_upload(tmp_path, monkeypatch, answers={"--upload-app": UNREACHABLE})
    uploaded = capsys.readouterr().out.split("upload failed: ")[1].splitlines()[0]
    assert uploaded.count(".") == 1 and "nothing was changed" not in uploaded
    assert "Apple may or may not have received the build" in uploaded
    assert "TestFlight" in uploaded and "only if it is not there" in uploaded
    assert "--retry-unknown-upload" in uploaded

    drive_upload(tmp_path, monkeypatch, answers={"--validate-app": UNREACHABLE})
    validated = capsys.readouterr().out
    assert "validate: Apple could not be reached; nothing was changed." in validated


def test_an_unreachable_validate_records_a_finished_row_and_blocks_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    code, ran, record, _ = drive_upload(
        tmp_path, monkeypatch, answers={"--validate-app": UNREACHABLE}
    )
    assert code == Failure.TOOL.value and uploads_sent(ran) == 0
    assert record_module.read_record(tmp_path).validations[0]["verdict"] == "unreachable"
    assert record.unresolved_uploads(record.ipa_sha256) == []


class Answer(NamedTuple):
    """What altool printed, and the verdict ``validate`` reads from it (it is looser than upload)."""

    code: int
    text: str
    validate: str

    @property
    def altool(self) -> tuple[int, str]:
        return self.code, self.text


DEEP = '{"a": ' + "[" * 200_000 + "]" * 200_000 + "}"
HUGE_INT = '{"a": ' + "9" * 5000 + "}"
NO_ANSWER = {
    "killed-9": Answer(-9, "", "rejected"),
    "killed-15": Answer(-15, "", "rejected"),
    "exit-137": Answer(137, "", "rejected"),
    "ssl-handshake": Answer(1, "SSL error: handshake failed", "rejected"),
    "broken-pipe": Answer(1, "Broken pipe", "rejected"),
    "unexpected-eof": Answer(1, "Unexpected EOF", "rejected"),
    "dns": Answer(1, "nodename nor servname provided, or not known", "rejected"),
    "dns-resolve": Answer(
        1, "Could not resolve host: contentdelivery.itunes.apple.com", "rejected"
    ),
    "proxy-502-html": Answer(
        1, "<html><body><h1>Proxy Error 502 Bad Gateway</h1></body></html>", "rejected"
    ),
    "proxy-503-text": Answer(1, "Service Unavailable (503)", "rejected"),
    "server-500": Answer(1, "Server error 500", "rejected"),
    "network-with-403": Answer(1, "network error contacting the server, status 403", "auth_failed"),
    "empty-nonzero": Answer(1, "", "rejected"),
    "exit-0-no-answer": Answer(0, "", "ok"),
    "exit-0-text": Answer(0, "uploading... done", "ok"),
    "structured-transport": Answer(
        1, altool_error("An SSL error occurred (NSURLErrorDomain -1200)"), "rejected"
    ),
    "structured-hostname": Answer(
        1, altool_error("A server with the specified hostname could not be found."), "rejected"
    ),
    "structured-500": Answer(1, altool_error("Internal Server Error (500)"), "rejected"),
    "structured-posix": Answer(
        1,
        altool_error("The operation couldn't be completed. (NSPOSIXErrorDomain error 54.)"),
        "rejected",
    ),
    "structured-apple-code-with-transport": Answer(
        1, apple_error("ITMS-90000 proxy error"), "rejected"
    ),
    "apple-code-with-refused": Answer(1, apple_error("Connection refused"), "rejected"),
    "apple-token-with-5xx": Answer(1, altool_error("HTTP status code 503 ITMS-90000"), "rejected"),
    "empty-entry": Answer(1, '{"product-errors": [{}]}', "rejected"),
    "malformed-string": Answer(1, '{"product-errors": "boom"}', "rejected"),
    "malformed-int": Answer(1, '{"product-errors": 5}', "rejected"),
    "malformed-int-exit-0": Answer(0, '{"product-errors": 5}', "ok"),
    "malformed-dict": Answer(1, '{"product-errors": {"a": 1}}', "rejected"),
    "malformed-string-entry": Answer(1, '{"product-errors": ["boom"]}', "rejected"),
    "malformed-null-entry": Answer(1, '{"product-errors": [null]}', "rejected"),
    "malformed-user-info": Answer(1, '{"product-errors": [{"userInfo": "x"}]}', "rejected"),
    "json-list": Answer(0, "[]", "ok"),
    "json-list-exit-1": Answer(1, "[]", "rejected"),
    "json-scalar": Answer(0, "5", "ok"),
    "empty-object-exit-0": Answer(0, "{}", "ok"),
    "object-without-errors-exit-1": Answer(1, ALTOOL_OK, "rejected"),
    "warning-before-truncated-json": Answer(
        0, 'warning: slow\n{"tool-version": "26.10.1", "succ', "ok"
    ),
    "truncated-outer-with-inner-object": Answer(
        0, '{\n  "success-message": "ok",\n  "detail":\n{"inner": 1}\n', "ok"
    ),
    "json-list-before-object": Answer(0, "[1]\n" + ALTOOL_OK, "rejected"),
    "text-after-json": Answer(0, ALTOOL_OK + "\nuploaded", "rejected"),
    "network-warning-before-success": Answer(
        0, "network connection lost, retrying\n" + ALTOOL_OK, "ok"
    ),
    "deep-nesting-exit-0": Answer(0, DEEP, "ok"),
    "deep-nesting-exit-1": Answer(1, DEEP, "rejected"),
    "huge-integer-exit-0": Answer(0, HUGE_INT, "ok"),
    "huge-integer-exit-1": Answer(1, HUGE_INT, "rejected"),
    "braces-flood": Answer(0, "{}\n" * 32_000, "ok"),
}


@pytest.mark.parametrize("case", sorted(NO_ANSWER))
def test_an_upload_with_no_answer_from_apple_stays_unresolved_until_retried(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    case: str,
) -> None:
    code, ran, record, _ = drive_upload(
        tmp_path, monkeypatch, answers={"--upload-app": NO_ANSWER[case].altool}
    )
    out = capsys.readouterr().out
    assert code == Failure.TOOL.value and uploads_sent(ran) == 1
    assert "Apple may or may not have received the build" in out
    attempt = record_module.read_record(tmp_path).uploads[0]
    assert attempt["outcome"] is None
    assert attempt["last_answer"]["verdict"] == "unreachable" and attempt["last_answer"]["messages"]

    code, ran, record, _ = drive_upload(tmp_path, monkeypatch, record=record)
    assert code == GUARD_EXIT and uploads_sent(ran) == 0 and ran == []
    assert "--retry-unknown-upload" in capsys.readouterr().out

    code, ran, _, _ = drive_upload(tmp_path, monkeypatch, record=record, retry_unknown_upload=True)
    assert code == 0 and uploads_sent(ran) == 1
    retry = record_module.read_record(tmp_path).uploads[1]
    assert retry["retried_unknown_upload"] is True and retry["outcome"]["verdict"] == "ok"


@pytest.mark.parametrize("case", sorted(NO_ANSWER))
def test_validate_and_the_app_record_lookup_keep_their_answers_for_the_same_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    code, ran, record, _ = drive_upload(
        tmp_path, monkeypatch, answers={"--validate-app": NO_ANSWER[case].altool}
    )
    row = record_module.read_record(tmp_path).validations[0]
    assert row["verdict"] == NO_ANSWER[case].validate
    assert record.unresolved_uploads(record.ipa_sha256) == []
    assert uploads_sent(ran) == (1 if NO_ANSWER[case].validate == "ok" else 0)

    tmp = tmp_path / "lookup"
    tmp.mkdir()
    code, ran, _, _ = drive_upload(
        tmp, monkeypatch, answers={"--list-apps": NO_ANSWER[case].altool}
    )
    assert code == Failure.APPLE_REJECTED.value
    assert not any("--validate-app" in c.argv for c in ran)
    assert record_module.read_record(tmp).validations == []


def test_a_duplicate_upload_is_apples_answer_and_blocks_a_second_upload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    duplicate = (1, altool_error("Redundant Binary Upload. There already exists a binary upload"))
    code, _, record, _ = drive_upload(tmp_path, monkeypatch, answers={"--upload-app": duplicate})
    assert code == Failure.DUPLICATE_BUILD.value
    attempt = record_module.read_record(tmp_path).uploads[0]
    assert attempt["outcome"]["verdict"] == "apple_reports_duplicate"
    assert "last_answer" not in attempt
    code, ran, _, _ = drive_upload(tmp_path, monkeypatch, record=record)
    assert code == GUARD_EXIT and ran == []


def test_a_duplicate_named_only_in_user_info_is_a_duplicate_everywhere(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    text = altool_error("Validation failed").replace(
        '"Validation failed"',
        '"Validation failed", "userInfo": {"NSLocalizedFailureReason": "Redundant Binary Upload"}',
    )
    assert release_classify.classify_upload(1, text).verdict is Verdict.DUPLICATE
    assert release_classify.classify_altool(1, text).verdict is Verdict.DUPLICATE
    code, _, record, _ = drive_upload(tmp_path, monkeypatch, answers={"--upload-app": (1, text)})
    assert code == Failure.DUPLICATE_BUILD.value
    code, ran, _, _ = drive_upload(tmp_path, monkeypatch, record=record)
    assert code == GUARD_EXIT and ran == []


APPLE_ANSWERS = {
    "itms": (apple_error("Invalid Bundle"), Verdict.REJECTED),
    "itms-in-user-info": (
        json.dumps(
            {"product-errors": [{"userInfo": {"NSLocalizedDescription": "ITMS-90161: bad"}}]}
        ),
        Verdict.REJECTED,
    ),
    "api-code": (
        json.dumps(
            {"product-errors": [{"code": "ENTITY_ERROR.ATTRIBUTE.INVALID", "message": "x"}]}
        ),
        Verdict.REJECTED,
    ),
    "api-auth-code": (
        json.dumps({"product-errors": [{"code": "NOT_AUTHORIZED", "message": "x"}]}),
        Verdict.REJECTED,
    ),
    "apple-domain": (
        json.dumps(
            {"product-errors": [{"domain": "ITunesSoftwareServiceErrorDomain", "message": "x"}]}
        ),
        Verdict.REJECTED,
    ),
    "apple-domain-in-text": (
        json.dumps(
            {
                "product-errors": [
                    {
                        "message": "x",
                        "userInfo": {
                            "NSUnderlyingError": "Error Domain=ContentDeliveryErrorDomain Code=1"
                        },
                    }
                ]
            }
        ),
        Verdict.REJECTED,
    ),
    "itms-auth": (apple_error("401 unauthorized"), Verdict.AUTH_FAILED),
}
NOT_APPLE_ANSWERS = {
    "system-domain": {"domain": "NSURLErrorDomain", "message": "x"},
    "posix-domain": {"domain": "NSPOSIXErrorDomain", "message": "x"},
    "cocoa-domain": {"domain": "NSCocoaErrorDomain", "message": "x"},
    "cfnetwork-domain": {"domain": "kCFErrorDomainCFNetwork", "message": "x"},
    "lowercase-code": {"code": "connection_refused", "message": "x"},
    "unlisted-code": {"code": "CONNECTION_REFUSED", "message": "x"},
    "numeric-code": {"code": 54, "message": "x"},
    "code-in-message-only": {"message": "ENTITY_ERROR"},
    "lookalike-domain": {"domain": "MyITunesDomain", "message": "x"},
}


@pytest.mark.parametrize("case", sorted(APPLE_ANSWERS))
def test_a_structured_error_with_an_apple_shape_finishes_the_attempt(case: str) -> None:
    text, verdict = APPLE_ANSWERS[case]
    assert release_classify.classify_upload(1, text).verdict is verdict


@pytest.mark.parametrize("case", sorted(NOT_APPLE_ANSWERS))
def test_a_structured_error_without_an_apple_shape_leaves_the_attempt_unresolved(
    case: str,
) -> None:
    text = json.dumps({"product-errors": [NOT_APPLE_ANSWERS[case]]})
    assert release_classify.classify_upload(1, text).verdict is Verdict.UNREACHABLE


@pytest.mark.parametrize(
    "wording",
    [
        "could not connect",
        "network",
        "timed out",
        "offline",
        "unreachable",
        "connection was lost",
        "connection reset",
        "SSL",
        "TLS",
        "handshake",
        "broken pipe",
        "unexpected EOF",
        "could not resolve host",
        "nodename nor servname",
        "name or service not known",
        "DNS",
        "proxy",
        "bad gateway",
        "service unavailable",
        "gateway timeout",
        "NSURLErrorDomain",
        "NSPOSIXErrorDomain",
        "NSCocoaErrorDomain",
        "kCFErrorDomainCFNetwork",
        "secure connection",
        "hostname could not be found",
        "A server with the specified hostname could not be found",
        "cannot connect to host",
        "cannot find host",
        "connection refused",
        "connection closed unexpectedly",
        "socket closed by remote peer",
        "Internal Server Error (500)",
        "HTTP status code 500",
        "status code 503",
        "HTTP/1.1 502",
        "server error 500",
        "service is temporarily unavailable",
    ],
)
def test_transport_wording_beside_an_apple_code_leaves_the_attempt_unresolved(
    wording: str,
) -> None:
    in_code_field = apple_error(f"{wording} while uploading")
    in_message = altool_error(f"{wording} while uploading ITMS-90022")
    for text in (in_code_field, in_message):
        assert release_classify.classify_upload(1, text).verdict is Verdict.UNREACHABLE


@pytest.mark.parametrize(
    "message",
    [
        "Invalid Bundle. The icon is 500 bytes",
        "ITMS-90500: the bundle is missing an icon",
        "Invalid Bundle, build 2026.1114.153045 ITMS-90022",
        "Invalid Bundle. Error code 5000 ITMS-90022",
        "The status of the bundle is 404 ITMS-90022",
    ],
)
def test_a_three_digit_number_without_http_context_is_not_transport_wording(message: str) -> None:
    answer = release_classify.classify_upload(1, apple_error(message))
    assert answer.verdict is Verdict.REJECTED


def test_the_cfnetwork_domain_is_caught_by_the_network_wording_so_it_needs_no_alternative() -> None:
    assert "kcferrordomaincfnetwork" not in release_classify.TRANSPORT.pattern
    assert release_classify.NETWORK.search("kCFErrorDomainCFNetwork")
    answer = release_classify.classify_upload(1, apple_error("kCFErrorDomainCFNetwork 2"))
    assert answer.verdict is Verdict.UNREACHABLE


@pytest.mark.parametrize(
    ("code", "text", "verdict"),
    [
        (0, "warning: slow link\n" + ALTOOL_OK, Verdict.OK),
        (0, "w1\nw2\n" + ALTOOL_OK, Verdict.OK),
        (
            0,
            json.dumps({"success-message": "uploaded; App Store processing the build"}),
            Verdict.OK,
        ),
        (1, "warning: slow link\n" + apple_error("Invalid Bundle"), Verdict.REJECTED),
        (0, "warning: slow link\n" + apple_error("Invalid Bundle"), Verdict.REJECTED),
        (0, "warning\n" + ALTOOL_OK + "\nuploaded", Verdict.UNREACHABLE),
        (0, "warning\n" + ALTOOL_OK[:-4], Verdict.UNREACHABLE),
        (0, "warning: {not json}\n" + ALTOOL_OK + "}", Verdict.UNREACHABLE),
        (0, "warning\n[1]", Verdict.UNREACHABLE),
        (0, "[1]\n" + ALTOOL_OK, Verdict.UNREACHABLE),
        (0, '"warning"\n' + ALTOOL_OK, Verdict.UNREACHABLE),
        (0, "  {\n" + ALTOOL_OK, Verdict.UNREACHABLE),
        (0, "warning: network connection lost\n" + ALTOOL_OK, Verdict.UNREACHABLE),
        (1, "warning: slow link\n" + altool_error("Invalid Bundle"), Verdict.UNREACHABLE),
    ],
)
def test_a_warning_line_before_apples_json_does_not_hide_the_answer_but_trailing_text_does(
    code: int, text: str, verdict: Verdict
) -> None:
    assert release_classify.classify_upload(code, text).verdict is verdict


def test_a_success_object_with_a_message_on_exit_0_is_delivered(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out = "warning: slow link\n" + json.dumps({"success-message": "uploaded; App Store processing"})
    code, ran, _, _ = drive_upload(tmp_path, monkeypatch, answers={"--upload-app": (0, out)})
    attempt = record_module.read_record(tmp_path).uploads[0]
    assert code == 0 and uploads_sent(ran) == 1
    assert attempt["outcome"]["verdict"] == "ok" and "last_answer" not in attempt


def test_an_unresolved_upload_keeps_the_exit_line_and_a_bounded_copy_of_the_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lines = [f"line {n} " + "x" * 300 for n in range(8)]
    out = "\n\n".join(lines)
    code, _, _, _ = drive_upload(tmp_path, monkeypatch, answers={"--upload-app": (1, out)})
    kept = record_module.read_record(tmp_path).uploads[0]["last_answer"]["messages"]
    assert code == Failure.TOOL.value
    assert kept == ["altool exited 1 without an answer", *(line[:200] for line in lines[:5])]


@pytest.mark.parametrize(
    ("text", "verdict"),
    [
        (apple_error("Authentication failed: 401 unauthorized"), "auth_failed"),
        (apple_error("Invalid Bundle. The bundle is missing an icon"), "rejected"),
    ],
    ids=["structured-auth", "structured-rejection"],
)
def test_apples_own_structured_errors_finish_the_upload_attempt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, text: str, verdict: str
) -> None:
    code, _, record, _ = drive_upload(tmp_path, monkeypatch, answers={"--upload-app": (1, text)})
    assert code == Failure.APPLE_REJECTED.value
    attempt = record_module.read_record(tmp_path).uploads[0]
    assert attempt["outcome"]["verdict"] == verdict and "last_answer" not in attempt
    code, ran, _, _ = drive_upload(tmp_path, monkeypatch, record=record)
    assert code == 0 and uploads_sent(ran) == 1


@pytest.mark.parametrize(
    ("code", "text", "verdict"),
    [
        (0, ALTOOL_OK, Verdict.OK),
        (0, "", Verdict.UNREACHABLE),
        (0, apple_error("Invalid Bundle"), Verdict.REJECTED),
        (0, altool_error("Invalid Bundle"), Verdict.UNREACHABLE),
        (1, altool_error("Redundant Binary Upload"), Verdict.DUPLICATE),
        (1, "Redundant Binary Upload", Verdict.UNREACHABLE),
        (1, apple_error("Authentication failed: 401 unauthorized"), Verdict.AUTH_FAILED),
        (1, altool_error("Authentication failed: 401 unauthorized"), Verdict.UNREACHABLE),
        (1, apple_error("network error, status 403"), Verdict.UNREACHABLE),
        (1, apple_error("Invalid Bundle. The bundle is missing an icon"), Verdict.REJECTED),
        (1, altool_error("Invalid Bundle. The bundle is missing an icon"), Verdict.UNREACHABLE),
        (1, "plain text failure", Verdict.UNREACHABLE),
        (1, "null", Verdict.UNREACHABLE),
        (1, "[]", Verdict.UNREACHABLE),
        (0, "[]", Verdict.UNREACHABLE),
        (0, "5", Verdict.UNREACHABLE),
        (0, "{}", Verdict.UNREACHABLE),
        (1, "{}", Verdict.UNREACHABLE),
        (1, ALTOOL_OK, Verdict.UNREACHABLE),
        (0, '{"product-errors": []}', Verdict.OK),
    ],
)
def test_the_upload_classifier_accepts_only_apples_own_answer(
    code: int, text: str, verdict: Verdict
) -> None:
    assert release_classify.classify_upload(code, text).verdict is verdict


def stage_main_upload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, interrupted: bool
) -> tuple[Path, list[Command]]:
    """The `main` entry over a staged release directory, with the Mac-only checks and altool faked."""
    stage_deliver(tmp_path, monkeypatch)
    directory = tmp_path / "repo/gui/desktop/src-tauri/target/ios-release/2026.1114.153045"
    ipa = directory / "2026.1114.153045.ipa"
    ipa.write_bytes(b"the ipa")
    sha256 = record_module.sha256_file(ipa)
    record = make_record(ipa_sha256=sha256, ipa_name=ipa.name)
    if interrupted:
        record.uploads.append({"ipa_sha256": sha256, "started_at": "t", "outcome": None})
    record_module.write_record(directory, record)
    return directory, fake_apple(monkeypatch, directory)


@pytest.mark.parametrize(
    ("interrupted", "flags", "confirm", "code", "sent"),
    [
        (False, [], "token", 0, 1),
        (False, ["--retry-unknown-upload"], "token", 0, 1),
        (True, [], "token", GUARD_EXIT, 0),
        (True, ["--retry-unknown-upload"], "token", 0, 1),
        (False, [], "2026.1114.153045:000000000000", GUARD_EXIT, 0),
        (True, ["--retry-unknown-upload"], "2026.1114.153045:000000000000", GUARD_EXIT, 0),
    ],
    ids=[
        "fresh",
        "fresh-with-flag",
        "interrupted-without-flag",
        "interrupted-with-flag",
        "wrong-token",
        "wrong-token-with-flag",
    ],
)
def test_main_passes_the_confirm_token_and_the_retry_flag_to_the_upload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    interrupted: bool,
    flags: list[str],
    confirm: str,
    code: int,
    sent: int,
) -> None:
    directory, ran = stage_main_upload(tmp_path, monkeypatch, interrupted=interrupted)
    record = record_module.read_record(directory)
    token = record.token() if confirm == "token" else confirm
    assert ios_release.main(["upload", "--confirm", token, *flags]) == code
    assert uploads_sent(ran) == sent
    attempts = record_module.read_record(directory).uploads
    assert len(attempts) == len(record.uploads) + sent
    if sent:
        assert attempts[-1].get("retried_unknown_upload", False) is (interrupted and bool(flags))
        assert attempts[-1]["outcome"]["verdict"] == "ok"


def test_main_needs_a_confirm_token_to_upload_and_validate_never_uploads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    directory, ran = stage_main_upload(tmp_path, monkeypatch, interrupted=False)
    with pytest.raises(SystemExit):
        ios_release.main(["upload"])
    assert ran == []
    assert ios_release.main(["validate"]) == 0
    assert uploads_sent(ran) == 0 and any("--validate-app" in c.argv for c in ran)
    assert record_module.read_record(directory).uploads == []


TRUNCATED_OUTER = '{\n  "success-message": "ok",\n  "detail":\n{"inner": 1}\n'


@pytest.mark.parametrize(
    ("text", "found"),
    [
        (ALTOOL_OK, True),
        ("warning: slow link\n" + ALTOOL_OK, True),
        ("warning\n" + json.dumps({"a": {"b": 1}}, indent=2), True),
        (ALTOOL_OK + "\n\n", True),
        (TRUNCATED_OUTER, False),
        ("warning\n" + TRUNCATED_OUTER, False),
        ('{"a": 1}\n{"b": 2}', False),
        ("{}\n{}", False),
        ("[1]\n" + ALTOOL_OK, False),
        ("  " + ALTOOL_OK, False),
        ("{" + '"a": "' + "x" * release_run.OUTPUT_LIMIT + '"}', False),
    ],
    ids=[
        "object",
        "warning-then-object",
        "pretty-object-with-a-nested-one",
        "trailing-blank-lines",
        "truncated-outer-with-an-inner-object-that-parses",
        "warning-then-truncated-outer",
        "two-objects",
        "two-empty-objects",
        "json-looking-line-before",
        "indented-start",
        "output-as-long-as-the-captured-tail",
    ],
)
def test_the_document_is_the_one_object_that_ends_the_output(text: str, found: bool) -> None:
    assert (release_classify.altool_document(text) is not None) is found


@pytest.mark.parametrize("flood", ["{}\n" * 32_000, "{\n" * 32_000, ('{"a":\n' * 20_000)])
def test_parsing_never_searches_the_output_for_a_start(
    monkeypatch: pytest.MonkeyPatch, flood: str
) -> None:
    attempts = []
    real = json.loads

    def counting(*args: object, **kwargs: object) -> object:
        attempts.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(json, "loads", counting)
    assert release_classify.altool_document(flood) is None
    assert release_classify.classify_upload(0, flood).verdict is Verdict.UNREACHABLE
    assert release_classify.classify_altool(0, flood).verdict is Verdict.OK
    assert not release_classify.app_record_exists(flood, "studio.sharecut.app")
    assert len(attempts) <= 4


@pytest.mark.parametrize("text", [DEEP, HUGE_INT], ids=["deep-nesting", "huge-integer"])
@pytest.mark.parametrize("code", [0, 1])
def test_a_parser_limit_is_no_document_on_upload_validate_and_the_lookup(
    text: str, code: int
) -> None:
    assert release_classify.altool_document(text) is None
    assert release_classify.classify_upload(code, text).verdict is Verdict.UNREACHABLE
    assert release_classify.classify_altool(code, text).verdict is (
        Verdict.OK if code == 0 else Verdict.REJECTED
    )
    assert not release_classify.app_record_exists(text, "studio.sharecut.app")


@pytest.mark.parametrize("flag", ["--validate-app", "--list-apps"])
@pytest.mark.parametrize(
    "text",
    ['{"product-errors": "boom"}', '{"product-errors": [{}]}', '{"product-errors": [null]}'],
)
def test_an_answer_with_no_message_still_prints_a_complete_sentence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    flag: str,
    text: str,
) -> None:
    code, _, _, _ = drive_upload(tmp_path, monkeypatch, answers={flag: (1, text)})
    out = capsys.readouterr().out
    assert code == Failure.APPLE_REJECTED.value
    assert "Apple rejected the build and gave no readable reason" in out
    assert not any(line.rstrip().endswith(":") for line in out.splitlines())


@pytest.mark.parametrize("flag", ["--validate-app", "--list-apps"])
def test_a_rejection_with_a_message_prints_the_message(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    flag: str,
) -> None:
    drive_upload(tmp_path, monkeypatch, answers={flag: (1, apple_error("Invalid Bundle"))})
    assert "Apple rejected the build: Invalid Bundle" in capsys.readouterr().out


def many_errors(count: int, message: str) -> str:
    entries = [{"code": "ITMS-90022", "message": f"{n} {message}"} for n in range(count)]
    return json.dumps({"product-errors": entries})


@pytest.mark.parametrize(
    ("text", "verdict"),
    [
        (apple_error("Invalid Bundle " + "x" * 1_000_000), "rejected"),
        (many_errors(12, "Invalid Bundle " + "y" * 500), "rejected"),
        (apple_error("401 unauthorized " + "z" * 1_000_000), "auth_failed"),
        (altool_error("Redundant Binary Upload " + "d" * 1_000_000), "apple_reports_duplicate"),
    ],
    ids=["one-long-message", "many-long-messages", "long-auth-message", "long-duplicate"],
)
def test_a_finished_answer_is_stored_with_the_same_caps_as_an_unresolved_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, text: str, verdict: str
) -> None:
    drive_upload(tmp_path, monkeypatch, answers={"--upload-app": (1, text)})
    messages = record_module.read_record(tmp_path).uploads[0]["outcome"]["messages"]
    assert 1 <= len(messages) <= 5
    assert all(len(message) <= 200 for message in messages)
    validating = tmp_path / "validate"
    validating.mkdir()
    drive_upload(validating, monkeypatch, answers={"--validate-app": (1, text)})
    stored = record_module.read_record(validating).validations[0]["messages"]
    assert len(stored) <= 5 and all(len(message) <= 200 for message in stored)


@pytest.mark.parametrize(
    "field",
    [
        {"message": "Redundant Binary Upload"},
        {"message": "x", "extra": "Redundant Binary Upload"},
        {"message": "x", "userInfo": {"anything": "already been uploaded"}},
    ],
    ids=["message", "unknown-field", "unknown-user-info-field"],
)
def test_duplicate_wording_planted_in_any_field_is_a_duplicate_even_without_an_apple_shape(
    field: dict[str, object],
) -> None:
    text = json.dumps({"product-errors": [{"code": -1, **field}]})
    assert release_classify.classify_upload(1, text).verdict is Verdict.DUPLICATE


@pytest.mark.parametrize(
    ("entry", "shaped"),
    [
        ({"message": "ITMS-90062"}, True),
        ({"message": "ITMS-1"}, True),
        ({"message": "ITMS-"}, False),
        ({"message": "ITMS-abc"}, False),
        ({"message": "xITMS-90062"}, False),
        ({"message": "ITMS-90062x"}, False),
        ({"message": "itms-90062"}, False),
        ({"code": "ITMS-90062"}, True),
        ({"userInfo": {"NSLocalizedDescription": "ITMS-90062"}}, True),
        ({"message": "Error Domain=ITunesConnectErrorDomain Code=1"}, True),
        ({"message": "Error Domain=NSURLErrorDomain Code=-1"}, False),
        ({"code": "ENTITY_ERROR"}, True),
        ({"code": "ENTITY_ERROR.ATTRIBUTE.INVALID"}, True),
        ({"code": "STATE_ERROR.FIRST_ERROR"}, True),
        ({"code": "ENTITY_ERROR "}, False),
        ({"code": " ENTITY_ERROR"}, False),
        ({"code": "ENTITY_ERRORS"}, False),
        ({"code": "ENTITY_ERROR."}, False),
        ({"code": "CONFLICTING"}, False),
        ({"code": "entity_error"}, False),
        ({"code": ["ENTITY_ERROR"]}, False),
        ({"code": 409}, False),
        ({"message": "ENTITY_ERROR"}, False),
        ({"userInfo": {"code": "ENTITY_ERROR"}}, False),
        ({"domain": "ITunesSoftwareServiceErrorDomain"}, True),
        ({"domain": "ContentDeliveryErrorDomain"}, True),
        ({"domain": "AppStoreConnectError"}, True),
        ({"domain": "NSURLErrorDomain"}, False),
        ({"domain": "MyITunesDomain"}, False),
        ({"domain": "itunes"}, False),
        ({"userInfo": {"domain": "ContentDeliveryErrorDomain"}}, True),
        ({"userInfo": {"domain": "NSPOSIXErrorDomain"}}, False),
        ({"userInfo": {"domain": ["ITunesError"]}}, False),
        ({"anything": "see ITMS-90062"}, True),
        ({}, False),
    ],
)
def test_the_apple_shape_allow_list_rows(entry: dict[str, object], shaped: bool) -> None:
    assert release_classify.apple_shaped(entry) is shaped


def key_files(tmp_path: Path) -> tuple[Path, Path, Path]:
    repo = tmp_path / "repo"
    repo.mkdir()
    keys = []
    for name in ("named.p8", "from-env.p8"):
        key = tmp_path / "keys" / name
        key.parent.mkdir(exist_ok=True)
        key.write_text("not read")
        key.chmod(0o600)
        keys.append(key)
    return repo, keys[0], keys[1]


def test_an_explicit_key_path_comes_from_the_private_file_and_the_environment_overrides_it(
    tmp_path: Path,
) -> None:
    repo, named, from_env = key_files(tmp_path)
    secrets_file = tmp_path / "ios.env"
    secrets_file.write_text(
        f"APPLE_API_KEY={KEY_ID}\nAPPLE_API_ISSUER={ISSUER}\nAPPLE_API_KEY_PATH={named}\n"
    )
    secrets_file.chmod(0o600)
    environ = {"SHARECUT_IOS_RELEASE_ENV": str(secrets_file)}
    values, problems = release_inputs.private_values(environ, repo, tmp_path)
    key, found = release_inputs.resolve_asc_key(values, tmp_path, repo)
    assert problems == [] and found == [] and key is not None
    assert key.key_path.reveal() == str(named)

    override = {**environ, "APPLE_API_KEY_PATH": str(from_env)}
    values, _ = release_inputs.private_values(override, repo, tmp_path)
    key, found = release_inputs.resolve_asc_key(values, tmp_path, repo)
    assert found == [] and key is not None and key.key_path.reveal() == str(from_env)


def test_an_explicit_key_path_from_the_environment_needs_no_private_file(tmp_path: Path) -> None:
    repo, _, from_env = key_files(tmp_path)
    environ = {
        "SHARECUT_IOS_RELEASE_ENV": str(tmp_path / "absent.env"),
        "APPLE_API_KEY": KEY_ID,
        "APPLE_API_ISSUER": ISSUER,
        "APPLE_API_KEY_PATH": str(from_env),
    }
    values, problems = release_inputs.private_values(
        environ, repo, tmp_path, release_inputs.KEY_SECRETS
    )
    key, found = release_inputs.resolve_asc_key(values, tmp_path, repo)
    assert problems == [] and found == [] and key is not None
    assert key.key_path.reveal() == str(from_env)


def test_an_explicit_key_path_that_is_missing_is_not_replaced_by_the_default(
    tmp_path: Path,
) -> None:
    repo, named, _ = key_files(tmp_path)
    default = tmp_path / ".appstoreconnect/private_keys" / f"AuthKey_{KEY_ID}.p8"
    default.parent.mkdir(parents=True)
    default.write_text("not read")
    default.chmod(0o600)
    values = {
        "APPLE_API_KEY": KEY_ID,
        "APPLE_API_ISSUER": ISSUER,
        "APPLE_API_KEY_PATH": str(named.with_name("gone.p8")),
    }
    key, found = release_inputs.resolve_asc_key(values, tmp_path, repo)
    assert key is None and [p.why for p in found] == ["the key file does not exist"]


def test_a_retry_that_apple_then_rejects_leaves_the_first_attempt_open_and_the_flag_needed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _, _, record, _ = drive_upload(tmp_path, monkeypatch, answers={"--upload-app": UNREACHABLE})
    code, ran, record, _ = drive_upload(
        tmp_path,
        monkeypatch,
        record=record,
        retry_unknown_upload=True,
        answers={"--upload-app": REFUSED},
    )
    assert code == Failure.APPLE_REJECTED.value and uploads_sent(ran) == 1
    first, retry = record_module.read_record(tmp_path).uploads
    assert first["outcome"] is None and retry["outcome"]["verdict"] == "rejected"
    assert retry["retried_unknown_upload"] is True
    capsys.readouterr()

    code, ran, record, _ = drive_upload(tmp_path, monkeypatch, record=record)
    assert code == GUARD_EXIT and ran == []
    assert "--retry-unknown-upload" in capsys.readouterr().out
    assert record_module.read_record(tmp_path).uploads == [first, retry]


def test_main_prints_the_success_banner_only_for_an_upload_apple_answered(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    directory, _ = stage_main_upload(tmp_path, monkeypatch, interrupted=False)
    token = record_module.read_record(directory).token()
    banner = "uploaded; App Store processing usually takes 5 to 30 minutes"

    fake_apple(monkeypatch, directory, answers={"--upload-app": UNREACHABLE})
    assert ios_release.main(["upload", "--confirm", token]) == Failure.TOOL.value
    assert banner not in capsys.readouterr().out

    assert ios_release.main(["validate"]) == 0
    assert f"to upload after the owner says so: ios_release.py upload --confirm {token}" in (
        capsys.readouterr().out
    )

    fake_apple(monkeypatch, directory)
    assert ios_release.main(["upload", "--confirm", token, "--retry-unknown-upload"]) == 0
    assert banner in capsys.readouterr().out
