from __future__ import annotations

import hashlib
import json
from typing import Any

from podcast_mcp.edits.mute_regions import mute_regions_payload
from podcast_mcp.engines.play_audit import track_render_hash
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.tracks import dialogue_track_ids


def audio_state_fingerprint(project: EpisodeProject) -> str:
    """Hash of all audio-affecting state across dialogue tracks."""
    parts: list[str] = []
    for tid in sorted(dialogue_track_ids(project)):
        parts.append(track_render_hash(project, tid))
        track = project.track_by_id(tid)
        if track:
            for clip in sorted(
                (c for c in project.clips if c.track_id == tid),
                key=lambda c: c.id,
            ):
                parts.append(
                    json.dumps(
                        {
                            "fade_in_ms": clip.fade_in_ms,
                            "fade_out_ms": clip.fade_out_ms,
                            "mute_regions": mute_regions_payload(clip.mute_regions),
                        },
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                )
    for env in sorted(project.automation_envelopes, key=lambda e: e.track_id):
        parts.append(json.dumps(env.model_dump(), sort_keys=True, separators=(",", ":")))
    raw = "|".join(parts)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def reconciliation_is_stale(project: EpisodeProject) -> bool:
    if project.reconciliation_stale:
        return True
    fp = audio_state_fingerprint(project)
    stored = project.last_reconciliation_hash
    if stored is None:
        return True
    return fp != stored


def reconciliation_status(project: EpisodeProject) -> dict[str, Any]:
    fp = audio_state_fingerprint(project)
    stale = reconciliation_is_stale(project)
    return {
        "stale": stale,
        "fingerprint": fp,
        "last_reconciliation_hash": project.last_reconciliation_hash,
        "reconciliation_stale_flag": project.reconciliation_stale,
    }


def mark_reconciliation_stale(project: EpisodeProject) -> None:
    project.reconciliation_stale = True


def mark_reconciliation_fresh(project: EpisodeProject) -> None:
    project.last_reconciliation_hash = audio_state_fingerprint(project)
    project.reconciliation_stale = False
