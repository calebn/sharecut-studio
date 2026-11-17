from __future__ import annotations

import dataclasses
import plistlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from scripts.ios import ios_release, provisioning, release_inputs, release_plan
from scripts.ios.provisioning import ProfileFacts
from scripts.ios.release_inputs import BuildNumber, Checkout, Identity, Signing
from scripts.ios.release_run import ToolFailed
from scripts.ios.release_secrets import Redactor, Secret

TEAM = "BBBBBBBBBB"
BUNDLE = "studio.sharecut.app"
NAME = "ShareCut App Store"
NOW = datetime(2026, 11, 14, 15, 30, 45, tzinfo=UTC)
LAYOUT = release_plan.Layout(Path("/work/repo"))
NOISY: dict[str, str] = {}


def facts(**changes: object) -> ProfileFacts:
    fields: dict[str, object] = {
        "name": NAME,
        "team": TEAM,
        "app_id": f"{TEAM}.{BUNDLE}",
        "expires": NOW + timedelta(days=200),
        "provisions_all": False,
        "devices": 0,
        "get_task_allow": False,
    }
    fields.update(changes)
    return ProfileFacts(**fields)  # type: ignore[arg-type]


def resolve(
    values: dict[str, str] | None = None,
    profiles: tuple[ProfileFacts, ...] = (),
    unreadable: int = 0,
):
    return release_inputs.resolve_provisioning(
        values or {}, profiles, TEAM, BUNDLE, NOW, unreadable
    )


def why(problems: list[release_inputs.InputProblem]) -> str:
    return " | ".join(f"{p.name}: {p.why}" for p in problems)


def test_one_discovered_valid_profile_is_used_with_the_default_certificate() -> None:
    chosen, problems = resolve(profiles=(facts(),))
    assert problems == [] and chosen is not None
    assert chosen.profile.reveal() == NAME and repr(chosen.profile) == "<provisioning-profile>"
    assert chosen.certificate == "Apple Distribution"


def test_the_certificate_comes_from_the_value_when_set() -> None:
    chosen, _ = resolve(
        {"APPLE_SIGNING_CERTIFICATE": "Apple Distribution: Jo (BBBBBBBBBB)"}, (facts(),)
    )
    assert chosen is not None and chosen.certificate == "Apple Distribution: Jo (BBBBBBBBBB)"


@pytest.mark.parametrize("certificate", ["bad\nname", "x<y>"])
def test_a_certificate_with_control_or_markup_characters_is_refused(certificate: str) -> None:
    chosen, problems = resolve({"APPLE_SIGNING_CERTIFICATE": certificate}, (facts(),))
    assert chosen is None and problems[0].name == "APPLE_SIGNING_CERTIFICATE"


def test_several_distinct_valid_profiles_refuse_without_naming_them() -> None:
    chosen, problems = resolve(profiles=(facts(), facts(name="Other App Store")))
    assert chosen is None
    text = why(problems)
    assert "2" in text and "APPLE_PROVISIONING_PROFILE" in text
    assert NAME not in text and "Other App Store" not in text


def test_no_profile_at_all_keeps_the_automatic_path() -> None:
    assert resolve() == (None, [])


def test_profiles_for_other_apps_are_not_candidates() -> None:
    other = facts(app_id=f"{TEAM}.studio.other.app", name="Other")
    assert resolve(profiles=(other,)) == (None, [])


@pytest.mark.parametrize(
    ("changes", "reason"),
    [
        ({"expires": NOW - timedelta(seconds=1)}, "expired"),
        ({"get_task_allow": True}, "development"),
        ({"provisions_all": True}, "enterprise"),
        ({"devices": 3}, "ad hoc"),
        ({"team": "CCCCCCCCCC", "app_id": f"CCCCCCCCCC.{BUNDLE}"}, "team"),
        ({"app_id": f"{TEAM}.*"}, "wildcard"),
        ({"name": "Bad</string>Name"}, "name"),
    ],
)
def test_a_rejected_only_candidate_refuses_with_the_count_and_the_reason(
    changes: dict[str, object], reason: str
) -> None:
    chosen, problems = resolve(profiles=(facts(**changes),))
    assert chosen is None and len(problems) == 1
    text = why(problems)
    assert "1" in text and reason in text and BUNDLE in text
    assert NAME not in text


