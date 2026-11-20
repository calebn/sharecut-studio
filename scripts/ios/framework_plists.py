"""Make every nested ``Frameworks/*.framework`` a framework as far as App Store validation sees it.

BeeWare's ``install_dylib`` copies an application Info.plist template into each framework it
makes, so Apple reads every Python module as a second app. Standard library only: the Xcode build phase
runs this file directly with the system python3.
"""

from __future__ import annotations

import os
import plistlib
import re
import stat
import struct
import sys
import tempfile
import unicodedata
from pathlib import Path
from xml.parsers.expat import ExpatError

FRAMEWORK_MINIMUM_OS = "17.0"
SEGMENT = r"[A-Za-z0-9][A-Za-z0-9-]*"
IDENTIFIER = re.compile(rf"{SEGMENT}(?:\.{SEGMENT})*")
SEGMENT_ONLY = re.compile(SEGMENT)
PLATFORMS = ["iPhoneOS"]
SUFFIX = ".framework"


def frameworks(app: Path) -> list[Path]:
    return sorted(p for p in app.rglob("*") if p.name.casefold().endswith(SUFFIX))


def has_control_character(name: str) -> bool:
    return any(
        unicodedata.category(char).startswith("C") or unicodedata.category(char) in {"Zl", "Zp"}
        for char in name
    )


def has_unsafe_path(app: Path, folder: Path) -> bool:
    return any(has_control_character(part) for part in folder.relative_to(app).parts)


# What plistlib raises for a hostile or truncated file, beyond the OSError of reading it.
PLIST_ERRORS = (
    ExpatError,
    plistlib.InvalidFileException,
    RecursionError,
    OverflowError,
    UnicodeDecodeError,
    LookupError,
    IndexError,
    struct.error,
)


def read_plist(path: Path) -> dict[str, object]:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError(f"{path} is not a regular file")
        handle = os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise
    try:
        with handle:
            loaded = plistlib.load(handle)
    except PLIST_ERRORS as error:
        raise ValueError(f"{path} is not a valid plist: {error}") from error
    if not isinstance(loaded, dict):
        raise ValueError("not a dictionary")
    return loaded


def is_stale_temporary(name: str) -> bool:
    return name.startswith(".Info.plist.") and name.endswith(".tmp")


def write_atomic(path: Path, data: bytes) -> None:
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".Info.plist.", suffix=".tmp")
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def app_identifier(app: Path) -> str:
    return str(read_plist(app / "Info.plist")["CFBundleIdentifier"])


def fixed_identifier(app_id: str, stem: str) -> str:
    segments = []
    for raw in stem.split("."):
        segment = raw.replace("_", "-")
        if segment.startswith("-"):
            segment = f"p{segment}"
        if not SEGMENT_ONLY.fullmatch(segment):
            raise ValueError(f"cannot make a bundle identifier segment from {raw!r} in {stem!r}")
        segments.append(segment)
    return ".".join([app_id, *segments])


def fix(app: Path) -> list[str]:
    """Rewrite every framework plist that needs it; nothing is written unless all can be."""
    app_id = app_identifier(app)
    pending: list[tuple[Path, Path, dict[str, object]]] = []
    for folder in frameworks(app):
        stem = folder.name[: -len(SUFFIX)]
        path = folder / "Info.plist"
        if has_unsafe_path(app, folder):
            raise ValueError(f"{folder.relative_to(app).as_posix()!r} has a control character")
        if folder.is_symlink() or not folder.is_dir() or path.is_symlink():
            raise ValueError(f"{folder.relative_to(app)} is a symlink or not a directory")
        if not path.is_file():
            plist = created_plist(app, folder, stem, app_id)
        else:
            repaired = repaired_plist(read_plist(path), stem, app_id)
            if repaired is None:
                continue
            plist = repaired
        pending.append((folder, path, plist))
    for folder in frameworks(app):
        for stale in folder.iterdir():
            if is_stale_temporary(stale.name) and not stale.is_dir():
                stale.unlink()
    for _, path, plist in pending:
        write_atomic(path, plistlib.dumps(plist, fmt=plistlib.FMT_XML))
    return [folder.relative_to(app).as_posix() for folder, _, _ in pending]


