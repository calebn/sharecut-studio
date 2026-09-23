from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any

from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.edits.mute_regions import mute_regions_payload
from podcast_mcp.engines.timeline_render import RENDER_SEMANTICS_REV
from podcast_mcp.models import AutomationEnvelope, EpisodeProject

log = logging.getLogger(__name__)

# Stems are timeline-clock WAVs; tolerate encoder/container rounding.
STEM_DURATION_TOLERANCE_SEC = 0.25


def envelope_audio_payload(envelope: AutomationEnvelope | None) -> dict[str, Any] | None:
    """Describe audible envelope state without editorial point identities."""
    if envelope is None:
        return None
    return {
        "track_id": envelope.track_id,
        "parameter": envelope.parameter,
        "points": [{"time": point.time, "value": point.value} for point in envelope.points],
    }


def track_render_hash(project: EpisodeProject, track_id: str) -> str:
    """Fingerprint applied edits, clips, mix state for a track (stem/segment cache).

    Includes ``RENDER_SEMANTICS_REV`` so stems and play segments rendered under
    older renderer rules are treated as stale after a semantics change.
    """
    track = project.track_by_id(track_id)
    chain = next((c for c in project.processing_chains if c.track_id == track_id), None)
    env = project.volume_envelope_for(track_id)
    edits = [
        {
            "id": e.id,
            "start": e.start,
            "end": e.end,
            "type": e.type.value,
            "applied": e.applied,
        }
        for e in project.edit_decisions
        if e.track_id == track_id and e.applied
    ]
    clips = [
        {
            "source_start": c.source_start,
            "source_end": c.source_end,
            "timeline_start": c.timeline_start,
            "fade_in_ms": c.fade_in_ms,
            "fade_out_ms": c.fade_out_ms,
            "join_in_mode": c.join_in_mode.value,
            "mute_regions": mute_regions_payload(c.mute_regions),
        }
        for c in clips_for_track(project, track_id)
    ]
    payload: dict[str, Any] = {
        "render_rev": RENDER_SEMANTICS_REV,
        "track_id": track_id,
        "gain_db": track.gain_db if track else 0.0,
        "muted": track.muted if track else False,
        "transcript_gate": bool(track.transcript_gate) if track else False,
        "edits": edits,
        "clips": clips,
        "chain": chain.model_dump() if chain else None,
        "envelope": envelope_audio_payload(env),
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def proxy_render_hash(project: EpisodeProject, track_id: str) -> str:
    """16-hex fingerprint of FX source-clock render inputs.

    Includes: source media identity (path name, size, mtime_ns),
    processing chain, transcript_gate + suppressed-word state.
    Excludes: clips, edit decisions, envelope, gain_db, muted.
    """
    from podcast_mcp.util.tracks import track_audio_path

    track = project.track_by_id(track_id)
    chain = next((c for c in project.processing_chains if c.track_id == track_id), None)
    media_identity: dict[str, Any] | None = None
    try:
        src = track_audio_path(project, track_id)
        if src.is_file():
            st = src.stat()
            media_identity = {
                "name": src.name,
                "size": st.st_size,
                "mtime_ns": st.st_mtime_ns,
            }
        else:
            media_identity = {"name": src.name, "size": None, "mtime_ns": None}
    except ValueError:
        media_identity = None
    tr = project.transcript_for_track(track_id)
    suppressed = (
        [
            {"i": i, "s": round(w.start, 4), "e": round(w.end, 4)}
            for i, w in enumerate(tr.words)
            if w.suppressed
        ]
        if tr
        else []
    )
    payload: dict[str, Any] = {
        "track_id": track_id,
        "media": media_identity,
        "transcript_gate": bool(track.transcript_gate) if track else False,
        "chain": chain.model_dump() if chain else None,
        "suppressed": suppressed,
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def stem_path(project: EpisodeProject, track_id: str) -> Path:
    return project.artifacts_dir() / "tracks" / f"{track_id}.wav"


def stem_hash_path(project: EpisodeProject, track_id: str) -> Path:
    return project.artifacts_dir() / "tracks" / f"{track_id}.hash"


def read_stem_hash(project: EpisodeProject, track_id: str) -> str | None:
    path = stem_hash_path(project, track_id)
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8").strip()


def write_stem_hash(
    project: EpisodeProject,
    track_id: str,
    *,
    clear_invalidations: bool = True,
) -> str:
    """Persist stem content hash; optionally clear diagnostic invalidations.

    When rendering stems in parallel, pass ``clear_invalidations=False`` and
    clear on the main thread after ``run_parallel`` so the cause journal is
    not mutated concurrently.
    """
    h = track_render_hash(project, track_id)
    path = stem_hash_path(project, track_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(h + "\n", encoding="utf-8")
    if clear_invalidations:
        from podcast_mcp.engines.render_invalidations import (
            clear_invalidations_for_tracks,
        )

        clear_invalidations_for_tracks(project, [track_id])
    return h


def expected_stem_duration_sec(project: EpisodeProject, track_id: str) -> float | None:
    """Timeline end of the last placed clip (stem length when assemble is correct)."""
    from podcast_mcp.engines.session_timeline import SessionTimeline

    extent = SessionTimeline(project).timeline_extent(track_id)
    if extent is None:
        return None
    return float(extent[0])


def probe_stem_duration_sec(project: EpisodeProject, track_id: str) -> float | None:
    stem = stem_path(project, track_id)
    if not stem.is_file():
        return None
    try:
        from podcast_mcp.engines.ffmpeg import FFmpegEngine

        return float(FFmpegEngine().probe(stem).duration_sec)
    except Exception as exc:
        log.debug("stem probe failed for %s: %s", track_id, exc)
        return None


def stem_duration_matches_timeline(
    project: EpisodeProject,
    track_id: str,
    *,
    tolerance_sec: float = STEM_DURATION_TOLERANCE_SEC,
) -> bool:
    """True when stem is not longer than the session timeline (wrong timebase).

    Applied edit decisions can shorten a stem before clips are rewritten, so a
    shorter stem is allowed. A stem *longer* than ``timeline_extent`` is the
    classic source-length / wrong-clock failure mode.
    """
    expected = expected_stem_duration_sec(project, track_id)
    if expected is None:
        return True
    actual = probe_stem_duration_sec(project, track_id)
    if actual is None:
        return False
    return actual <= expected + tolerance_sec


def stem_is_fresh(project: EpisodeProject, track_id: str) -> bool:
    """Hash matches current edit state and stem is not longer than timeline."""
    stem = stem_path(project, track_id)
    if not stem.is_file():
        return False
    stored = read_stem_hash(project, track_id)
    if stored != track_render_hash(project, track_id):
        return False
    return stem_duration_matches_timeline(project, track_id)


def invalidate_stem_hashes(project: EpisodeProject) -> list[str]:
    """Delete stem hash sidecars so play falls back to segment render after history nav.

    Leaves stem WAVs in place (cheap to ignore when stale). Returns track ids cleared.
    """
    from podcast_mcp.util.tracks import dialogue_track_ids

    cleared: list[str] = []
    for tid in dialogue_track_ids(project):
        path = stem_hash_path(project, tid)
        if path.is_file():
            path.unlink(missing_ok=True)
            cleared.append(tid)
    return cleared