def test_a_valid_profile_wins_over_rejected_ones() -> None:
    expired = facts(name="Old", expires=NOW - timedelta(days=1))
    chosen, problems = resolve(profiles=(expired, facts(), facts(name="Dev", get_task_allow=True)))
    assert problems == [] and chosen is not None and chosen.profile.reveal() == NAME


def test_an_explicit_name_selects_that_profile_among_several() -> None:
    chosen, problems = resolve(
        {"APPLE_PROVISIONING_PROFILE": "Other App Store"},
        (facts(), facts(name="Other App Store")),
    )
    assert problems == [] and chosen is not None and chosen.profile.reveal() == "Other App Store"


def test_an_explicit_name_that_is_not_installed_never_falls_back() -> None:
    chosen, problems = resolve({"APPLE_PROVISIONING_PROFILE": "Missing"}, (facts(),))
    assert chosen is None and problems[0].name == "APPLE_PROVISIONING_PROFILE"
    assert "Missing" not in why(problems)


def test_an_explicit_name_with_no_installed_profiles_refuses() -> None:
    chosen, problems = resolve({"APPLE_PROVISIONING_PROFILE": NAME}, ())
    assert chosen is None and problems[0].name == "APPLE_PROVISIONING_PROFILE"


def test_an_explicit_name_that_matches_a_rejected_profile_refuses_with_the_reason() -> None:
    chosen, problems = resolve(
        {"APPLE_PROVISIONING_PROFILE": NAME}, (facts(expires=NOW - timedelta(days=1)),)
    )
    assert chosen is None and "expired" in why(problems)


@pytest.mark.parametrize("name", ["A</string><key>x</key>", "new\nline"])
def test_an_explicit_name_outside_the_safe_characters_is_refused_before_matching(
    name: str,
) -> None:
    chosen, problems = resolve({"APPLE_PROVISIONING_PROFILE": name}, (facts(name=name),))
    assert chosen is None and problems[0].name == "APPLE_PROVISIONING_PROFILE"
    assert name not in why(problems)


def test_two_usable_profiles_sharing_a_name_refuse_instead_of_picking_one() -> None:
    chosen, problems = resolve(profiles=(facts(), facts(expires=NOW + timedelta(days=300))))
    assert chosen is None and "2 valid" in why(problems)


def test_an_explicit_name_carried_by_two_installed_profiles_refuses_even_if_one_is_valid() -> None:
    expired = facts(expires=NOW - timedelta(days=1))
    chosen, problems = resolve({"APPLE_PROVISIONING_PROFILE": NAME}, (expired, facts()))
    assert chosen is None and problems[0].name == "APPLE_PROVISIONING_PROFILE"
    assert "2 installed profiles" in why(problems) and NAME not in why(problems)


def test_unreadable_files_alone_refuse_with_the_count_and_no_names() -> None:
    chosen, problems = resolve(unreadable=3)
    assert chosen is None and "3" in why(problems) and "could not be read" in why(problems)


def test_some_unreadable_files_among_readable_ones_are_tolerated() -> None:
    chosen, problems = resolve(profiles=(facts(),), unreadable=2)
    assert problems == [] and chosen is not None


def test_a_rejected_only_refusal_says_why_there_is_no_automatic_fallback() -> None:
    _, problems = resolve(profiles=(facts(get_task_allow=True),))
    text = why(problems)
    assert "automatic" in text and "install a valid App Store profile" in text


@pytest.mark.parametrize(
    "changes", [{"ExpirationDate": "2027-06-01"}, {"Name": 5}, {"TeamIdentifier": "BBBBBBBBBB"}]
)
def test_read_profile_rejects_wrongly_typed_fields_as_unreadable(
    changes: dict[str, object],
) -> None:
    text = profile_plist(**changes).decode()
    with pytest.raises(ValueError):
        provisioning.read_profile(Path("p"), run=lambda argv, **_: text)


def profile_plist(**changes: object) -> bytes:
    document: dict[str, object] = {
        "Name": NAME,
        "TeamIdentifier": [TEAM],
        "ExpirationDate": datetime(2027, 6, 1, 12, 0, 0),
        "Entitlements": {"application-identifier": f"{TEAM}.{BUNDLE}", "get-task-allow": False},
    }
    document.update(changes)
    return plistlib.dumps(document)


