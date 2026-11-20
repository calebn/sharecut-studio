"""scripts/ios/bundle_checks.py: plist, layout, profile and privacy checks over fixtures."""

from __future__ import annotations

import errno
import inspect
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


def test_a_bundle_shaped_like_the_real_app_has_no_problems(tmp_path: Path) -> None:
    files = {
        "ShareCut": MACHO,
        "Info.plist": plistlib.dumps({"CFBundleIdentifier": APP_ID}),
        "LaunchScreen.storyboardc/Info.plist": b"bplist00",
        "Base.lproj/Main.storyboardc/Info.plist": b"bplist00",
        "Frameworks/Python.framework/Python": MACHO,
        "Frameworks/Python.framework/Info.plist": framework_plist(
            "Python", CFBundleIdentifier="org.python.python"
        ),
    }
    for module in ("numpy", "numpy.random.pcg-64", "scikit-learn"):
        files[f"Frameworks/{module}.framework/{module}"] = MACHO
        files[f"Frameworks/{module}.framework/Info.plist"] = framework_plist(
            module, CFBundleIdentifier=f"{APP_ID}.{module}"
        )
    problems = checks.check_layout(make_app(tmp_path, files)).problems
    assert problems == ()


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


@pytest.mark.parametrize(
    "relative",
    [
        "PlugIns/x.appex/Info.plist",
        "Frameworks/x.bundle/Info.plist",
        "Frameworks/x.xcframework/Info.plist",
        "Frameworks/bare/Info.plist",
        "app_packages/pkg/Info.plist",
        "Frameworks/x.storyboardc/Info.plist",
        "PlugIns/y.appex/Info.plist",
        "a/b/Main.storyboardc/Info.plist",
        "Resources/Main.storyboardc/Info.plist",
        "Base.lproj/Main.storyboardc/deeper/Info.plist",
    ],
)
def test_nested_info_plist_outside_allowlist_is_named(tmp_path: Path, relative: str) -> None:
    app = framework_app(tmp_path, {})
    nested = app / relative
    nested.parent.mkdir(parents=True)
    nested.write_bytes(framework_plist("q", CFBundlePackageType="APPL"))
    assert f"unexpected Info.plist {relative}" in checks.check_layout(app).problems


def test_a_symlinked_info_plist_outside_allowlist_is_named(tmp_path: Path) -> None:
    app = framework_app(tmp_path, {})
    nested = app / "app_packages/pkg/Info.plist"
    nested.parent.mkdir(parents=True)
    nested.symlink_to(app / "Info.plist")
    assert "unexpected Info.plist app_packages/pkg/Info.plist" in checks.check_layout(app).problems


def test_uppercase_framework_suffix_is_checked(tmp_path: Path) -> None:
    app = framework_app(tmp_path, {})
    folder = app / "Frameworks/x.Framework"
    folder.mkdir(parents=True)
    (folder / "x").write_bytes(MACHO)
    (folder / "Info.plist").write_bytes(framework_plist("x", CFBundlePackageType="APPL"))
    problems = checks.check_layout(app).problems
    assert any("x.Framework" in problem and "APPL" in problem for problem in problems)


def test_an_unknown_encoding_plist_is_unreadable_not_a_crash(tmp_path: Path) -> None:
    bad = b'<?xml version="1.0" encoding="UTFO8"?><plist version="1.0"><dict/></plist>'
    app = framework_app(tmp_path, {"numpy": bad})
    assert any("unreadable" in problem for problem in checks.check_layout(app).problems)


@pytest.mark.parametrize(
    "relative",
    [
        "Frameworks/numpy.framework/.Info.plist.abc123.tmp",
        "Frameworks/.Info.plist.abc123.tmp",
        ".Info.plist.abc123.tmp",
        "app_packages/pkg/.Info.plist.abc123.tmp",
    ],
)
def test_a_stale_atomic_write_temporary_is_named(tmp_path: Path, relative: str) -> None:
    app = framework_app(tmp_path, {"numpy": framework_plist("numpy", CFBundlePackageType="FMWK")})
    stale = app / relative
    stale.parent.mkdir(parents=True, exist_ok=True)
    stale.write_bytes(b"partial")
    assert f"stale temporary file {relative}" in checks.check_layout(app).problems


