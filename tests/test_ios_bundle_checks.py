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


def test_a_clean_layout_passes(tmp_path: Path) -> None:
    app = make_app(
        tmp_path,
        {
            "ShareCut": MACHO,
            "Info.plist": b"x",
            "Frameworks/numpy.framework/numpy": MACHO,
            "Frameworks/numpy.framework/Info.plist": b"x",
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
