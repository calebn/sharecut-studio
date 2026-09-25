from __future__ import annotations

from podcast_mcp.engines.play_audit import (
    expected_stem_duration_sec,
    premix_path,
    premix_stale_vs_mix,
    premix_stale_vs_stems,
    probe_stem_duration_sec,
    read_stem_hash,
    stem_duration_matches_timeline,
    stem_is_fresh,
    stem_path,
    track_render_hash,
)
from podcast_mcp.engines.reconciliation_state import reconciliation_status
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.tracks import dialogue_track_ids


def render_status_report(project: EpisodeProject) -> dict:
    tracks: dict[str, dict] = {}
    # Muted tracks too: the pipeline renders their stems, and an unmute plays them.
    for tid in dialogue_track_ids(project):
        stem = stem_path(project, tid)
        exists = stem.is_file()
        expected = expected_stem_duration_sec(project, tid) if exists else None
        actual = probe_stem_duration_sec(project, tid) if exists else None
        duration_ok = stem_duration_matches_timeline(project, tid) if exists else False
        fresh = stem_is_fresh(project, tid) if exists else False
        entry = {
            "stem_path": str(stem) if exists else None,
            "stem_exists": exists,
            "stem_is_fresh": fresh,
            "render_hash": track_render_hash(project, tid),
            "stored_hash": read_stem_hash(project, tid),
            "expected_duration_sec": expected,
            "stem_duration_sec": actual,
            "duration_mismatch": exists and not duration_ok,
        }
        tracks[tid] = entry

    premix = premix_path(project)
    premix_info: dict = {
        "path": str(premix) if premix.is_file() else None,
        "exists": premix.is_file(),
        "stale_vs_stems": premix_stale_vs_stems(project),
        # Fader, mute or staging gain changed since the premix was mixed.
        "stale_vs_mix": premix_stale_vs_mix(project),
    }
    if premix.is_file():
        premix_info["mtime_sec"] = premix.stat().st_mtime
        premix_info["size_bytes"] = premix.stat().st_size

    reconciliation = reconciliation_status(project)
    any_stale_stem = any(
        t.get("stem_exists") and not t.get("stem_is_fresh") for t in tracks.values()
    )
    from podcast_mcp.engines.render_invalidations import invalidations_as_dicts

    return {
        "tracks": tracks,
        "premix": premix_info,
        "reconciliation": reconciliation,
        "invalidations": invalidations_as_dicts(project),
        "needs_rerender": (
            any_stale_stem
            or not premix.is_file()
            or bool(premix_info.get("stale_vs_stems"))
            or bool(premix_info.get("stale_vs_mix"))
        ),
    }
