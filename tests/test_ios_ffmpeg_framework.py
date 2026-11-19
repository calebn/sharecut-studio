"""``scripts/ios/ffmpeg_framework.py`` builds and checks the app's FFmpeg.xcframework.

The cloud runs everything except Apple's tool: a fake runner stands in for ``xcodebuild``
and writes the folder layout that ``-create-xcframework`` writes.
"""

from __future__ import annotations

import importlib.util
import plistlib
import re
import shutil
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/ios/ffmpeg_framework.py"
MANIFEST_SOURCE = ROOT / "gui/desktop/src-tauri/ios/ffmpeg/PrivacyInfo.xcprivacy"

spec = importlib.util.spec_from_file_location("ffmpeg_framework", SCRIPT)
assert spec is not None and spec.loader is not None
tool = importlib.util.module_from_spec(spec)
sys.modules["ffmpeg_framework"] = tool
spec.loader.exec_module(tool)

LIBRARY = {"device": ("ios-arm64", None), "sim": ("ios-arm64-simulator", "simulator")}


def checkout(tmp_path: Path, slices: Sequence[str] = ("device", "sim")) -> Path:
    root = tmp_path / "checkout"
    manifest = root / "gui/desktop/src-tauri/ios/ffmpeg/PrivacyInfo.xcprivacy"
    manifest.parent.mkdir(parents=True)
    shutil.copy(MANIFEST_SOURCE, manifest)
    for name in slices:
        binary = root / f"gui/desktop/src-tauri/ios-ffmpeg/out/{name}/FFmpeg.framework/FFmpeg"
        binary.parent.mkdir(parents=True)
        binary.write_bytes(name.encode())
        (binary.parent / "Info.plist").write_bytes(plistlib.dumps({"CFBundleName": "FFmpeg"}))
    (root / "gui/desktop/src-tauri/ios-payload").mkdir(parents=True)
    return root


