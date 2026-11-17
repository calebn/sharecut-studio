"""scripts/ios/bundle_checks.py: plist, layout, profile and privacy checks over fixtures."""

from __future__ import annotations

import json
import plistlib
from pathlib import Path

import pytest
from scripts.ios import bundle_checks as checks

from script_loader import SCRIPTS

MACHO = b"\xcf\xfa\xed\xfe" + b"\0" * 12
EXPECT = checks.PlistExpectation("studio.sharecut.app", "ShareCut", "0.1.4", "2026.1114.153045")
GOOD_PLIST = {
    "CFBundleIdentifier": "studio.sharecut.app",
    "CFBundleName": "ShareCut",
    "CFBundleShortVersionString": "0.1.4",
    "CFBundleVersion": "2026.1114.153045",
    "MinimumOSVersion": "17.0",
    "ITSAppUsesNonExemptEncryption": False,
    "NSMicrophoneUsageDescription": "Recording arrives later.",
}
CONTRACT = checks.load_privacy_contract()


def test_a_good_plist_passes_and_the_microphone_string_is_allowed() -> None:
    assert checks.check_info_plist(GOOD_PLIST, EXPECT).ok


def test_each_wrong_plist_entry_is_named() -> None:
    bad = {
        **GOOD_PLIST,
        "CFBundleIdentifier": "studio.sharecut.dev",
        "CFBundleVersion": "0.1.4.7",
        "MinimumOSVersion": "16.0",
        "ITSAppUsesNonExemptEncryption": 0,
    }
    report = checks.check_info_plist(bad, EXPECT)
    assert [problem.split(" is ")[0] for problem in report.problems] == [
        "CFBundleIdentifier",
        "CFBundleVersion",
        "MinimumOSVersion",
        "ITSAppUsesNonExemptEncryption",
        "CFBundleVersion",
    ]
    assert not checks.check_info_plist({}, EXPECT).ok


def make_app(root: Path, files: dict[str, bytes]) -> Path:
    app = root / "ShareCut.app"
    for name, data in files.items():
        (app / name).parent.mkdir(parents=True, exist_ok=True)
        (app / name).write_bytes(data)
    return app


APP_ID = "studio.sharecut.app"


def framework_plist(module: str, **overrides: object) -> bytes:
    plist = {
        "CFBundleExecutable": module,
        "CFBundleIdentifier": f"{APP_ID}.{module}",
        "CFBundlePackageType": "FMWK",
    }
    return plistlib.dumps({**plist, **overrides})


def test_a_clean_layout_passes(tmp_path: Path) -> None:
    app = make_app(
        tmp_path,
        {
            "ShareCut": MACHO,
            "Info.plist": plistlib.dumps({"CFBundleIdentifier": APP_ID}),
            "Frameworks/numpy.framework/numpy": MACHO,
            "Frameworks/numpy.framework/Info.plist": framework_plist("numpy"),
            "app_packages/pure.py": b"x",
        },
    )
    report = checks.check_layout(app)
    assert (report.ok, report.facts) == (True, {"mach_o_files": 2})


def test_every_layout_violation_is_named(tmp_path: Path) -> None:
    app = make_app(
        tmp_path,
        {
            "ShareCut": MACHO,
            "libapp.a": b"x",
            "app_packages/ext.so": MACHO,
            "app_packages/lib.dylib": b"x",
            "app_packages/__pycache__/m.pyc": b"x",
            "Other/tool": MACHO,
        },
    )
    assert sorted(checks.check_layout(app).problems) == sorted(
        (
            "static library libapp.a",
            "bytecode cache app_packages/__pycache__/m.pyc",
            "loose .dylib app_packages/lib.dylib",
            "loose .so app_packages/ext.so",
            "Mach-O outside the executable and Frameworks: app_packages/ext.so",
            "Mach-O outside the executable and Frameworks: Other/tool",
        )
    )


def framework_app(tmp_path: Path, plists: dict[str, bytes | None]) -> Path:
    files = {"ShareCut": MACHO, "Info.plist": plistlib.dumps({"CFBundleIdentifier": APP_ID})}
    for module, data in plists.items():
        files[f"Frameworks/{module}.framework/{module}"] = MACHO
        if data is not None:
            files[f"Frameworks/{module}.framework/Info.plist"] = data
    return make_app(tmp_path, files)


def test_a_nested_framework_packaged_as_an_app_fails_the_layout(tmp_path: Path) -> None:
    app = framework_app(
        tmp_path,
        {"numpy.random._pcg64": framework_plist("numpy.random._pcg64", CFBundlePackageType="APPL")},
    )
    problems = checks.check_layout(app).problems
    assert any(
        "numpy.random._pcg64.framework" in problem and "APPL" in problem for problem in problems
    )