def test_read_profile_decodes_the_cms_plist_through_the_injected_runner() -> None:
    calls: list[list[str]] = []

    def run(argv: list[str], **_: object) -> str:
        calls.append(argv)
        return profile_plist().decode()

    read = provisioning.read_profile(Path("p.mobileprovision"), run=run)
    assert calls[0][:4] == ["security", "cms", "-D", "-i"] and calls[0][4].endswith(
        "p.mobileprovision"
    )
    assert read == facts(expires=datetime(2027, 6, 1, 12, 0, 0, tzinfo=UTC))


def test_read_profile_reads_the_device_list_and_enterprise_flag() -> None:
    text = profile_plist(ProvisionedDevices=["a", "b"], ProvisionsAllDevices=True).decode()
    read = provisioning.read_profile(Path("p"), run=lambda argv, **_: text)
    assert read.devices == 2 and read.provisions_all


def test_discover_scans_only_the_given_directories_and_skips_unreadable_files(
    tmp_path: Path,
) -> None:
    first, second, elsewhere = tmp_path / "a", tmp_path / "b", tmp_path / "c"
    for directory, names in ((first, ["1", "2"]), (second, ["3"]), (elsewhere, ["4"])):
        directory.mkdir()
        for name in names:
            (directory / f"{name}.mobileprovision").write_text(name)
        (directory / "notes.txt").write_text("ignored")
    seen: list[str] = []

    def reader(path: Path) -> ProfileFacts:
        seen.append(path.name)
        if path.stem == "2":
            raise ToolFailed("security exited 1")
        return facts(name=f"Profile {path.stem}")

    found, unreadable = provisioning.discover([first, second, tmp_path / "absent"], reader)
    assert unreadable == 1
    assert sorted(seen) == ["1.mobileprovision", "2.mobileprovision", "3.mobileprovision"]
    assert sorted(p.name for p in found) == ["Profile 1", "Profile 3"]


def test_a_profile_found_in_both_directories_is_discovered_once(tmp_path: Path) -> None:
    first, second = tmp_path / "a", tmp_path / "b"
    for directory in (first, second):
        directory.mkdir()
        (directory / "same.mobileprovision").write_text("x")
    assert provisioning.discover([first, second], lambda path: facts()) == ([facts()], 0)


def test_every_file_unreadable_is_counted(tmp_path: Path) -> None:
    (tmp_path / "a.mobileprovision").write_text("x")
    (tmp_path / "b.mobileprovision").write_text("x")

    def reader(path: Path) -> ProfileFacts:
        raise ToolFailed("security exited 127")

    assert provisioning.discover([tmp_path], reader) == ([], 2)


def test_the_scanned_directories_are_the_two_installed_profile_locations_never_downloads() -> None:
    assert provisioning.PROFILE_DIRECTORIES == (
        "Library/MobileDevice/Provisioning Profiles",
        "Library/Developer/Xcode/UserData/Provisioning Profiles",
    )


def provisioned_inputs(name: str = NAME, certificate: str = "Apple Distribution"):
    return release_inputs.BuildInputs(
        Identity(BUNDLE, "ShareCut"),
        "0.1.4",
        BuildNumber.parse("2026.1114.153045"),
        Signing.APP_STORE,
        Secret(TEAM, "team"),
        Checkout("a" * 40, False),
        release_inputs.AscKey(
            Secret("CCCCCCCCCC", "key-id"),
            Secret("11111111-2222-3333-4444-555555555555", "issuer"),
            Secret("/k.p8", "key-path"),
        ),
        release_inputs.Provisioning(Secret(name, "provisioning-profile"), certificate),
    )


def provisioned_steps(**kwargs: str):
    steps = release_plan.plan_build(provisioned_inputs(**kwargs), LAYOUT, NOISY, "/p")
    return {step.name: step for step in steps}


def options_of(step) -> dict[str, object]:
    values = {"team": TEAM, "provisioning-profile": NAME}
    text = "".join(
        values[part.label] if isinstance(part, Secret) else part
        for part in step.command.files[0].parts
    )
    return plistlib.loads(text.encode())


