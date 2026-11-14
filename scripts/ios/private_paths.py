"""Keep the build machine's paths out of what the iOS app ships.

Two halves share one list of directories. ``remap_flags`` and ``with_rustflags`` tell rustc to
rewrite them in compiled code; ``private_needles`` and ``scan_tree`` / ``scan_zip`` prove nothing
survived. The payload builder and the release script both import this module, so the scan that
passes the payload is the scan that gates the signed build.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import shlex
import struct
import tempfile
import zipfile
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

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


def text_forms(value: str) -> list[str]:
    """Every spelling of *value* a build can leave behind: as written, JSON-escaped (``\\/``),
    percent-encoded, and the resolved path when *value* is an absolute path that resolves
    elsewhere (``/var`` is ``/private/var`` on macOS)."""
    forms = [
        value,
        json.dumps(value)[1:-1].replace("/", "\\/"),
        quote(value, safe="/"),
        quote(value, safe=""),
    ]
    if value.startswith("/"):
        resolved = str(Path(value).resolve())
        forms += [resolved, quote(resolved, safe="/")]
    return list(dict.fromkeys(form for form in forms if form))


def needle_strings(
    directories: Sequence[Path | str], *, user_segment: str | None = None
) -> list[str]:
    """The text a shipped file or a log must not hold: each directory in every spelling, plus the
    user name as a path segment. The redactor and the scanner both start here."""
    values = [str(directory) for directory in directories]
    if user_segment:
        values.append(f"/Users/{user_segment}/")
    return list(dict.fromkeys(form for value in values for form in text_forms(value)))


def encode_needles(strings: Sequence[str]) -> list[bytes]:
    """UTF-8 and UTF-16LE (Swift and Objective-C literals) of each string."""
    encoded = [text.encode() for text in strings] + [text.encode("utf-16-le") for text in strings]
    return list(dict.fromkeys(encoded))


def private_needles(
    home: Path, cache: Path, extra: Sequence[Path | str] = (), *, user_segment: str | None = None
) -> list[bytes]:
    return encode_needles(
        needle_strings([home, cache, *extra], user_segment=user_segment or home.name or None)
    )


@dataclass(frozen=True)
class Hit:
    member: str
    section: str | None
    context: str


@dataclass(frozen=True)
class ScanReport:
    files_scanned: int = 0
    archives_opened: int = 0
    hits: tuple[Hit, ...] = ()
    unseen: tuple[str, ...] = ()

    @property
    def clean(self) -> bool:
        return not self.hits

    @property
    def offenders(self) -> list[str]:
        return sorted({hit.member for hit in self.hits})

    def merged(self, other: ScanReport) -> ScanReport:
        return ScanReport(
            self.files_scanned + other.files_scanned,
            self.archives_opened + other.archives_opened,
            self.hits + other.hits,
            self.unseen + other.unseen,
        )

    def attribution(self) -> list[tuple[int, str, str]]:
        """``(count, section, context)`` most frequent first, with version numbers and hashes
        folded, so one registry crate that appears 1300 times reads as one line."""
        folded = Counter((hit.section or "-", FOLD.sub("*", hit.context)) for hit in self.hits)
        return [(count, section, context) for (section, context), count in folded.most_common()]


FOLD = re.compile(r"\d+(?:\.\d+)+|[0-9a-f]{8,}")
UNREADABLE_MEMBERS = (".car",)
MAX_ARCHIVE_DEPTH = 4
MH_MAGIC_64 = b"\xcf\xfa\xed\xfe"
LC_SEGMENT_64 = 0x19


def macho_sections(data: bytes) -> list[tuple[str, int, int]]:
    """``("SEGMENT,section", file offset, size)`` rows of a thin 64-bit Mach-O; empty for
    anything else (static archives, fat files, text)."""
    if data[:4] != MH_MAGIC_64:
        return []
    sections: list[tuple[str, int, int]] = []
    offset = 32
    for _ in range(struct.unpack_from("<I", data, 16)[0]):
        if offset + 8 > len(data):
            break
        command, size = struct.unpack_from("<II", data, offset)
        if size < 8:
            break
        if command == LC_SEGMENT_64:
            for index in range(struct.unpack_from("<I", data, offset + 64)[0]):
                base = offset + 72 + index * 80
                if base + 80 > len(data):
                    break
                name = data[base : base + 16].rstrip(b"\0").decode("latin-1")
                segment = data[base + 16 : base + 32].rstrip(b"\0").decode("latin-1")
                section_size = struct.unpack_from("<Q", data, base + 40)[0]
                file_offset = struct.unpack_from("<I", data, base + 48)[0]
                sections.append((f"{segment},{name}", file_offset, section_size))
        offset += size
    return sections


def scan_bytes(member: str, data: bytes, needles: Sequence[bytes]) -> tuple[Hit, ...]:
    """Hits of *needles* in *data*, each with its Mach-O section and a window of printable
    context in which every needle is replaced by ``<private>``."""
    pattern = re.compile(
        b"|".join(re.escape(n) for n in sorted(set(needles), key=len, reverse=True))
    )
    found = list(pattern.finditer(data))
    if not found:
        return ()
    sections = macho_sections(data)
    hits = []
    for match in found:
        section = next(
            (name for name, start, size in sections if start <= match.start() < start + size), None
        )
        start = max(0, match.start() - 40)
        end = match.end() + 40
        before = data.rfind(b"\x00", start, match.start())
        after = data.find(b"\x00", match.end(), end)
        window = data[before + 1 if before >= 0 else start : after if after >= 0 else end]
        text = pattern.sub(b"<private>", window)
        printable = "".join(chr(b) if 32 <= b < 127 else "." for b in text)
        hits.append(Hit(member, section, printable))
    return tuple(hits)


def scan_tree(root: Path, needles: Sequence[bytes]) -> ScanReport:
    """Every regular file under *root*, and every archive inside it, decompressed."""
    report = ScanReport()
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        report = report.merged(scan_member(relative, path.read_bytes(), needles, 0))
    return report


def scan_member(member: str, data: bytes, needles: Sequence[bytes], depth: int) -> ScanReport:
    unseen = (member,) if member.endswith(UNREADABLE_MEMBERS) else ()
    report = ScanReport(1, 0, scan_bytes(member, data, needles), unseen)
    if data[:4] == b"PK\x03\x04" and depth < MAX_ARCHIVE_DEPTH:
        report = report.merged(scan_zip_bytes(member, data, needles, depth + 1))
    return report


def scan_zip_bytes(name: str, data: bytes, needles: Sequence[bytes], depth: int) -> ScanReport:
    report = ScanReport(0, 1)
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return ScanReport(0, 0, (), (f"{name or 'archive'} (not a readable archive)",))
    with archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            member = f"{name}!{info.filename}" if name else info.filename
            try:
                content = archive.read(info)
            except (RuntimeError, NotImplementedError, zipfile.BadZipFile):
                report = report.merged(ScanReport(0, 0, (), (f"{member} (unreadable)",)))
                continue
            report = report.merged(scan_member(member, content, needles, depth))
    return report


def scan_zip(archive: Path, needles: Sequence[bytes]) -> ScanReport:
    """An ``.ipa`` is deflated, so the bytes on disk hide every path; read each member."""
    return scan_zip_bytes("", archive.read_bytes(), needles, 1)


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


def rustup_home() -> Path:
    return Path(os.environ.get("RUSTUP_HOME") or Path.home() / ".rustup")


def machine_needles(workspace: Path) -> list[bytes]:
    """What a shipped artifact must not name: this machine's home, user, caches, toolchain
    homes, this checkout and the temporary directory."""
    return private_needles(
        Path.home(),
        cache_dir(),
        [cargo_home(), rustup_home(), workspace, tempfile.gettempdir()],
    )


def default_directories(workspace: Path) -> dict[str, Path]:
    return {
        "home": Path.home(),
        "cache": cache_dir(),
        "cargo": cargo_home(),
        "source": workspace,
    }


def changed(before: Mapping[str, str], after: Mapping[str, str]) -> set[str]:
    return {name for name in after if before.get(name) != after[name]}


def scan_artifact(path: Path, needles: Sequence[bytes]) -> ScanReport:
    return scan_tree(path, needles) if path.is_dir() else scan_zip(path, needles)


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
    needles = machine_needles(ROOT)
    failed = False
    for artifact in args.artifact:
        report = scan_artifact(artifact, needles)
        print(
            f"{artifact.name}: {report.files_scanned} files, {report.archives_opened} archives "
            f"opened, {len(report.hits)} hits, {len(report.unseen)} not readable"
        )
        for count, section, context in report.attribution():
            print(f"  {count:5d}  {section:20s}  {context}")
        for name in report.unseen:
            print(f"  not readable: {name}")
        failed = failed or not report.clean
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