def test_a_symlinked_root_info_plist_is_named(tmp_path: Path) -> None:
    app = framework_app(tmp_path, {})
    (app / "Info.plist").unlink()
    (app / "elsewhere.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": APP_ID}))
    (app / "Info.plist").symlink_to(app / "elsewhere.plist")
    assert "symlinked Info.plist" in " ".join(checks.check_layout(app).problems)


@pytest.mark.parametrize(
    "relative", ["Main.storyboardc/Info.plist", "Base.lproj/Main.storyboardc/Info.plist"]
)
def test_a_symlinked_storyboard_info_plist_is_named(tmp_path: Path, relative: str) -> None:
    app = framework_app(tmp_path, {})
    nested = app / relative
    nested.parent.mkdir(parents=True)
    nested.symlink_to(app / "Info.plist")
    assert any(
        "symlinked Info.plist" in problem and relative in problem
        for problem in checks.check_layout(app).problems
    )


FFMPEG_NM = "_sc_ffmpeg_abi_version\n_sc_ffmpeg_start\n_sc_ffmpeg_wait\n_sc_ffmpeg_cancel\n"


def fake_nm(text: str, seen: list[tuple[Path, list[str]]] | None = None) -> checks.NmRunner:
    def run(binary: Path, flags: list[str]) -> str:
        if seen is not None:
            seen.append((binary, flags))
        return text

    return run


FFMPEG_PRIVACY = "Frameworks/FFmpeg.framework/PrivacyInfo.xcprivacy"


def ffmpeg_app(tmp_path: Path, body: bytes = b"") -> Path:
    return make_app(
        tmp_path,
        {
            "Frameworks/FFmpeg.framework/FFmpeg": MACHO + body,
            FFMPEG_PRIVACY: plistlib.dumps({"NSPrivacyTracking": False}),
        },
    )


def test_the_ffmpeg_framework_is_embedded() -> None:
    assert checks.FFMPEG_EMBEDDED is True


def test_flag_off_and_no_framework_is_not_embedded_and_passes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks, "FFMPEG_EMBEDDED", False)
    app = make_app(tmp_path, {"ShareCut": MACHO})
    report = checks.check_ffmpeg_framework(app, fake_nm("nothing"))
    assert report.ok and report.name == "ffmpeg framework"
    assert report.facts == {"status": "not embedded"}


def test_flag_off_with_a_framework_present_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks, "FFMPEG_EMBEDDED", False)
    report = checks.check_ffmpeg_framework(ffmpeg_app(tmp_path), fake_nm(FFMPEG_NM))
    assert not report.ok
    assert any("is in the bundle but FFMPEG_EMBEDDED is False" in p for p in report.problems)


def test_flag_off_with_an_empty_framework_folder_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks, "FFMPEG_EMBEDDED", False)
    app = make_app(tmp_path, {"ShareCut": MACHO})
    (app / checks.FFMPEG_BINARY.parent).mkdir(parents=True)
    report = checks.check_ffmpeg_framework(app, fake_nm("nothing"))
    assert any("FFMPEG_EMBEDDED is False" in p for p in report.problems)


def test_flag_off_with_a_symlinked_framework_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks, "FFMPEG_EMBEDDED", False)
    app = make_app(tmp_path, {"ShareCut": MACHO})
    (app / "Frameworks").mkdir()
    (app / checks.FFMPEG_BINARY.parent).symlink_to("nowhere")
    report = checks.check_ffmpeg_framework(app, fake_nm("nothing"))
    assert any("FFMPEG_EMBEDDED is False" in p for p in report.problems)


def test_flag_on_with_no_framework_fails(tmp_path: Path) -> None:
    app = make_app(tmp_path, {"ShareCut": MACHO})
    report = checks.check_ffmpeg_framework(app, fake_nm(FFMPEG_NM))
    assert report.problems == ("Frameworks/FFmpeg.framework/FFmpeg is missing",)


def test_flag_on_with_a_framework_that_exports_the_wrong_names_fails(tmp_path: Path) -> None:
    report = checks.check_ffmpeg_framework(ffmpeg_app(tmp_path), fake_nm("_av_log\n"))
    assert any("does not export sc_ffmpeg_abi_version" in p for p in report.problems)
    assert any("unexpected av_log" in p for p in report.problems)


