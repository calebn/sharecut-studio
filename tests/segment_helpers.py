"""Build segment folders and bundles for the segment tests."""

from __future__ import annotations

import itertools
import zipfile
from pathlib import Path

from podcast_mcp.segments.model import (
    SEGMENT_JSON,
    MediaEntry,
    SegmentClip,
    SegmentFile,
    segment_id_for,
    segment_json,
)
from podcast_mcp.segments.store import sha256_file

_COUNTER = itertools.count(1)


def make_segment_dir(
    root: Path,
    *,
    name: str = "Warm Intro",
    audio: bytes = b"fLaC-one",
    kind: str = "intro",
    fader_db: float = 0.0,
) -> Path:
    folder = root / f"seg-{next(_COUNTER):04d}"
    folder.mkdir(parents=True)
    (folder / "clip-01.flac").write_bytes(audio)
    segment = SegmentFile.model_validate(
        {
            "id": segment_id_for(name),
            "name": name,
            "kind": kind,
            "role": "intro",
            "fader_db": fader_db,
            "clips": [SegmentClip(audio="clip-01.flac", offset_sec=0, duration_sec=2.0)],
            "media": {
                "clip-01.flac": MediaEntry(
                    sha256=sha256_file(folder / "clip-01.flac"), bytes=len(audio)
                )
            },
        }
    )
    (folder / SEGMENT_JSON).write_text(segment_json(segment), encoding="utf-8")
    return folder


def rewrite_zip(src: Path, dest: Path, *, replace: dict[str, bytes] | None = None) -> Path:
    """Copy a zip, swapping the bytes of some entries."""
    replace = replace or {}
    with zipfile.ZipFile(src) as source, zipfile.ZipFile(dest, "w") as target:
        for info in source.infolist():
            target.writestr(info.filename, replace.get(info.filename, source.read(info)))
    return dest
