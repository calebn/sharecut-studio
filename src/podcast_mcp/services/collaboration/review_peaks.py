"""Episode loudness envelope for the guest overview strip (issue #3486).

Decodes the same frozen file ``GET /api/review/{token}/audio`` streams and caches the
512-column result next to the version (``artifacts/review/{vid}/peaks.json``). A frozen
version never changes, so the version id alone keys the cache. Numbers only: no paths,
stems or audio leave the host. Object-store-only versions give ``[]`` (no download).
A silent mix is cached as ``[]``; a decode error is not (it may pass), so it is retried.
"""

from __future__ import annotations

import json
import logging
import threading
import weakref
from pathlib import Path

import numpy as np

from podcast_mcp.engines.asr_silence import peak_envelope
from podcast_mcp.services.collaboration.review_versions import get_version, review_artifacts_dir
from podcast_mcp.services.collaboration.share import open_share_workspace
from podcast_mcp.services.collaboration.share_capabilities import CAP_PLAY, has_capability
from podcast_mcp.services.media.review_media import review_guest_audio_path
from podcast_mcp.util.atomic_json import write_json_atomic
from podcast_mcp.util.coded_error import (
    CodedFileNotFoundError,
    CodedKeyError,
    CodedPermissionError,
    CodedValueError,
)
from podcast_mcp.util.pcm_stream import NoAudioDecodedError

log = logging.getLogger(__name__)

PEAK_COUNT = 512
PEAKS_SIDECAR = "peaks.json"


def bin_peaks(envelope: np.ndarray, count: int = PEAK_COUNT) -> list[float]:
    """Max-pool ``envelope`` into ``count`` columns, scale so the loudest is 1, round to 2 dp.

    ``[]`` for an empty or silent envelope.
    """
    n = int(envelope.size)
    if n == 0:
        return []
    starts = (np.arange(count) * n) // count
    stops = np.maximum(((np.arange(count) + 1) * n) // count, starts + 1)
    cols = np.array([envelope[a:b].max() for a, b in zip(starts, stops, strict=True)])
    top = float(cols.max())
    if not np.isfinite(top) or top <= 0.0:
        return []
    return [round(float(v), 2) for v in np.clip(cols / top, 0.0, 1.0)]


_LOCKS: weakref.WeakValueDictionary[str, threading.Lock] = weakref.WeakValueDictionary()
_LOCKS_GUARD = threading.Lock()


def _flight_lock(sidecar: Path) -> threading.Lock:
    """One lock per sidecar path so concurrent first requests decode once."""
    key = str(sidecar)
    with _LOCKS_GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = _LOCKS[key] = threading.Lock()
        return lock


def _read_sidecar(path: Path) -> list[float] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if data == []:
        return []
    valid = (
        isinstance(data, list)
        and len(data) == PEAK_COUNT
        and all(
            isinstance(v, (int, float)) and not isinstance(v, bool) and 0.0 <= v <= 1.0
            for v in data
        )
    )
    return [float(v) for v in data] if valid else None


def episode_peaks(project, version_id: str) -> list[float]:
    """512 peaks (0..1) of the frozen review mix, from the sidecar when present.

    ``[]`` for an unknown version, a missing local file, a silent mix (cached) or a
    decode error (not cached).
    """
    try:
        get_version(project, version_id)
        audio = review_guest_audio_path(project, version_id)
    except (CodedKeyError, CodedValueError, CodedFileNotFoundError, KeyError, ValueError):
        return []
    sidecar = review_artifacts_dir(project) / version_id / PEAKS_SIDECAR
    cached = _read_sidecar(sidecar)
    if cached is not None:
        return cached
    with _flight_lock(sidecar):
        cached = _read_sidecar(sidecar)
        if cached is not None:
            return cached
        try:
            envelope, _rate = peak_envelope(audio)
        except (NoAudioDecodedError, OSError, ValueError):
            log.warning("review peaks: cannot decode frozen mix for %s", version_id, exc_info=True)
            return []
        peaks = bin_peaks(envelope)
        try:
            write_json_atomic(sidecar, peaks, compact=True)
        except OSError:
            log.warning("review peaks: cannot write sidecar for %s", version_id, exc_info=True)
        return peaks


def review_peaks_target(token: str, version_id: str | None = None):
    """Authorize a peaks read: the play capability, and a matching version when one is asked.

    Returns ``(project, version_id)``. Checked before any rate bucket or audio slot is
    taken, as ``/audio`` does.
    """
    row, ws = open_share_workspace(token)
    if not has_capability(row.get("capabilities"), CAP_PLAY):
        raise CodedPermissionError(
            "share does not allow playback", code="share_capability_required"
        )
    resolved = str(row["review_version_id"])
    if version_id is not None and version_id != resolved:
        raise CodedKeyError("this link does not play that version", code="review_version_mismatch")
    return ws.project, resolved


def share_review_peaks(token: str, version_id: str | None = None) -> list[float]:
    """Peaks for the share's review version; needs the play capability like ``/audio``."""
    project, vid = review_peaks_target(token, version_id)
    return episode_peaks(project, vid)