class FakeXcodebuild:
    """Writes what ``xcodebuild -create-xcframework`` writes, from the argv it is given."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def __call__(self, argv: Sequence[str]) -> None:
        self.calls.append(list(argv))
        assert argv[:2] == ["xcodebuild", "-create-xcframework"]
        output = Path(argv[argv.index("-output") + 1])
        libraries = []
        for index, arg in enumerate(argv):
            if arg != "-framework":
                continue
            framework = Path(argv[index + 1])
            identifier, variant = LIBRARY[framework.parent.name]
            shutil.copytree(framework, output / identifier / "FFmpeg.framework", symlinks=True)
            entry: dict[str, object] = {
                "LibraryIdentifier": identifier,
                "LibraryPath": "FFmpeg.framework",
                "SupportedArchitectures": ["arm64"],
                "SupportedPlatform": "ios",
            }
            if variant:
                entry["SupportedPlatformVariant"] = variant
            libraries.append(entry)
        (output / "Info.plist").write_bytes(
            plistlib.dumps({"AvailableLibraries": libraries, "XCFrameworkFormatVersion": "1.0"})
        )


def xcframework(root: Path) -> Path:
    return root / "gui/desktop/src-tauri/ios-payload/FFmpeg.xcframework"


def test_assemble_builds_one_xcframework_from_both_slices(tmp_path: Path) -> None:
    root = checkout(tmp_path)
    runner = FakeXcodebuild()
    assert tool.assemble(root, runner) == ["device", "sim"]
    assert len(runner.calls) == 1
    out = xcframework(root)
    assert (out / "ios-arm64/FFmpeg.framework/FFmpeg").read_bytes() == b"device"
    assert (out / "ios-arm64-simulator/FFmpeg.framework/FFmpeg").read_bytes() == b"sim"


def test_assemble_takes_only_the_slices_that_exist(tmp_path: Path) -> None:
    root = checkout(tmp_path, ("sim",))
    runner = FakeXcodebuild()
    assert tool.assemble(root, runner) == ["sim"]
    assert runner.calls[0].count("-framework") == 1
    assert not (xcframework(root) / "ios-arm64").exists()


def test_assemble_with_no_slice_says_which_make_target_to_run(tmp_path: Path) -> None:
    root = checkout(tmp_path, ())
    runner = FakeXcodebuild()
    with pytest.raises(tool.FrameworkError, match="make ios-ffmpeg"):
        tool.assemble(root, runner)
    assert runner.calls == []
    assert not xcframework(root).exists()


def test_assemble_puts_the_privacy_manifest_into_every_slice_and_leaves_the_build_output_alone(
    tmp_path: Path,
) -> None:
    root = checkout(tmp_path)
    tool.assemble(root, FakeXcodebuild())
    for identifier in ("ios-arm64", "ios-arm64-simulator"):
        shipped = xcframework(root) / identifier / "FFmpeg.framework/PrivacyInfo.xcprivacy"
        assert shipped.read_bytes() == MANIFEST_SOURCE.read_bytes()
    out = root / "gui/desktop/src-tauri/ios-ffmpeg/out"
    assert not list(out.rglob("PrivacyInfo.xcprivacy"))


def test_assemble_without_the_manifest_source_fails_before_touching_anything(
    tmp_path: Path,
) -> None:
    root = checkout(tmp_path)
    (root / "gui/desktop/src-tauri/ios/ffmpeg/PrivacyInfo.xcprivacy").unlink()
    runner = FakeXcodebuild()
    with pytest.raises(tool.FrameworkError, match=r"PrivacyInfo\.xcprivacy"):
        tool.assemble(root, runner)
    assert runner.calls == []


def test_a_failed_xcodebuild_keeps_the_previous_xcframework_and_leaves_no_staging(
    tmp_path: Path,
) -> None:
    root = checkout(tmp_path)
    tool.assemble(root, FakeXcodebuild())
    before = (xcframework(root) / "Info.plist").read_bytes()

    def failing(argv: Sequence[str]) -> None:
        raise subprocess.CalledProcessError(70, list(argv))

    with pytest.raises(subprocess.CalledProcessError):
        tool.assemble(root, failing)
    assert (xcframework(root) / "Info.plist").read_bytes() == before
    assert [p.name for p in xcframework(root).parent.iterdir()] == ["FFmpeg.xcframework"]


def test_a_second_assemble_replaces_the_first_and_leaves_no_staging(tmp_path: Path) -> None:
    root = checkout(tmp_path, ("device",))
    tool.assemble(root, FakeXcodebuild())
    assert not (xcframework(root) / "ios-arm64-simulator").exists()
    sim = root / "gui/desktop/src-tauri/ios-ffmpeg/out/sim/FFmpeg.framework/FFmpeg"
    sim.parent.mkdir(parents=True)
    sim.write_bytes(b"sim")
    tool.assemble(root, FakeXcodebuild())
    assert (xcframework(root) / "ios-arm64-simulator/FFmpeg.framework/FFmpeg").is_file()
    assert [p.name for p in xcframework(root).parent.iterdir()] == ["FFmpeg.xcframework"]


def test_the_xcodebuild_argv_names_each_framework_and_one_output(tmp_path: Path) -> None:
    root = checkout(tmp_path)
    runner = FakeXcodebuild()
    tool.assemble(root, runner)
    argv = runner.calls[0]
    assert argv[:2] == ["xcodebuild", "-create-xcframework"]
    assert argv.count("-framework") == 2
    assert argv.count("-output") == 1
    assert argv[argv.index("-output") + 1].endswith("FFmpeg.xcframework")


def test_the_check_passes_for_each_sdk_whose_slice_is_present(tmp_path: Path) -> None:
    root = checkout(tmp_path)
    tool.assemble(root, FakeXcodebuild())
    assert tool.check(root, "iphoneos") is None
    assert tool.check(root, "iphonesimulator") is None


@pytest.mark.parametrize(
    ("missing", "sdk", "target"),
    [("device", "iphoneos", "ios-ffmpeg-device"), ("sim", "iphonesimulator", "ios-ffmpeg-sim")],
)
def test_the_check_names_the_make_target_for_a_missing_slice(
    tmp_path: Path, missing: str, sdk: str, target: str
) -> None:
    root = checkout(tmp_path, tuple(n for n in ("device", "sim") if n != missing))
    tool.assemble(root, FakeXcodebuild())
    problem = tool.check(root, sdk)
    assert problem is not None
    assert f"make {target}" in problem


def test_the_check_fails_when_there_is_no_xcframework_at_all(tmp_path: Path) -> None:
    root = checkout(tmp_path, ())
    problem = tool.check(root, "iphonesimulator")
    assert problem is not None
    assert "make ios-ffmpeg-sim" in problem


def test_the_check_fails_for_a_half_made_slice(tmp_path: Path) -> None:
    root = checkout(tmp_path)
    tool.assemble(root, FakeXcodebuild())
    (xcframework(root) / "ios-arm64/FFmpeg.framework/FFmpeg").unlink()
    assert tool.check(root, "iphoneos") is not None
    assert tool.check(root, "iphonesimulator") is None


def test_the_check_fails_for_an_unreadable_index(tmp_path: Path) -> None:
    root = checkout(tmp_path)
    tool.assemble(root, FakeXcodebuild())
    (xcframework(root) / "Info.plist").write_text("not a plist", encoding="utf-8")
    problem = tool.check(root, "iphoneos")
    assert problem is not None
    assert "make ios-ffmpeg-device" in problem


def test_the_check_finds_slices_by_the_index_and_not_by_a_folder_name(tmp_path: Path) -> None:
    root = checkout(tmp_path)
    tool.assemble(root, FakeXcodebuild())
    out = xcframework(root)
    (out / "ios-arm64").rename(out / "renamed-device")
    index = plistlib.loads((out / "Info.plist").read_bytes())
    for entry in index["AvailableLibraries"]:
        if entry["LibraryIdentifier"] == "ios-arm64":
            entry["LibraryIdentifier"] = "renamed-device"
    (out / "Info.plist").write_bytes(plistlib.dumps(index))
    assert tool.check(root, "iphoneos") is None


def test_an_unknown_sdk_is_refused() -> None:
    with pytest.raises(tool.FrameworkError, match="watchos"):
        tool.check(ROOT, "watchos")


def test_the_command_line_check_exits_one_with_the_hint_on_stderr(tmp_path: Path) -> None:
    root = checkout(tmp_path, ())
    copy = root / "scripts/ios/ffmpeg_framework.py"
    copy.parent.mkdir(parents=True)
    shutil.copy(SCRIPT, copy)
    result = subprocess.run(
        [sys.executable, "-I", str(copy), "check", "--sdk", "iphonesimulator"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "make ios-ffmpeg-sim" in result.stderr
    assert result.stdout == ""


def test_the_command_line_check_is_silent_and_zero_when_the_slice_exists(tmp_path: Path) -> None:
    root = checkout(tmp_path)
    tool.assemble(root, FakeXcodebuild())
    copy = root / "scripts/ios/ffmpeg_framework.py"
    copy.parent.mkdir(parents=True)
    shutil.copy(SCRIPT, copy)
    result = subprocess.run(
        [sys.executable, "-I", str(copy), "check", "--sdk", "iphoneos"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert (result.returncode, result.stdout, result.stderr) == (0, "", "")


def test_the_script_uses_the_standard_library_only() -> None:
    # The Xcode build phase runs it with the system python3 and no environment.
    modules = {
        line.split()[1].split(".")[0]
        for line in SCRIPT.read_text(encoding="utf-8").splitlines()
        if line.startswith(("import ", "from "))
    }
    assert modules <= set(sys.stdlib_module_names) | {"__future__"}


def test_the_privacy_manifest_source_is_a_valid_manifest_without_tracking() -> None:
    manifest = plistlib.loads(MANIFEST_SOURCE.read_bytes())
    assert manifest["NSPrivacyTracking"] is False
    assert manifest["NSPrivacyCollectedDataTypes"] == []
    types = manifest["NSPrivacyAccessedAPITypes"]
    assert types
    assert all(entry["NSPrivacyAccessedAPITypeReasons"] for entry in types)


@pytest.mark.parametrize(
    ("target", "argument"), [("ios-ffmpeg-device", "device"), ("ios-ffmpeg-sim", "sim")]
)
def test_each_make_target_builds_the_framework_then_assembles_the_xcframework(
    target: str, argument: str
) -> None:
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    recipe = (
        rf"^{target}:\n\t\./scripts/ios/build_ffmpeg\.sh {argument}\n"
        r"\tuv run python scripts/ios/ffmpeg_framework\.py assemble\n"
    )
    assert re.search(recipe, makefile, re.M)
