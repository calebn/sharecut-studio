from __future__ import annotations

from typing import Any

SUPPORTED_PROJECT_VERSION = "2.0"


def require_v2_document(data: dict[str, Any]) -> None:
    version = data.get("version")
    if version != SUPPORTED_PROJECT_VERSION:
        raise ValueError(
            f"Unsupported episode.project.json version {version!r}; "
            f"expected {SUPPORTED_PROJECT_VERSION!r}."
        )
    if "meta" not in data or "timeline" not in data:
        raise ValueError(
            "Invalid episode.project.json: missing required v2 sections (meta, timeline)."
        )


def snapshot_editable_state(project: Any) -> dict[str, Any]:
    """Extract undo/redo snapshot payload from EpisodeProject."""
    meta: dict[str, Any] | None = None
    if project.meta.ingest_alignment is not None:
        meta = {
            "ingest_alignment": {
                k: v.model_dump() if hasattr(v, "model_dump") else v
                for k, v in project.meta.ingest_alignment.items()
            }
        }
    return {
        "sources": [s.model_dump() for s in project.sources],
        "timeline": project.timeline.model_dump(),
        "editorial": project.editorial.model_dump(),
        "transcripts": project.transcript_data.model_dump(),
        "mix": project.mix.model_dump(),
        "social": project.social.model_dump(),
        "review": project.review.model_dump(),
        "render_last_completed_step": project.render.last_completed_step,
        "meta": meta,
    }


def apply_editable_snapshot(project: Any, snap: dict[str, Any]) -> None:
    from podcast_mcp.models.episode import (
        EditorialSection,
        MixSection,
        ReviewSection,
        SocialSection,
        SourceRecording,
        TimelineSection,
        TranscriptsSection,
    )

    project.sources = [SourceRecording.model_validate(s) for s in snap.get("sources", [])]
    project.timeline = TimelineSection.model_validate(snap["timeline"])
    project.editorial = EditorialSection.model_validate(snap["editorial"])
    project.transcript_data = TranscriptsSection.model_validate(snap["transcripts"])
    project.mix = MixSection.model_validate(snap["mix"])
    project.social = SocialSection.model_validate(snap["social"])
    project.review = ReviewSection.model_validate(snap.get("review") or {"comments": []})
    project.render.last_completed_step = snap.get("render_last_completed_step")
    meta = snap.get("meta")
    if meta and "ingest_alignment" in meta:
        from podcast_mcp.models.episode import SpeakerIngestAlignment

        project.meta.ingest_alignment = {
            k: SpeakerIngestAlignment.model_validate(v) for k, v in meta["ingest_alignment"].items()
        }
