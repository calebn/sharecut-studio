"""Shared, bounded wire contract for user-approved diagnostics reports."""

from __future__ import annotations

import io
import json
import stat
import zipfile
from dataclasses import dataclass

MAX_BUNDLE_BYTES = 5 * 1024 * 1024
MAX_EXPANDED_BYTES = 8 * 1024 * 1024
MAX_MEMBERS = 34
MAX_APP_VERSION_LENGTH = 80


def is_safe_diagnostics_log_name(name: str) -> bool:
    """Flat, printable log-member names accepted by the wire contract."""
    return (
        name.isprintable()
        and len(name) <= 255
        and "/" not in name
        and "\\" not in name
        and not name.startswith("..")
        and name.endswith(".log")
    )


def diagnostics_log_archive_name(source_name: str, used: set[str]) -> str:
    """Preserve readable basenames while bounding and uniquifying ZIP members."""
    stem = source_name.removesuffix(".log")
    stem = "".join(char if char.isprintable() and char not in "/\\" else "_" for char in stem)
    while stem.startswith(".."):
        stem = stem[1:]
    stem = stem or "log"
    number = 1
    while True:
        suffix = "" if number == 1 else f"-{number}"
        candidate = f"{stem[: 255 - len(suffix) - 4]}{suffix}.log"
        if candidate not in used:
            return candidate
        number += 1


@dataclass(frozen=True)
class BundlePreview:
    files: tuple[str, ...]
    size_bytes: int
    app_version: str
    created_at: str


def validate_diagnostics_bundle(data: bytes) -> BundlePreview:
    """Reject untrusted ZIP structure before storage or publication."""
    if not data or len(data) > MAX_BUNDLE_BYTES:
        raise ValueError("diagnostics bundle must be at most 5 MiB")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = archive.infolist()
            if not 2 <= len(members) <= MAX_MEMBERS:
                raise ValueError("unexpected diagnostics file count")
            names = [member.filename for member in members]
            if len(set(names)) != len(names) or names[:2] != ["report.json", "README.txt"]:
                raise ValueError("unexpected diagnostics files")
            expanded = 0
            for member in members:
                name = member.filename
                mode = (member.external_attr >> 16) & 0xFFFF
                if (
                    (
                        name not in {"report.json", "README.txt"}
                        and not is_safe_diagnostics_log_name(name)
                    )
                    or member.is_dir()
                    or (mode and stat.S_IFMT(mode) not in (0, stat.S_IFREG))
                    or member.flag_bits & 1
                ):
                    raise ValueError("unsafe diagnostics file")
                expanded += member.file_size
                if expanded > MAX_EXPANDED_BYTES:
                    raise ValueError("diagnostics bundle expanded size exceeded")
            with archive.open("report.json") as source:
                report_data = source.read(256 * 1024 + 1)
            if len(report_data) > 256 * 1024:
                raise ValueError("diagnostics report too large")
            report = json.loads(report_data)
            if not isinstance(report, dict) or not isinstance(report.get("app_version"), str):
                raise ValueError("invalid diagnostics report")
            version = report["app_version"]
            if not version or len(version) > MAX_APP_VERSION_LENGTH or not version.isprintable():
                raise ValueError("invalid diagnostics app version")
            if not isinstance(report.get("created_at"), str):
                raise ValueError("invalid diagnostics timestamp")
            for member in members:
                with archive.open(member) as source:
                    while source.read(64 * 1024):
                        pass  # Force CRC validation under the expanded-size bound.
            return BundlePreview(
                tuple(names), len(data), report["app_version"], report["created_at"]
            )
    except (zipfile.BadZipFile, EOFError, OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError("invalid diagnostics bundle") from exc
