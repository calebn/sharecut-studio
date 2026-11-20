"""Assemble and check the app's ``FFmpeg.xcframework``.

``build_ffmpeg.sh`` writes one ``FFmpeg.framework`` per SDK under ``ios-ffmpeg/out/<device|sim>``;
the Xcode project links the one xcframework in ``ios-payload``.

    ffmpeg_framework.py assemble
    ffmpeg_framework.py check --sdk iphoneos|iphonesimulator

``check`` runs from an Xcode build phase with the system python3, so this file is standard library
only. Slice names come from the xcframework's own ``Info.plist``.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import os
import plistlib
import shutil
import struct
import subprocess
import sys
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path
from xml.parsers.expat import ExpatError

ROOT = Path(__file__).resolve().parents[2]
TAURI = Path("gui/desktop/src-tauri")
OUT = TAURI / "ios-ffmpeg/out"
PAYLOAD = TAURI / "ios-payload"
MANIFEST = TAURI / "ios/ffmpeg/PrivacyInfo.xcprivacy"
XCFRAMEWORK = "FFmpeg.xcframework"
LOCK = f".{XCFRAMEWORK}.lock"
FRAMEWORK = "FFmpeg.framework"
BINARY = "FFmpeg"
PRIVACY = "PrivacyInfo.xcprivacy"
# build_ffmpeg.sh argument, the make target that builds it, and how the index names its slice
SLICES = {
    "device": ("ios-ffmpeg-device", None),
    "sim": ("ios-ffmpeg-sim", "simulator"),
}
SDKS = {"iphoneos": "device", "iphonesimulator": "sim"}

# What plistlib raises for a hostile or truncated index (this file imports nothing from the repo).
PLIST_ERRORS = (
    ExpatError,
    RecursionError,
    OverflowError,
    LookupError,
    IndexError,
    struct.error,
)

Runner = Callable[[Sequence[str]], None]


class FrameworkError(Exception):
    pass


def run_xcodebuild(argv: Sequence[str]) -> None:
    subprocess.run(list(argv), check=True)


def built_slices(root: Path) -> dict[str, Path]:
    found = {}
    for name in SLICES:
        framework = root / OUT / name / FRAMEWORK
        if (framework / BINARY).is_file():
            found[name] = framework
    return found


def create_argv(frameworks: Sequence[Path], output: Path) -> list[str]:
    argv = ["xcodebuild", "-create-xcframework"]
    for framework in frameworks:
        argv += ["-framework", str(framework)]
    return [*argv, "-output", str(output)]


@contextlib.contextmanager
def assembling(payload: Path) -> Iterator[None]:
    """Hold the payload's assemble lock, so ``make -j ios-ffmpeg`` cannot run two assembles at once.

    A second assemble waits, then sees the slices the first one's make target finished.
    """
    payload.mkdir(parents=True, exist_ok=True)
    with (payload / LOCK).open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def assemble(root: Path, runner: Runner = run_xcodebuild) -> list[str]:
    """Build ``ios-payload/FFmpeg.xcframework`` from the slices that exist; return their names."""
    with assembling(root / PAYLOAD):
        return _assemble(root, runner)


def _assemble(root: Path, runner: Runner) -> list[str]:
    slices = built_slices(root)
    if not slices:
        raise FrameworkError(
            f"no {FRAMEWORK} was built: run make ios-ffmpeg-device or make ios-ffmpeg-sim"
        )
    manifest = root / MANIFEST
    if not manifest.is_file():
        raise FrameworkError(f"{MANIFEST.as_posix()} is missing")
    payload = root / PAYLOAD
    stage = payload / f".{XCFRAMEWORK}.{os.getpid()}"
    shutil.rmtree(stage, ignore_errors=True)
    try:
        staged = []
        for name, framework in slices.items():
            copy = stage / "in" / name / FRAMEWORK
            shutil.copytree(framework, copy, symlinks=True)
            shutil.copyfile(manifest, copy / PRIVACY)
            staged.append(copy)
        runner(create_argv(staged, stage / XCFRAMEWORK))
        replace(stage / XCFRAMEWORK, payload / XCFRAMEWORK)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    return list(slices)


def replace(new: Path, target: Path) -> None:
    """Put ``new`` at ``target``; the old one comes back if the move fails."""
    aside = target.with_name(f".{target.name}.old.{os.getpid()}")
    shutil.rmtree(aside, ignore_errors=True)
    if target.exists():
        target.rename(aside)
    try:
        new.rename(target)
    except OSError:
        if aside.exists():
            aside.rename(target)
        raise
    shutil.rmtree(aside, ignore_errors=True)


def slice_framework(xcframework: Path, name: str) -> Path | None:
    """The framework folder of one slice, found through the xcframework's index."""
    _, variant = SLICES[name]
    try:
        index = plistlib.loads((xcframework / "Info.plist").read_bytes())
        libraries = index["AvailableLibraries"]
        for entry in libraries:
            if (
                entry["SupportedPlatform"] == "ios"
                and entry.get("SupportedPlatformVariant") == variant
            ):
                return xcframework / entry["LibraryIdentifier"] / entry["LibraryPath"]
    except (OSError, ValueError, KeyError, TypeError, AttributeError, *PLIST_ERRORS):
        return None
    return None


def check(root: Path, sdk: str) -> str | None:
    """None when the xcframework has a framework for ``sdk``, else the sentence to show."""
    if sdk not in SDKS:
        raise FrameworkError(f"unsupported SDK {sdk}: use iphoneos or iphonesimulator")
    target = SLICES[SDKS[sdk]][0]
    framework = slice_framework(root / PAYLOAD / XCFRAMEWORK, SDKS[sdk])
    if framework is None or not (framework / BINARY).is_file():
        return f"{XCFRAMEWORK} has no {FRAMEWORK} for {sdk}: run make {target}"
    return None


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("assemble")
    checker = commands.add_parser("check")
    checker.add_argument("--sdk", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "assemble":
            names = assemble(ROOT)
            print(f"{XCFRAMEWORK}: {', '.join(names)}")
            return 0
        problem = check(ROOT, args.sdk)
    except (FrameworkError, subprocess.CalledProcessError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    if problem:
        print(f"error: {problem}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