def test_the_framework_must_carry_its_own_privacy_manifest(tmp_path: Path) -> None:
    app = ffmpeg_app(tmp_path)
    assert checks.check_ffmpeg_framework(app, fake_nm(FFMPEG_NM)).ok
    (app / FFMPEG_PRIVACY).unlink()
    report = checks.check_ffmpeg_framework(app, fake_nm(FFMPEG_NM))
    assert report.problems == (f"{FFMPEG_PRIVACY} is missing",)


@pytest.mark.parametrize("body", [b"not a plist", b"<plist><dict>"])
def test_a_privacy_manifest_that_is_not_a_plist_fails(tmp_path: Path, body: bytes) -> None:
    app = ffmpeg_app(tmp_path)
    (app / FFMPEG_PRIVACY).write_bytes(body)
    report = checks.check_ffmpeg_framework(app, fake_nm(FFMPEG_NM))
    assert report.problems == (f"{FFMPEG_PRIVACY} is not a property list",)


def test_exported_symbols_asks_nm_for_defined_globals_and_drops_the_underscore(
    tmp_path: Path,
) -> None:
    seen: list[tuple[Path, list[str]]] = []
    path = tmp_path / "FFmpeg"
    assert checks.exported_symbols(path, fake_nm(FFMPEG_NM + "_other\n", seen)) == (
        checks.FFMPEG_EXPORTS | {"other"}
    )
    assert seen == [(path, ["-gU", "-j"])]


def test_the_four_exports_and_a_small_binary_pass(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks, "FFMPEG_EMBEDDED", True)
    app = ffmpeg_app(tmp_path)
    report = checks.check_ffmpeg_framework(app, fake_nm(FFMPEG_NM))
    assert report.problems == ()
    assert report.facts["exports"] == sorted(checks.FFMPEG_EXPORTS)


@pytest.mark.parametrize(
    ("text", "problem"),
    [
        (FFMPEG_NM.replace("_sc_ffmpeg_wait\n", ""), "does not export sc_ffmpeg_wait"),
        (FFMPEG_NM + "_sc_ffmpeg_extra\n", "unexpected sc_ffmpeg_extra"),
        ("", "does not export sc_ffmpeg_abi_version"),
        (FFMPEG_NM + "_av_log\n", "unexpected av_log"),
        (FFMPEG_NM + "_main\n", "unexpected main"),
    ],
)
def test_the_exports_must_be_exactly_the_four(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, text: str, problem: str
) -> None:
    monkeypatch.setattr(checks, "FFMPEG_EMBEDDED", True)
    report = checks.check_ffmpeg_framework(ffmpeg_app(tmp_path), fake_nm(text))
    assert any(problem in line for line in report.problems)


def test_a_missing_ffmpeg_binary_is_a_problem(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks, "FFMPEG_EMBEDDED", True)
    app = make_app(tmp_path, {"ShareCut": MACHO})
    report = checks.check_ffmpeg_framework(app, fake_nm(FFMPEG_NM))
    assert report.problems == ("Frameworks/FFmpeg.framework/FFmpeg is missing",)


def test_a_symlinked_ffmpeg_binary_is_a_problem(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks, "FFMPEG_EMBEDDED", True)
    app = make_app(tmp_path, {"Frameworks/FFmpeg.framework/real": MACHO})
    (app / checks.FFMPEG_BINARY).symlink_to("real")
    report = checks.check_ffmpeg_framework(app, fake_nm(FFMPEG_NM))
    assert report.problems == ("Frameworks/FFmpeg.framework/FFmpeg is missing",)


