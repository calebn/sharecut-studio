"""Build the project a ``contracts/*.json`` trim case describes.

``contracts/ripple-scope.json`` and ``contracts/trim-edge-limits.json`` share one
shape: ``tracks`` (``media_path`` defaults to ``raw/<id>.wav``), ``sources``, and
clip rows ``[id, timeline_start, source_start, source_end]`` with an optional
``source_id`` after the id in the trim-limits contract. The Vitest suites build
the same project in ``gui/web/src/test/contractProject.ts``.
"""

from __future__ import annotations

from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
)


def contract_project(
    tracks: list[dict], sources: list[dict] | None = None, clips: list[Clip] | None = None
) -> EpisodeProject:
    p = EpisodeProject.create("contract", "/tmp/contract")
    p.timeline.tracks = [
        Track(
            id=t["id"],
            label=t["id"],
            role=TrackRole(t["role"]),
            muted=t.get("muted", False),
            media=MediaAsset(
                path=t.get("media_path", f"raw/{t['id']}.wav"), duration_sec=t.get("duration_sec")
            ),
        )
        for t in tracks
    ]
    p.sources = [
        SourceRecording(id=s["id"], path=s["path"], duration_sec=s["duration_sec"])
        for s in sources or []
    ]
    p.timeline.clips = clips or []
    return p
