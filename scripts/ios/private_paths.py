"""Keep the build machine's paths out of what the iOS app ships.

Two halves share one list of directories. ``remap_flags`` and ``with_rustflags`` tell rustc to
rewrite them in compiled code; ``private_needles`` and ``scan_private_paths`` prove nothing
survived. The payload builder and the release script both import this module, so the scan that
passes the payload is the scan that gates the signed build.
"""

from __future__ import annotations

import argparse
import os
import shlex
import tempfile
import zipfile
from collections.abc import Mapping, Sequence
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REMAP_ROOTS = (("home", "/home"), ("cache", "/cache"), ("cargo", "/cargo"), ("source", "/source"))
RUSTFLAGS_SEPARATOR = "\x1f"


def remap_flags(directories: Mapping[str, Path]) -> list[str]:
    """``--remap-path-prefix`` flags for the named directories, widest first (rustc takes the last
    match, so the narrower directory inside the home wins)."""
    return [
        f"--remap-path-prefix={directories[name]}={target}"
        for name, target in REMAP_ROOTS
        if name in directories
    ]


def with_rustflags(environment: Mapping[str, str], flags: Sequence[str]) -> dict[str, str]:
    """*environment* with *flags* appended to the Rust flags cargo will read.

    Cargo reads ``CARGO_ENCODED_RUSTFLAGS`` before ``RUSTFLAGS``, so flags are added to whichever is
    set. Either variable replaces ``build.rustflags`` from a cargo config file.
    """
    updated = dict(environment)
    if "CARGO_ENCODED_RUSTFLAGS" in environment:
        existing = environment["CARGO_ENCODED_RUSTFLAGS"]
        updated["CARGO_ENCODED_RUSTFLAGS"] = RUSTFLAGS_SEPARATOR.join(
            [*([existing] if existing else []), *flags]
        )
    else:
        updated["RUSTFLAGS"] = " ".join([*environment.get("RUSTFLAGS", "").split(), *flags])
    return updated


def private_needles(home: Path, cache: Path) -> list[bytes]:
    """The strings that must not appear in a shipped file: the home, its user name as a path
    segment and the build cache."""
    return [
        str(home).encode(),
        f"/Users/{home.name}/".encode(),
        str(cache).encode(),
    ]


def scan_private_paths(root: Path, needles: Sequence[bytes]) -> tuple[int, list[str]]:
    """Count the files under *root* and list those holding any needle; binaries and text alike."""
    scanned = 0
    offenders: list[str] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        scanned += 1
        data = path.read_bytes()
        if any(needle in data for needle in needles):
            offenders.append(path.relative_to(root).as_posix())
    return scanned, offenders


RELEASE_PROFILE = {"CARGO_PROFILE_RELEASE_DEBUG": "0", "CARGO_PROFILE_RELEASE_STRIP": "symbols"}


def cache_dir() -> Path:
    return Path.home() / ".cache" / "sharecut-build" / "ios"


def cargo_home() -> Path:
    return Path(os.environ.get("CARGO_HOME") or Path.home() / ".cargo")


def release_rust_environment(
    environment: Mapping[str, str], directories: Mapping[str, Path]
) -> dict[str, str]:
    """*environment* for a release build of the app's Rust library that carries no builder path.

    The remap flags rewrite *directories* (see ``REMAP_ROOTS``) in panic locations, ``file!()``
    and debug info, and are appended to whatever Rust flags the environment already sets. Debug
    info and symbols are off for the release profile through cargo's profile variables, so the
    shared ``[profile.release]`` that desktop builds use is untouched.
    """
    return {**with_rustflags(environment, remap_flags(directories)), **RELEASE_PROFILE}


def default_directories(workspace: Path) -> dict[str, Path]:
    return {
        "home": Path.home(),
        "cache": cache_dir(),
        "cargo": cargo_home(),
        "source": workspace,
    }


def changed(before: Mapping[str, str], after: Mapping[str, str]) -> set[str]:
    return {name for name in after if before.get(name) != after[name]}


def scan_artifact(path: Path, needles: Sequence[bytes]) -> tuple[int, list[str]]:
    """Scan an ``.app`` folder, or an ``.ipa`` after unpacking it (its members are compressed, so
    the zip's own bytes would hide every path)."""
    if path.is_dir():
        return scan_private_paths(path, needles)
    with tempfile.TemporaryDirectory() as unpacked, zipfile.ZipFile(path) as archive:
        archive.extractall(unpacked)
        return scan_private_paths(Path(unpacked), needles)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser(
        "rust-env", help="print shell exports for a path-free release build; eval them"
    )
    scan = commands.add_parser("scan", help="fail when a built .app or .ipa names this machine")
    scan.add_argument("artifact", type=Path, nargs="+")
    args = parser.parse_args(argv)
    if args.command == "rust-env":
        environment = release_rust_environment(dict(os.environ), default_directories(ROOT))
        for name in sorted(changed(os.environ, environment)):
            print(f"export {name}={shlex.quote(environment[name])}")
        return 0
    needles = private_needles(Path.home(), cache_dir())
    failed = False
    for artifact in args.artifact:
        scanned, offenders = scan_artifact(artifact, needles)
        print(f"{artifact.name}: {scanned} files scanned, {len(offenders)} name this machine")
        for offender in offenders:
            print(f"  {offender}")
        failed = failed or bool(offenders)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