def test_an_unreadable_ffmpeg_binary_is_a_problem(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def unreadable(path: Path) -> bool:
        raise PermissionError(errno.EACCES, "denied")

    monkeypatch.setattr(checks, "FFMPEG_EMBEDDED", True)
    monkeypatch.setattr(checks, "is_macho", unreadable)
    report = checks.check_ffmpeg_framework(ffmpeg_app(tmp_path), fake_nm(FFMPEG_NM))
    assert len(report.problems) == 1 and "is unreadable" in report.problems[0]


def test_every_nm_consumer_defaults_to_xcrun() -> None:
    for function in (
        checks.imported_symbols,
        checks.exported_symbols,
        checks.check_ffmpeg_framework,
    ):
        assert inspect.signature(function).parameters["runner"].default is checks.xcrun_nm


def test_the_default_runner_asks_xcrun_nm(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def capture(command: list[str]) -> str:
        calls.append(command)
        return "_x\n"

    monkeypatch.setattr(checks, "capture", capture)
    assert checks.exported_symbols(Path("bin")) == {"x"}
    assert calls == [["xcrun", "nm", "-gU", "-j", "bin"]]


def test_a_binary_over_the_size_budget_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks, "FFMPEG_EMBEDDED", True)
    monkeypatch.setattr(checks, "FFMPEG_SIZE_BUDGET", 64)
    small = checks.check_ffmpeg_framework(
        ffmpeg_app(tmp_path / "a", b"\0" * 48), fake_nm(FFMPEG_NM)
    )
    big = checks.check_ffmpeg_framework(ffmpeg_app(tmp_path / "b", b"\0" * 49), fake_nm(FFMPEG_NM))
    assert small.ok
    assert any("over the 64 byte budget" in line for line in big.problems)


def test_the_size_budget_is_25_mib() -> None:
    assert checks.FFMPEG_SIZE_BUDGET == 25 * 1024 * 1024


def test_a_framework_binary_that_is_not_macho_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks, "FFMPEG_EMBEDDED", True)
    app = make_app(tmp_path, {"Frameworks/FFmpeg.framework/FFmpeg": b"text"})
    report = checks.check_ffmpeg_framework(app, fake_nm(FFMPEG_NM))
    assert any("not a Mach-O" in line for line in report.problems)


def test_imported_symbols_takes_a_runner(tmp_path: Path) -> None:
    app = make_app(tmp_path, {"ShareCut": MACHO})
    seen: list[tuple[Path, list[str]]] = []
    assert checks.imported_symbols(app, fake_nm("_stat\n", seen)) == {
        "ShareCut": frozenset({"_stat"})
    }
    assert seen[0][1] == ["-u", "-j"]


@pytest.mark.parametrize(
    "body",
    [
        b'<?xml version="1.0" encoding="x-bogus"?><plist version="1.0"><dict/></plist>',
        b"bplist00\x00",
    ],
)
def test_a_privacy_manifest_with_a_hostile_encoding_is_one_problem_not_a_traceback(
    tmp_path: Path, body: bytes
) -> None:
    app = ffmpeg_app(tmp_path)
    (app / FFMPEG_PRIVACY).write_bytes(body)
    report = checks.check_ffmpeg_framework(app, fake_nm(FFMPEG_NM))
    assert report.problems == (f"{FFMPEG_PRIVACY} is not a property list",)


WHISPER_NM = "_sc_whisper_abi_version\n_sc_whisper_start\n_sc_whisper_wait\n_sc_whisper_cancel\n"
WHISPER_PRIVACY = "Frameworks/Whisper.framework/PrivacyInfo.xcprivacy"
WHISPER_SOURCE_MANIFEST = SCRIPTS.parent / "gui/desktop/src-tauri/ios/whisper/PrivacyInfo.xcprivacy"


def whisper_app(tmp_path: Path, body: bytes = b"") -> Path:
    return make_app(
        tmp_path,
        {
            "Frameworks/Whisper.framework/Whisper": MACHO + body,
            WHISPER_PRIVACY: plistlib.dumps({"NSPrivacyTracking": False}),
        },
    )


def test_the_whisper_framework_is_embedded_and_checked_apart_from_ffmpeg() -> None:
    assert checks.WHISPER_EMBEDDED is True
    assert {
        "sc_whisper_abi_version",
        "sc_whisper_start",
        "sc_whisper_wait",
        "sc_whisper_cancel",
    } == checks.WHISPER_EXPORTS
    assert checks.WHISPER_EXPORTS.isdisjoint(checks.FFMPEG_EXPORTS)
    assert Path("Frameworks/Whisper.framework/Whisper") == checks.WHISPER_BINARY


