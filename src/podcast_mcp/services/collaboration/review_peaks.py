"""Episode loudness envelope for the guest overview strip (issue #3486).

Decodes the same frozen file ``GET /api/review/{token}/audio`` streams and caches the
512-column result next to the version (``artifacts/review/{vid}/peaks.json``). A frozen
version never changes, so the version id alone keys the cache. Numbers only: no paths,
stems or audio leave the host. Object-store-only versions give ``[]`` (no download).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import numpy as np

from podcast_mcp.engines.asr_silence import peak_envelope
from podcast_mcp.services.collaboration.review_versions import review_artifacts_dir
from podcast_mcp.services.collaboration.share import open_share_workspace
from podcast_mcp.services.collaboration.share_capabilities import CAP_PLAY, has_capability
from podcast_mcp.services.media.review_media import review_guest_audio_path
from podcast_mcp.util.atomic_json import write_json_atomic
from podcast_mcp.util.coded_error import CodedFileNotFoundError, CodedPermissionError
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


def _read_sidecar(path: Path) -> list[float] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    valid = (
        isinstance(data, list)
        and len(data) == PEAK_COUNT
        and all(isinstance(v, (int, float)) and 0.0 <= v <= 1.0 for v in data)
    )
    return [float(v) for v in data] if valid else None


def episode_peaks(project, version_id: str) -> list[float]:
    """512 peaks (0..1) of the frozen review mix, from the sidecar when present."""
    sidecar = review_artifacts_dir(project) / version_id / PEAKS_SIDECAR
    cached = _read_sidecar(sidecar)
    if cached is not None:
        return cached
    try:
        audio = review_guest_audio_path(project, version_id)
    except CodedFileNotFoundError:
        return []
    try:
        envelope, _rate = peak_envelope(audio)
    except (NoAudioDecodedError, OSError, ValueError):
        log.debug("review peaks: cannot decode frozen mix for %s", version_id)
        return []
    peaks = bin_peaks(envelope)
    if peaks:
        try:
            write_json_atomic(sidecar, peaks, compact=True)
        except OSError:
            log.warning("review peaks: cannot write sidecar for %s", version_id, exc_info=True)
    return peaks


def share_review_peaks(token: str) -> list[float]:
    """Peaks for the share's review version; needs the play capability like ``/audio``."""
    row, ws = open_share_workspace(token)
    if not has_capability(row.get("capabilities"), CAP_PLAY):
        raise CodedPermissionError(
            "share does not allow playback", code="share_capability_required"
        )
    return episode_peaks(ws.project, str(row["review_version_id"]))
