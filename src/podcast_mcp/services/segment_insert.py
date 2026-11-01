"""Insert a saved segment into an episode, as one undoable edit."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from podcast_mcp.edits.segment_insert import SegmentAudio, check_position, insert_segment
from podcast_mcp.engines.track_media import media_asset_from_path
from podcast_mcp.segments.model import SegmentFile
from podcast_mcp.segments.store import SegmentStore, sha256_file
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.coded_error import CodedValueError

_HASH_CHARS = 16


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
        stem = entry.sha256[:_HASH_CHARS]
        dest = raw / f"segment-{stem}{Path(name).suffix}"
        if not (dest.is_file() and sha256_file(dest) == entry.sha256):
            fd, tmp_name = tempfile.mkstemp(prefix=".segment-", suffix=".part", dir=raw)
            os.close(fd)
            tmp = Path(tmp_name)
            try:
                shutil.copyfile(folder / name, tmp)
                if sha256_file(tmp) != entry.sha256:
                    raise _mismatch(segment, name)
                os.replace(tmp, dest)
            except OSError as exc:
                raise CodedValueError(
                    f"The audio file {name} of segment {segment.name!r} could not be copied: "
                    f"{exc.strerror or exc}.",
                    code="segment_write_failed",
                ) from exc
            finally:
                tmp.unlink(missing_ok=True)
        asset = media_asset_from_path(dest, store_path=f"raw/{dest.name}")
        out[name] = SegmentAudio(
            source_id=f"seg_{stem}",
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
    Errors: ``segment_unknown``, ``segment_hash_mismatch``, ``segment_position_out_of_range``.
    """
    library = store or SegmentStore()
    segment = library.get(segment_id, version)
    check_position(ws.project, at)
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
