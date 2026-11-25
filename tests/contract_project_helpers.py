"""Build the project a ``contracts/*.json`` trim case describes.

``contracts/ripple-scope.json`` and ``contracts/trim-edge-limits.json`` share one
shape: ``tracks`` (``media_path`` defaults to ``raw/<id>.wav``), ``sources``, and
clip rows ``[id, timeline_start, source_start, source_end, source_id?, steps?]``
(4 to 6 wide): ``source_id`` is used by the trim and roll limit contracts and
``steps`` (``[[at, delta_sec], ...]``, see ``contract_timing``) by those two as
well. The Vitest suites build the same project in
``gui/web/src/test/contractProject.ts``.
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
from podcast_mcp.models.clip_timing import ClipTiming, QuietSpan, TimingStep


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


def contract_timing(steps: list[list[float]] | None) -> ClipTiming | None:
    """A clip's timing map from contract ``[at, delta_sec]`` rows (None = untimed).

    A skip (``delta_sec < 0``) needs the quiet span the server requires; the contract
    carries none, so one is made that ends 1 s after the skip.
    """
    if steps is None:
        return None
    return ClipTiming(
        steps=[
            TimingStep(
                at=at,
                delta_sec=delta,
                quiet=QuietSpan(start_s=at, end_s=at - delta) if delta < 0 else None,
            )
            for at, delta in steps
        ]
    )
