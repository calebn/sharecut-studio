"""Insert a saved segment into an episode, as one undoable edit."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from podcast_mcp.edits.segment_insert import (
    SegmentAudio,
    check_layout,
    check_position,
    insert_segment,
)
from podcast_mcp.engines.track_media import media_asset_from_path
from podcast_mcp.segments.model import SegmentFile
from podcast_mcp.segments.store import SegmentStore, sha256_file
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.coded_error import CodedValueError


def _mismatch(segment: SegmentFile, name: str) -> CodedValueError:
    return CodedValueError(
        f"The audio file {name} of segment {segment.name!r} does not match its recorded hash.",
        code="segment_hash_mismatch",
    )


def copy_segment_audio(
    workspace_dir: Path, segment: SegmentFile, folder: Path
) -> dict[str, SegmentAudio]:
    """Copy each audio file of a stored segment into ``raw/`` and check the copy's hash.

    The name is the content hash, so inserting the same segment twice stores its audio once.
    The hash is checked on the copy, not the library file, so a file changed after the
    library read it cannot get in.
    """
    raw = workspace_dir / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    out: dict[str, SegmentAudio] = {}
    for name, entry in segment.media.items():
        dest = raw / f"segment-{entry.sha256}{Path(name).suffix}"
        # Always a fresh copy: a file already at the name is never trusted or probed.
        fd, tmp_name = tempfile.mkstemp(prefix=".segment-", suffix=Path(name).suffix, dir=raw)
        os.close(fd)
        tmp = Path(tmp_name)
        try:
            shutil.copyfile(folder / name, tmp)
            if sha256_file(tmp) != entry.sha256:
                raise _mismatch(segment, name)
            asset = media_asset_from_path(tmp, store_path=f"raw/{dest.name}")
            os.replace(tmp, dest)
        except OSError as exc:
            raise CodedValueError(
                f"The audio file {name} of segment {segment.name!r} could not be copied: "
                f"{exc.strerror or exc}.",
                code="segment_write_failed",
            ) from exc
        finally:
            tmp.unlink(missing_ok=True)
        out[name] = SegmentAudio(
            source_id=f"seg_{entry.sha256}",
            path=asset.path,
            duration_sec=float(asset.duration_sec or 0.0),
            sample_rate=int(asset.sample_rate or 0),
            channels=int(asset.channels or 0),
        )
    return out


def insert_saved_segment(
    ws: ProjectWorkspace,
    segment_id: str,
    at: float,
    *,
    version: int | None = None,
    store: SegmentStore | None = None,
) -> dict[str, Any]:
    """Insert a library segment at timeline second ``at``; later content moves by its length.

    The audio is copied into the project and its hash checked. The edit is one undo step.
    Errors: ``segment_unknown``, ``segment_hash_mismatch``, ``segment_media_invalid``,
    ``segment_write_failed``, ``segment_position_out_of_range``.
    """
    library = store or SegmentStore()
    segment = library.get(segment_id, version)
    check_position(ws.project, at)
    check_layout(segment)
    audio = copy_segment_audio(
        Path(ws.project.workspace_dir), segment, library.path(segment.id, segment.version)
    )
    return ws.mutate(
        f"before insert segment {segment.name}",
        f"after insert segment {segment.name}",
        lambda p: insert_segment(p, segment, audio, at, defaults=ws.effective_config()),
        operation="insert_segment",
        params={"segment_id": segment.id, "version": segment.version, "at": at},
    )