def test_a_framework_with_no_plist_fails_the_layout(tmp_path: Path) -> None:
    app = framework_app(tmp_path, {"numpy": None})
    assert any("numpy.framework" in problem for problem in checks.check_layout(app).problems)


def test_a_malformed_identifier_fails_the_layout(tmp_path: Path) -> None:
    bad = framework_plist("numpy", CFBundleIdentifier=f"{APP_ID}.numpy.-pcg64")
    problems = checks.check_layout(framework_app(tmp_path, {"numpy": bad})).problems
    assert any("numpy.framework" in problem and "identifier" in problem for problem in problems)


def test_duplicate_and_app_identifiers_fail_the_layout(tmp_path: Path) -> None:
    shared = f"{APP_ID}.shared"
    app = framework_app(
        tmp_path,
        {
            "one": framework_plist("one", CFBundleIdentifier=shared),
            "two": framework_plist("two", CFBundleIdentifier=shared),
            "three": framework_plist("three", CFBundleIdentifier=APP_ID),
        },
    )
    problems = checks.check_layout(app).problems
    assert any("duplicate" in problem for problem in problems)
    assert any("three.framework" in problem for problem in problems)


def test_an_unreadable_framework_plist_is_a_problem_not_an_exception(tmp_path: Path) -> None:
    app = framework_app(tmp_path, {"numpy": b"x"})
    assert any("unreadable" in problem for problem in checks.check_layout(app).problems)


def test_an_app_store_profile_has_no_devices_and_no_debugging() -> None:
    assert checks.check_store_profile({"Entitlements": {"get-task-allow": False}}).ok
    assert not checks.check_store_profile({"ProvisionedDevices": ["x"]}).ok
    assert not checks.check_store_profile({"Entitlements": {"get-task-allow": True}}).ok


def manifest(**categories: list[str]) -> dict[str, object]:
    return {
        "NSPrivacyAccessedAPITypes": [
            {
                "NSPrivacyAccessedAPIType": f"NSPrivacyAccessedAPICategory{name}",
                "NSPrivacyAccessedAPITypeReasons": reasons,
            }
            for name, reasons in categories.items()
        ]
    }


IMPORTS = {
    "ShareCut": frozenset({"_stat", "_malloc"}),
    "Frameworks/py.framework/py": frozenset({"_mach_absolute_time", "_stat"}),
}


def test_a_used_category_that_is_not_declared_fails_and_names_the_binaries() -> None:
    report = checks.check_privacy(IMPORTS, manifest(FileTimestamp=["C617.1"]), CONTRACT)
    assert report.problems == (
        "NSPrivacyAccessedAPICategorySystemBootTime is used by Frameworks/py.framework/py but not declared",
    )


def test_a_declared_category_nothing_uses_only_warns() -> None:
    report = checks.check_privacy(
        IMPORTS,
        manifest(FileTimestamp=["C617.1"], SystemBootTime=["35F9.1"], DiskSpace=["E174.1"]),
        CONTRACT,
    )
    assert report.ok
    assert report.warnings == (
        "NSPrivacyAccessedAPICategoryDiskSpace is declared but no binary imports it",
    )
    assert report.facts == {
        "NSPrivacyAccessedAPICategoryFileTimestamp": 2,
        "NSPrivacyAccessedAPICategorySystemBootTime": 1,
    }


def test_an_unknown_reason_or_a_missing_manifest_fails() -> None:
    report = checks.check_privacy(
        IMPORTS, manifest(FileTimestamp=["ZZZZ.1"], SystemBootTime=[]), CONTRACT
    )
    assert report.problems == (
        "NSPrivacyAccessedAPICategoryFileTimestamp lists reason ZZZZ.1, which is not in contracts/ios-privacy.json",
        "NSPrivacyAccessedAPICategorySystemBootTime lists no reason",
    )
    assert checks.check_privacy(IMPORTS, None, CONTRACT).problems == (
        "the built app has no PrivacyInfo.xcprivacy",
    )


def test_the_committed_manifest_declares_exactly_what_the_contract_allows() -> None:
    source = plistlib.loads(
        (SCRIPTS.parent / "gui/desktop/src-tauri/ios/PrivacyInfo.xcprivacy").read_bytes()
    )
    assert checks.check_privacy({}, source, CONTRACT).problems == ()


def test_the_contract_says_it_is_unconfirmed_and_dated() -> None:
    raw = json.loads(checks.PRIVACY_CONTRACT.read_text())
    assert raw["as_of"] == "2026-11-14"
    assert raw["confirmed_against_apple"] is False


def test_imported_symbols_reads_nm_output_per_mach_o(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = make_app(tmp_path, {"ShareCut": MACHO, "text.txt": b"x"})
    monkeypatch.setattr(checks, "capture", lambda argv: "_stat\n_malloc\n")
    assert checks.imported_symbols(app) == {"ShareCut": frozenset({"_stat", "_malloc"})}