def test_a_whisper_framework_with_the_four_exports_and_a_manifest_passes(tmp_path: Path) -> None:
    report = checks.check_whisper_framework(whisper_app(tmp_path), fake_nm(WHISPER_NM))
    assert report.ok and report.name == "whisper framework"
    assert report.facts["exports"] == sorted(checks.WHISPER_EXPORTS)


@pytest.mark.parametrize(
    ("text", "message"),
    [
        (WHISPER_NM.replace("_sc_whisper_wait\n", ""), "Whisper does not export sc_whisper_wait"),
        (WHISPER_NM + "_sc_whisper_extra\n", "Whisper exports unexpected sc_whisper_extra"),
        (WHISPER_NM + "_whisper_init\n", "Whisper exports unexpected whisper_init"),
        (WHISPER_NM + "_ggml_init\n", "Whisper exports unexpected ggml_init"),
        (WHISPER_NM + "_sc_ffmpeg_start\n", "Whisper exports unexpected sc_ffmpeg_start"),
        ("", "Whisper does not export sc_whisper_abi_version"),
    ],
)
def test_the_whisper_export_set_must_be_exactly_the_four_symbols(
    tmp_path: Path, text: str, message: str
) -> None:
    report = checks.check_whisper_framework(whisper_app(tmp_path), fake_nm(text))
    assert any(message in problem for problem in report.problems)


def test_the_whisper_framework_must_not_export_the_ffmpeg_symbols_it_replaces(
    tmp_path: Path,
) -> None:
    report = checks.check_whisper_framework(whisper_app(tmp_path), fake_nm(FFMPEG_NM))
    assert len(report.problems) == 8


def test_each_framework_check_ignores_the_other_frameworks_files(tmp_path: Path) -> None:
    app = make_app(
        tmp_path,
        {
            "Frameworks/FFmpeg.framework/FFmpeg": MACHO,
            FFMPEG_PRIVACY: plistlib.dumps({"NSPrivacyTracking": False}),
            "Frameworks/Whisper.framework/Whisper": MACHO,
            WHISPER_PRIVACY: plistlib.dumps({"NSPrivacyTracking": False}),
        },
    )
    assert checks.check_ffmpeg_framework(app, fake_nm(FFMPEG_NM)).ok
    assert checks.check_whisper_framework(app, fake_nm(WHISPER_NM)).ok
    assert not checks.check_ffmpeg_framework(app, fake_nm(WHISPER_NM)).ok


def test_a_missing_whisper_manifest_is_named(tmp_path: Path) -> None:
    app = whisper_app(tmp_path)
    (app / WHISPER_PRIVACY).unlink()
    report = checks.check_whisper_framework(app, fake_nm(WHISPER_NM))
    assert report.problems == (f"{WHISPER_PRIVACY} is missing",)


@pytest.mark.parametrize("body", [b"not a plist", plistlib.dumps(["a list"]), b"bplist00\x00"])
def test_a_whisper_manifest_that_is_not_a_property_list_dict_is_one_problem(
    tmp_path: Path, body: bytes
) -> None:
    app = whisper_app(tmp_path)
    (app / WHISPER_PRIVACY).write_bytes(body)
    report = checks.check_whisper_framework(app, fake_nm(WHISPER_NM))
    assert report.problems == (f"{WHISPER_PRIVACY} is not a property list",)


def test_a_missing_or_symlinked_whisper_binary_is_a_problem(tmp_path: Path) -> None:
    empty = make_app(tmp_path / "a", {"ShareCut": MACHO})
    assert checks.check_whisper_framework(empty, fake_nm(WHISPER_NM)).problems == (
        "Frameworks/Whisper.framework/Whisper is missing",
    )
    linked = make_app(tmp_path / "b", {"ShareCut": MACHO})
    (linked / "Frameworks/Whisper.framework").mkdir(parents=True)
    (linked / checks.WHISPER_BINARY).symlink_to("real")
    assert checks.check_whisper_framework(linked, fake_nm(WHISPER_NM)).problems == (
        "Frameworks/Whisper.framework/Whisper is missing",
    )


def test_a_second_macho_inside_the_whisper_framework_fails(tmp_path: Path) -> None:
    app = whisper_app(tmp_path)
    extra = app / "Frameworks/Whisper.framework/Libs/libextra.dylib"
    extra.parent.mkdir()
    extra.write_bytes(MACHO + b"x")
    report = checks.check_whisper_framework(app, fake_nm(WHISPER_NM))
    assert report.problems == (
        "Frameworks/Whisper.framework/Libs/libextra.dylib is a second Mach-O file in Whisper.framework",
    )


