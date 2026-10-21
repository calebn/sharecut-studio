"""The copy lag between two dialogue mics, as the audibility verdicts measure it (#1052, #1073).

A remote participant's own track can trail their voice on an in-room mic. A rule that asks
whether a peer is speaking where a track sounds must read the peer that much later, or it
sees the peer's silence and misses the voice that is on the mic.
"""

from __future__ import annotations

import threading

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.engines.audio_audit import TrackRmsCacheSet, build_reconciliation_caches
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.project_state import snapshot_project


class PeerCopyLags:
    """``TrackRmsCacheSet.path_lag_sec`` over a project, decoded and measured on first use.

    Safe to share across the threads that gather candidates: the decode happens once.
    The project is copied when this is made, on the caller's thread: a candidate worker
    inside a mutation then builds from that copy without the project lock the mutating
    thread holds (#1471).
    """

    def __init__(self, project: EpisodeProject) -> None:
        self._project = snapshot_project(project)
        self._caches: TrackRmsCacheSet | None = None
        self._lock = threading.Lock()

    def sec(self, source_track_id: str, bleed_track_id: str, *, defaults: EffectiveConfig) -> float:
        """How far ``source_track_id``'s own track trails its copy on ``bleed_track_id``'s mic."""
        with self._lock:
            if self._caches is None:
                self._caches = build_reconciliation_caches(
                    self._project, private_copy=True, defaults=defaults
                )
            return self._caches.path_lag_sec(source_track_id, bleed_track_id)