def generated(app: Path) -> list[str]:
    """Frameworks whose identifier sits under the app's own, which are the ones BeeWare made."""
    prefix = f"{app_identifier(app)}."
    found = []
    for folder in frameworks(app):
        if has_unsafe_path(app, folder):
            raise ValueError(f"{folder.relative_to(app).as_posix()!r} has a control character")
        try:
            identifier = read_plist(folder / "Info.plist").get("CFBundleIdentifier")
        except (OSError, ValueError):
            continue
        if isinstance(identifier, str) and identifier.startswith(prefix):
            found.append(folder.relative_to(app).as_posix())
    return found


def created_plist(app: Path, folder: Path, stem: str, app_id: str) -> dict[str, object]:
    if not (folder / stem).is_file():
        raise FileNotFoundError(f"{folder} has neither Info.plist nor the executable {stem}")
    app_plist = read_plist(app / "Info.plist")
    return {
        "CFBundleExecutable": stem,
        "CFBundleIdentifier": fixed_identifier(app_id, stem),
        "CFBundlePackageType": "FMWK",
        "CFBundleVersion": app_plist.get("CFBundleVersion", "1"),
        "CFBundleShortVersionString": app_plist.get("CFBundleShortVersionString", "1"),
        "MinimumOSVersion": FRAMEWORK_MINIMUM_OS,
        "CFBundleSupportedPlatforms": PLATFORMS,
    }


def repaired_plist(plist: dict[str, object], stem: str, app_id: str) -> dict[str, object] | None:
    """The plist to write, or None when it is already a valid framework plist."""
    result = dict(plist)
    if plist.get("CFBundlePackageType") != "FMWK":
        result["CFBundlePackageType"] = "FMWK"
        result["MinimumOSVersion"] = FRAMEWORK_MINIMUM_OS
        result.setdefault("CFBundleSupportedPlatforms", PLATFORMS)
    if plist.get("CFBundleExecutable") != stem:
        result["CFBundleExecutable"] = stem
    identifier = plist.get("CFBundleIdentifier")
    if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
        result["CFBundleIdentifier"] = fixed_identifier(app_id, stem)
    return None if result == plist else result


def check(app: Path) -> list[str]:
    problems = []
    seen: dict[str, str] = {}
    try:
        app_id = app_identifier(app)
    except (OSError, ValueError, KeyError):
        app_id = ""
    for folder in frameworks(app):
        name = folder.relative_to(app).as_posix()
        stem = folder.name[: -len(SUFFIX)]
        if has_unsafe_path(app, folder):
            problems.append(f"{name!r} has a control character")
            continue
        if folder.is_symlink() or not folder.is_dir():
            problems.append(f"{name} is a symlink or not a directory")
            continue
        if (folder / "Info.plist").is_symlink():
            problems.append(f"{name} has a symlinked Info.plist")
            continue
        try:
            plist = read_plist(folder / "Info.plist")
        except FileNotFoundError:
            problems.append(f"{name} has no Info.plist")
            continue
        except (OSError, ValueError):
            problems.append(f"{name} has an unreadable Info.plist")
            continue
        if plist.get("CFBundlePackageType") != "FMWK":
            problems.append(
                f"{name} CFBundlePackageType is {plist.get('CFBundlePackageType')!r}, expected 'FMWK'"
            )
        if plist.get("CFBundleExecutable") != stem:
            problems.append(f"{name} CFBundleExecutable is not {stem}")
        identifier = plist.get("CFBundleIdentifier")
        if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
            problems.append(f"{name} has a malformed bundle identifier {identifier!r}")
            continue
        if app_id and identifier.casefold() == app_id.casefold():
            problems.append(f"{name} has the same bundle identifier as the app")
        if identifier.casefold() in seen:
            problems.append(
                f"{name} has a duplicate bundle identifier, also {seen[identifier.casefold()]}"
            )
        seen.setdefault(identifier.casefold(), name)
    return problems


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in {"fix", "check", "list"}:
        print("usage: framework_plists.py fix|check|list APP", file=sys.stderr)
        return 2
    app = Path(argv[2])
    if argv[1] in {"fix", "list"}:
        try:
            names = fix(app) if argv[1] == "fix" else generated(app)
        except (OSError, ValueError, KeyError) as error:
            print(error, file=sys.stderr)
            return 2
        if names:
            print("\n".join(names))
        return 0
    problems = check(app)
    if problems:
        print("\n".join(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
