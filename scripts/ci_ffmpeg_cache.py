from __future__ import annotations

import argparse
import hashlib
import json
import re
import shlex
import shutil
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


@dataclass(frozen=True)
class DownloadArchive:
    filename: str
    uri: str
    size: int
    sha256: str


def parse_archive_plan(stdout: str) -> dict[str, DownloadArchive]:
    archives: dict[str, DownloadArchive] = {}
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith(("'", '"', "http:", "https:", "file:")):
            continue
        if "\\" in line:
            raise ValueError(f"Unexpected escape in APT archive row: {line!r}")
        row = shlex.split(line)
        if len(row) != 4:
            raise ValueError(f"Malformed APT archive row: {line!r}")
        uri, filename, size, checksum = row
        url = urlsplit(uri)
        is_network_uri = url.scheme in {"http", "https"} and bool(url.netloc)
        is_apt_mirror_uri = (
            url.scheme == "mirror+file" and not url.netloc and url.path.startswith("/")
        )
        if not (is_network_uri or is_apt_mirror_uri):
            raise ValueError(f"Invalid archive URI: {uri!r}")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.+:%_~-]*\.deb", filename):
            raise ValueError(f"Unsafe archive filename: {filename!r}")
        if filename in archives:
            raise ValueError(f"Duplicate archive filename: {filename!r}")
        if not re.fullmatch(r"[0-9]+", size) or int(size) <= 0:
            raise ValueError(f"Invalid archive size: {size!r}")
        if not re.fullmatch(r"SHA256:[0-9a-fA-F]{64}", checksum):
            raise ValueError(f"Expected SHA256 archive hash: {checksum!r}")
        archives[filename] = DownloadArchive(filename, uri, int(size), checksum[7:].lower())
    return archives


def archive_plan_digest(archives: dict[str, DownloadArchive]) -> str:
    rows = [
        [archive.filename, archive.uri, archive.size, archive.sha256]
        for _, archive in sorted(archives.items())
    ]
    return hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()


def retain_verified_archives(archives: dict[str, DownloadArchive], directory: Path) -> int:
    verified = 0
    for path in directory.iterdir():
        if not path.name.endswith(".deb"):
            continue
        archive = archives.get(path.name)
        if (
            archive is not None
            and not path.is_symlink()
            and path.is_file()
            and path.stat().st_size == archive.size
        ):
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if digest == archive.sha256:
                verified += 1
                continue
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()
    return verified


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate FFmpeg download archives")
    parser.add_argument("operation", choices=("plan", "verify"))
    parser.add_argument("manifest", type=Path)
    parser.add_argument("directory", type=Path, nargs="?")
    args = parser.parse_args()
    if args.operation == "verify" and args.directory is None:
        parser.error("verify requires an archive directory")
    archives = parse_archive_plan(args.manifest.read_text(encoding="utf-8"))
    print(f"digest={archive_plan_digest(archives)}")
    print(f"archive_count={len(archives)}")
    print(f"total_bytes={sum(archive.size for archive in archives.values())}")
    if args.operation == "verify":
        print(f"verified_count={retain_verified_archives(archives, args.directory)}")


if __name__ == "__main__":
    main()
