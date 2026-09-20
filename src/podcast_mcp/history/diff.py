from __future__ import annotations

from typing import Any

from podcast_mcp.models.history import ProjectStateSnapshot


def _clip_key(clip: dict) -> str:
    return str(clip.get("id", ""))


def _diff_dicts(
    before: dict[str, Any],
    after: dict[str, Any],
) -> list[dict[str, Any]]:
    changed: list[dict[str, Any]] = []
    for key in sorted(set(before) | set(after)):
        if before.get(key) != after.get(key):
            changed.append({"field": key, "old": before.get(key), "new": after.get(key)})
    return changed


def diff_snapshots(
    before: ProjectStateSnapshot,
    after: ProjectStateSnapshot,
) -> dict[str, Any]:
    b_clips = {_clip_key(c): c for c in before.timeline.get("clips", [])}
    a_clips = {_clip_key(c): c for c in after.timeline.get("clips", [])}
    added = [a_clips[k] for k in sorted(a_clips.keys() - b_clips.keys())]
    removed = [b_clips[k] for k in sorted(b_clips.keys() - a_clips.keys())]
    changed_clips: list[dict[str, Any]] = []
    for k in sorted(b_clips.keys() & a_clips.keys()):
        fields = _diff_dicts(b_clips[k], a_clips[k])
        if fields:
            changed_clips.append({"id": k, "fields": fields})

    b_dec = {d["id"]: d for d in before.editorial.get("edit_decisions", [])}
    a_dec = {d["id"]: d for d in after.editorial.get("edit_decisions", [])}
    decisions_added = [a_dec[k] for k in sorted(a_dec.keys() - b_dec.keys())]
    decisions_removed = [b_dec[k] for k in sorted(b_dec.keys() - a_dec.keys())]

    b_log = {r["id"]: r for r in before.editorial.get("edit_log", [])}
    a_log = {r["id"]: r for r in after.editorial.get("edit_log", [])}
    edit_log_added = [a_log[k] for k in sorted(a_log.keys() - b_log.keys())]

    b_tracks = {t["id"]: t for t in before.timeline.get("tracks", [])}
    a_tracks = {t["id"]: t for t in after.timeline.get("tracks", [])}
    track_changes: list[dict[str, Any]] = []
    for tid in sorted(b_tracks.keys() & a_tracks.keys()):
        fields = _diff_dicts(b_tracks[tid], a_tracks[tid])
        if fields:
            track_changes.append({"track_id": tid, "fields": fields})

    mix_changed = before.mix != after.mix
    duration_before = before.timeline.get("duration_sec")
    duration_after = after.timeline.get("duration_sec")

    return {
        "clips": {
            "added": added,
            "removed": removed,
            "changed": changed_clips,
        },
        "edit_decisions": {
            "added": decisions_added,
            "removed": decisions_removed,
        },
        "edit_log": {"added": edit_log_added},
        "tracks": {"changed": track_changes},
        "mix_changed": mix_changed,
        "timeline_duration_sec": {
            "old": duration_before,
            "new": duration_after,
        },
        "meta_changed": before.meta != after.meta,
    }
