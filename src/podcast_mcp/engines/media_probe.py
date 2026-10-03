from __future__ import annotations

import logging
from dataclasses import replace
from functools import lru_cache
from math import isfinite
from pathlib import Path

from podcast_mcp.engines.ffmpeg import AudioProbe, FFmpegEngine
from podcast_mcp.util.project_state import FileRevision, file_revision

log = logging.getLogger(__name__)
MEDIA_PROBE_CACHE_SIZE = 1024


@lru_cache(maxsize=MEDIA_PROBE_CACHE_SIZE)
def _cached_media_probe(path: str, revision: FileRevision) -> AudioProbe:
    del revision
    return FFmpegEngine().probe(Path(path))


def probe_media(path: Path) -> AudioProbe | None:
    """Read probe metadata, or None for missing/unreadable media.

    Successful probes share a bounded process-local file-revision cache. Failed
    probes are retried on later calls. Copies keep callers from changing cached
    metadata. Same-stat media replacements remain outside this cache contract.
    """
    if not path.is_file():
        return None
    try:
        resolved = path.resolve()
        return replace(_cached_media_probe(str(resolved), file_revision(resolved)))
    except Exception as exc:
        log.debug("probe failed for %s: %s", path, exc)
        return None


def probe_first_audio_duration_sec(path: Path) -> float | None:
    """Declared first-audio extent, refusing unknown, estimated or multistream media.

    The probe's duration_estimated flag includes multiple audio streams. No
    container duration substitutes for the selected audio's declared extent.
    This check does not certify continuous or decodable PCM throughout the file.
    """
    info = probe_media(path)
    if info is None or info.duration_estimated:
        return None
    duration = info.audio_duration_sec
    return duration if duration is not None and isfinite(duration) and duration > 0 else None
