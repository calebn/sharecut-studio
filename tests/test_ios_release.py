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
    for name in ("APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"):
        assert f"{name} (private file or environment): missing" in out


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
REFUSED = (1, altool_error("Invalid binary"))


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
    assert attempt["last_answer"]["messages"] == ["Could not connect to the server"]
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


NO_ANSWER = {
    "killed-9": (-9, ""),
    "killed-15": (-15, ""),
    "exit-137": (137, ""),
    "ssl-handshake": (1, "SSL error: handshake failed"),
    "broken-pipe": (1, "Broken pipe"),
    "unexpected-eof": (1, "Unexpected EOF"),
    "dns": (1, "nodename nor servname provided, or not known"),
    "dns-resolve": (1, "Could not resolve host: contentdelivery.itunes.apple.com"),
    "proxy-502-html": (1, "<html><body><h1>Proxy Error 502 Bad Gateway</h1></body></html>"),
    "proxy-503-text": (1, "Service Unavailable (503)"),
    "server-500": (1, "Server error 500"),
    "network-with-403": (1, "network error contacting the server, status 403"),
    "empty-nonzero": (1, ""),
    "exit-0-no-answer": (0, ""),
    "exit-0-text": (0, "uploading... done"),
    "structured-transport": (1, altool_error("An SSL error occurred (NSURLErrorDomain -1200)")),
}
VALIDATE_VERDICT = {
    "killed-9": "rejected",
    "killed-15": "rejected",
    "exit-137": "rejected",
    "ssl-handshake": "rejected",
    "broken-pipe": "rejected",
    "unexpected-eof": "rejected",
    "dns": "rejected",
    "dns-resolve": "rejected",
    "proxy-502-html": "rejected",
    "proxy-503-text": "rejected",
    "server-500": "rejected",
    "network-with-403": "auth_failed",
    "empty-nonzero": "rejected",
    "exit-0-no-answer": "ok",
    "exit-0-text": "ok",
    "structured-transport": "rejected",
}


@pytest.mark.parametrize("case", sorted(NO_ANSWER))
def test_an_upload_with_no_answer_from_apple_stays_unresolved_until_retried(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    case: str,
) -> None:
    code, ran, record, _ = drive_upload(
        tmp_path, monkeypatch, answers={"--upload-app": NO_ANSWER[case]}
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
        tmp_path, monkeypatch, answers={"--validate-app": NO_ANSWER[case]}
    )
    row = record_module.read_record(tmp_path).validations[0]
    assert row["verdict"] == VALIDATE_VERDICT[case]
    assert record.unresolved_uploads(record.ipa_sha256) == []
    assert uploads_sent(ran) == (1 if VALIDATE_VERDICT[case] == "ok" else 0)

    tmp = tmp_path / "lookup"
    tmp.mkdir()
    code, ran, _, _ = drive_upload(tmp, monkeypatch, answers={"--list-apps": NO_ANSWER[case]})
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


@pytest.mark.parametrize(
    ("text", "verdict"),
    [
        (altool_error("Authentication failed: 401 unauthorized"), "auth_failed"),
        (altool_error("Invalid Bundle. The bundle is missing an icon"), "rejected"),
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
        (0, altool_error("Invalid Bundle"), Verdict.REJECTED),
        (1, altool_error("Redundant Binary Upload"), Verdict.DUPLICATE),
        (1, "Redundant Binary Upload", Verdict.UNREACHABLE),
        (1, altool_error("Authentication failed: 401 unauthorized"), Verdict.AUTH_FAILED),
        (1, altool_error("network error, status 403"), Verdict.UNREACHABLE),
        (1, altool_error("Invalid Bundle. The bundle is missing an icon"), Verdict.REJECTED),
        (1, "plain text failure", Verdict.UNREACHABLE),
        (1, "null", Verdict.UNREACHABLE),
    ],
)
def test_the_strict_classifier_accepts_only_apples_own_answer(
    code: int, text: str, verdict: Verdict
) -> None:
    assert release_classify.classify_altool(code, text, strict=True).verdict is verdict


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
