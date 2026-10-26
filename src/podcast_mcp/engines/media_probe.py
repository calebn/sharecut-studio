from __future__ import annotations

import logging
from dataclasses import replace
from functools import lru_cache
from math import isfinite
from pathlib import Path

from podcast_mcp.engines.ffmpeg import LATE_MPEG_AUDIO_MESSAGE, AudioProbe, FFmpegEngine
from podcast_mcp.util.coded_error import CodedValueError
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


def _is_riff_wave(path: Path) -> bool:
    try:
        with path.open("rb") as stream:
            head = stream.read(12)
    except OSError:
        return False
    return head[:4] in (b"RIFF", b"RF64") and head[8:12] == b"WAVE"


def audio_start_sec(path: Path) -> float:
    """How far ``path``'s first audio sample sits past its container start, from the probe cache."""
    # A WAV has no container start to lag behind, and its render path must not spawn a probe.
    if _is_riff_wave(path):
        return 0.0
    info = probe_media(path)
    if info is None:
        raise CodedValueError(f"cannot probe {path.name} for its audio start", code="invalid_audio")
    if info.rebases_audio_reads:
        raise CodedValueError(LATE_MPEG_AUDIO_MESSAGE, code="invalid_audio")
    return info.audio_start_sec


def has_several_audio_streams(path: Path) -> bool:
    """True when ``path`` holds more than one audio stream; unprobeable media holds none."""
    info = probe_media(path)
    return info is not None and info.audio_stream_count > 1


def probe_first_audio_duration_sec(path: Path) -> float | None:
    """Declared first-audio extent, refusing unknown, estimated or multistream media.

    No container duration substitutes for the selected audio's declared extent.
    This check does not certify continuous or decodable PCM throughout the file.
    """
    info = probe_media(path)
    if info is None or info.duration_estimated or info.audio_stream_count != 1:
        return None
    duration = info.audio_duration_sec
    return duration if duration is not None and isfinite(duration) and duration > 0 else None
