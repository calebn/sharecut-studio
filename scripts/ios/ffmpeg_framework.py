"""Assemble and check the app's native xcframeworks, ``FFmpeg.xcframework`` and ``Whisper.xcframework``.

``build_ffmpeg.sh`` writes one ``FFmpeg.framework`` per SDK under ``ios-ffmpeg/out/<device|sim>``
and ``build_whisper.sh`` one ``Whisper.framework`` under ``ios-whisper/out/<device|sim>``; the Xcode
project links the one xcframework of each in ``ios-payload``.

    ffmpeg_framework.py [--framework ffmpeg|whisper] assemble
    ffmpeg_framework.py [--framework ffmpeg|whisper] check --sdk iphoneos|iphonesimulator

``--framework`` defaults to ffmpeg.

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
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from xml.parsers.expat import ExpatError

ROOT = Path(__file__).resolve().parents[2]
TAURI = Path("gui/desktop/src-tauri")
PAYLOAD = TAURI / "ios-payload"
LOCK = ".native-frameworks.lock"
PRIVACY = "PrivacyInfo.xcprivacy"


@dataclass(frozen=True)
class Spec:
    name: str
    out: Path
    manifest: Path
    xcframework: str
    framework: str
    binary: str
    targets: Mapping[str, str]


SPECS = {
    "ffmpeg": Spec(
        "ffmpeg",
        TAURI / "ios-ffmpeg/out",
        TAURI / "ios/ffmpeg/PrivacyInfo.xcprivacy",
        "FFmpeg.xcframework",
        "FFmpeg.framework",
        "FFmpeg",
        {"device": "ios-ffmpeg-device", "sim": "ios-ffmpeg-sim"},
    ),
    "whisper": Spec(
        "whisper",
        TAURI / "ios-whisper/out",
        TAURI / "ios/whisper/PrivacyInfo.xcprivacy",
        "Whisper.xcframework",
        "Whisper.framework",
        "Whisper",
        {"device": "ios-whisper-device", "sim": "ios-whisper-sim"},
    ),
}
VARIANTS = {"device": None, "sim": "simulator"}
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


def spec_for(framework: str) -> Spec:
    try:
        return SPECS[framework]
    except KeyError:
        raise FrameworkError(f"unknown framework {framework}: use ffmpeg or whisper") from None


def built_slices(root: Path, framework: str = "ffmpeg") -> dict[str, Path]:
    spec = spec_for(framework)
    found = {}
    for name in VARIANTS:
        built = root / spec.out / name / spec.framework
        if (built / spec.binary).is_file():
            found[name] = built
    return found


def create_argv(frameworks: Sequence[Path], output: Path) -> list[str]:
    argv = ["xcodebuild", "-create-xcframework"]
    for framework in frameworks:
        argv += ["-framework", str(framework)]
    return [*argv, "-output", str(output)]


@contextlib.contextmanager
def assembling(payload: Path) -> Iterator[None]:
    """Hold the payload's assemble lock, so ``make -j`` over two native frameworks cannot run two
    assembles into the payload at once.

    A second assemble waits, then sees the slices the first one's make target finished.
    """
    payload.mkdir(parents=True, exist_ok=True)
    with (payload / LOCK).open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def assemble(root: Path, runner: Runner = run_xcodebuild, framework: str = "ffmpeg") -> list[str]:
    """Build ``ios-payload/<Name>.xcframework`` from the slices that exist; return their names."""
    spec = spec_for(framework)
    with assembling(root / PAYLOAD):
        return _assemble(root, runner, spec)


def _assemble(root: Path, runner: Runner, spec: Spec) -> list[str]:
    slices = built_slices(root, spec.name)
    if not slices:
        raise FrameworkError(
            f"no {spec.framework} was built: run make {spec.targets['device']} "
            f"or make {spec.targets['sim']}"
        )
    manifest = root / spec.manifest
    if not manifest.is_file():
        raise FrameworkError(f"{spec.manifest.as_posix()} is missing")
    payload = root / PAYLOAD
    stage = payload / f".{spec.xcframework}.{os.getpid()}"
    shutil.rmtree(stage, ignore_errors=True)
    try:
        staged = []
        for name, built in slices.items():
            copy = stage / "in" / name / spec.framework
            shutil.copytree(built, copy, symlinks=True)
            shutil.copyfile(manifest, copy / PRIVACY)
            staged.append(copy)
        runner(create_argv(staged, stage / spec.xcframework))
        replace(stage / spec.xcframework, payload / spec.xcframework)
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
    variant = VARIANTS[name]
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


def check(root: Path, sdk: str, framework: str = "ffmpeg") -> str | None:
    """None when the xcframework has a framework for ``sdk``, else the sentence to show."""
    spec = spec_for(framework)
    if sdk not in SDKS:
        raise FrameworkError(f"unsupported SDK {sdk}: use iphoneos or iphonesimulator")
    target = spec.targets[SDKS[sdk]]
    found = slice_framework(root / PAYLOAD / spec.xcframework, SDKS[sdk])
    if found is None or not (found / spec.binary).is_file():
        return f"{spec.xcframework} has no {spec.framework} for {sdk}: run make {target}"
    return None


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--framework", choices=sorted(SPECS), default="ffmpeg")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("assemble")
    checker = commands.add_parser("check")
    checker.add_argument("--sdk", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "assemble":
            names = assemble(ROOT, framework=args.framework)
            print(f"{SPECS[args.framework].xcframework}: {', '.join(names)}")
            return 0
        problem = check(ROOT, args.sdk, args.framework)
    except (FrameworkError, subprocess.CalledProcessError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    if problem:
        print(f"error: {problem}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