def test_a_whisper_binary_that_is_not_macho_fails(tmp_path: Path) -> None:
    app = make_app(tmp_path, {"Frameworks/Whisper.framework/Whisper": b"text"})
    report = checks.check_whisper_framework(app, fake_nm(WHISPER_NM))
    assert any("Whisper is not a Mach-O file" in line for line in report.problems)


def test_an_unreadable_whisper_binary_is_a_problem(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def unreadable(path: Path) -> bool:
        raise PermissionError(errno.EACCES, "denied")

    monkeypatch.setattr(checks, "is_macho", unreadable)
    report = checks.check_whisper_framework(whisper_app(tmp_path), fake_nm(WHISPER_NM))
    assert len(report.problems) == 1 and "is unreadable" in report.problems[0]


def test_the_whisper_size_budget_is_its_own_12_mib(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert checks.WHISPER_SIZE_BUDGET == 12 * 1024 * 1024
    monkeypatch.setattr(checks, "WHISPER_SIZE_BUDGET", 64)
    small = checks.check_whisper_framework(
        whisper_app(tmp_path / "a", b"\0" * 48), fake_nm(WHISPER_NM)
    )
    big = checks.check_whisper_framework(
        whisper_app(tmp_path / "b", b"\0" * 49), fake_nm(WHISPER_NM)
    )
    assert small.ok
    assert any("Whisper is 65 bytes, over the 64 byte budget" in line for line in big.problems)


def test_whisper_not_embedded_passes_when_absent_and_fails_when_present(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(checks, "WHISPER_EMBEDDED", False)
    report = checks.check_whisper_framework(make_app(tmp_path / "a", {"x": b""}), fake_nm(""))
    assert report.ok and report.facts == {"status": "not embedded"}
    present = checks.check_whisper_framework(whisper_app(tmp_path / "b"), fake_nm(WHISPER_NM))
    assert any("is in the bundle but WHISPER_EMBEDDED is False" in p for p in present.problems)


def test_the_whisper_check_defaults_to_xcrun() -> None:
    parameter = inspect.signature(checks.check_whisper_framework).parameters["runner"]
    assert parameter.default is checks.xcrun_nm
    assert inspect.signature(checks.check_native_framework).parameters["runner"].default is (
        checks.xcrun_nm
    )


def test_the_whisper_manifest_source_is_a_tracking_free_dict_with_listed_reasons() -> None:
    manifest = plistlib.loads(WHISPER_SOURCE_MANIFEST.read_bytes())
    assert manifest["NSPrivacyTracking"] is False
    assert manifest["NSPrivacyCollectedDataTypes"] == []
    declared = checks.declared_categories(manifest)
    assert declared
    for category, reasons in declared.items():
        assert reasons
        assert set(reasons) <= set(CONTRACT[category]["reasons"])


def test_the_contract_and_the_whisper_manifest_say_the_reason_codes_are_unconfirmed() -> None:
    raw = json.loads(checks.PRIVACY_CONTRACT.read_text())
    entry = raw["frameworks"]["whisper"]
    assert entry["confirmed_against_apple"] is False
    assert "unconfirmed" in entry["note"]
    assert (SCRIPTS.parent / entry["manifest"]) == WHISPER_SOURCE_MANIFEST
    assert "unconfirmed" in WHISPER_SOURCE_MANIFEST.read_text(encoding="utf-8")


def test_the_whisper_framework_is_privacy_checked_through_its_imports(tmp_path: Path) -> None:
    app = make_app(
        tmp_path,
        {"ShareCut": MACHO, "Frameworks/Whisper.framework/Whisper": MACHO},
    )
    imports = checks.imported_symbols(app, fake_nm("_stat\n"))
    assert "Frameworks/Whisper.framework/Whisper" in imports
    used = checks.used_categories(imports, CONTRACT)
    assert (
        "Frameworks/Whisper.framework/Whisper" in used["NSPrivacyAccessedAPICategoryFileTimestamp"]
    )