def test_a_resolved_profile_makes_the_export_options_manual() -> None:
    assert options_of(provisioned_steps()["export"]) == {
        "method": "app-store-connect",
        "signingStyle": "manual",
        "signingCertificate": "Apple Distribution",
        "provisioningProfiles": {BUNDLE: NAME},
        "teamID": TEAM,
        "uploadSymbols": False,
        "destination": "export",
        "manageAppVersionAndBuildNumber": False,
    }


def test_the_manual_export_argv_has_no_provisioning_update_or_key_flags() -> None:
    export = provisioned_steps()["export"]
    assert export.command.argv == (
        "xcodebuild",
        "-exportArchive",
        "-archivePath",
        str(LAYOUT.archive),
        "-exportPath",
        str(LAYOUT.tauri / "gen" / "apple" / "build" / "export"),
        "-exportOptionsPlist",
        str(LAYOUT.tauri / "gen" / "apple" / "build" / "ExportOptions.release.plist"),
    )
    assert not any(
        isinstance(part, Secret) or part.startswith(("-allow", "-authentication"))
        for part in export.command.argv
    )
    assert not {"APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"} & set(export.command.env)


def test_the_archive_step_keeps_the_key_environment() -> None:
    env = provisioned_steps()["archive"].command.env
    assert [repr(env[n]) for n in ("APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH")] == [
        "<key-id>",
        "<issuer>",
        "<key-path>",
    ]


def test_the_profile_name_is_a_secret_and_appears_in_no_argv_or_display() -> None:
    secret_name = "Secret Profile Name"
    steps = provisioned_steps(name=secret_name)
    for step in steps.values():
        if isinstance(step, release_plan.Run):
            assert secret_name not in step.command.display(Redactor())
            assert all(part != secret_name for part in step.command.argv)
    parts = steps["export"].command.files[0].parts
    assert not any(isinstance(part, str) and secret_name in part for part in parts)
    assert any(isinstance(p, Secret) and repr(p) == "<provisioning-profile>" for p in parts)


def test_a_certificate_with_punctuation_round_trips_through_the_plist() -> None:
    certificate = "Apple Distribution: O'Neil, Jo (BBBBBBBBBB)"
    options = options_of(provisioned_steps(certificate=certificate)["export"])
    assert options["signingCertificate"] == certificate


def automatic_parts_at_base(team: Secret) -> tuple[object, ...]:
    marker = "@@TEAM@@"
    document = plistlib.dumps(
        {
            "method": "app-store-connect",
            "signingStyle": "automatic",
            "teamID": marker,
            "uploadSymbols": False,
            "destination": "export",
            "manageAppVersionAndBuildNumber": False,
        }
    ).decode()
    head, _, tail = document.partition(marker)
    return (head, team, tail)


def test_without_a_profile_the_automatic_export_is_unchanged() -> None:
    base = dataclasses.replace(provisioned_inputs(), provisioning=None)
    export = {s.name: s for s in release_plan.plan_build(base, LAYOUT, NOISY, "/p")}["export"]
    parts = export.command.files[0].parts
    assert parts == automatic_parts_at_base(parts[1])
    assert repr(parts[1]) == "<team>"
    argv = export.command.argv
    assert argv[:3] == ("xcodebuild", "-exportArchive", "-allowProvisioningUpdates")
    flags = ("-authenticationKeyPath", "-authenticationKeyID", "-authenticationKeyIssuerID")
    assert [repr(argv[argv.index(flag) + 1]) for flag in flags] == [
        "<key-path>",
        "<key-id>",
        "<issuer>",
    ]


def test_only_a_signed_build_looks_for_installed_profiles(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    looked: list[list[Path]] = []

    def discover(directories: list[Path]) -> list[ProfileFacts]:
        looked.append(directories)
        return [facts()], 0

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(provisioning, "discover", discover)
    assert ios_release.installed_profiles(Signing.NONE) == ([], 0) and not looked
    assert ios_release.installed_profiles(Signing.APP_STORE) == ([facts()], 0)
    assert looked == [[tmp_path / name for name in provisioning.PROFILE_DIRECTORIES]]
