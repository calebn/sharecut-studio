from __future__ import annotations

from collections.abc import Callable
from typing import Any

from podcast_mcp.util.coded_error import CodedValueError

SUPPORTED_PROJECT_VERSION = "2.1"

Step = Callable[[dict[str, Any]], None]


def _add_timeline_join_fade_limit(data: dict[str, Any]) -> None:
    """2.0 to 2.1: ``timeline.join_fade_max_ms`` is new and absent means the app default."""


# One entry per released format: the version it moves to, and the edit that moves a document
# there. Shared by `podcast episode upgrade` and the in-memory migration in `load_project`.
STEPS: dict[str, tuple[str, Step]] = {"2.0": ("2.1", _add_timeline_join_fade_limit)}


class ProjectVersionNewerError(CodedValueError):
    code = "project_version_newer"


class ProjectVersionUnsupportedError(CodedValueError):
    code = "project_version_unsupported"


def _version_key(version: object) -> tuple[int, ...] | None:
    if not isinstance(version, str):
        return None
    parts = version.split(".")
    if not all(part.isascii() and part.isdigit() for part in parts):
        return None
    return tuple(int(part) for part in parts)


def migrate_document(data: dict[str, Any]) -> str:
    """Move a known older *data* document to the supported version in place.

    Returns the version it had. A document already at the supported version is unchanged.
    A newer or unknown version raises a coded refusal that says what to do.
    """
    original = data.get("version")
    version = original
    while version != SUPPORTED_PROJECT_VERSION:
        if not isinstance(version, str) or version not in STEPS:
            raise _unsupported_version(original)
        version, step = STEPS[version]
        step(data)
        data["version"] = version
    return str(original)


def _unsupported_version(version: object) -> CodedValueError:
    found, current = _version_key(version), _version_key(SUPPORTED_PROJECT_VERSION)
    if found is not None and current is not None and found > current:
        return ProjectVersionNewerError(
            f"This episode was saved by a newer version of ShareCut Studio "
            f"(project format {version}). Update the app, then open it again."
        )
    shown = f" ({version})" if isinstance(version, str) and found is not None else ""
    return ProjectVersionUnsupportedError(
        f"This episode was saved in a project format{shown} that this version of ShareCut Studio "
        "can't open. Open it with the version that saved it, or restore a backup."
    )


def require_v2_document(data: dict[str, Any]) -> None:
    """Bring *data* to the supported version in memory; the file on disk is not touched."""
    migrate_document(data)
    if "meta" not in data or "timeline" not in data:
        raise ValueError("Invalid project file: missing required v2 sections (meta, timeline).")


def snapshot_editable_state(project: Any) -> dict[str, Any]:
    """Extract undo/redo snapshot payload from EpisodeProject."""
    meta: dict[str, Any] = {"name": project.meta.name}
    if project.meta.ingest_alignment is not None:
        meta["ingest_alignment"] = {
            k: v.model_dump() if hasattr(v, "model_dump") else v
            for k, v in project.meta.ingest_alignment.items()
        }
    return {
        "sources": [s.model_dump() for s in project.sources],
        "timeline": project.timeline.model_dump(),
        "editorial": project.editorial.model_dump(),
        "transcripts": project.transcript_data.model_dump(),
        "mix": project.mix.model_dump(),
        "social": project.social.model_dump(),
        "feed": project.feed.model_dump(mode="json"),
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
    from podcast_mcp.models.feed import FeedSection

    project.sources = [SourceRecording.model_validate(s) for s in snap.get("sources", [])]
    project.timeline = TimelineSection.model_validate(snap["timeline"])
    project.editorial = EditorialSection.model_validate(snap["editorial"])
    project.transcript_data = TranscriptsSection.model_validate(snap["transcripts"])
    project.mix = MixSection.model_validate(snap["mix"])
    project.social = SocialSection.model_validate(snap["social"])
    restored = FeedSection.model_validate(snap.get("feed") or {})
    # The guid and first export time are made once: going back in history never takes them away.
    kept = getattr(project, "feed", None)
    if kept is not None:
        restored.guid = kept.guid or restored.guid
        restored.first_exported_at = kept.first_exported_at or restored.first_exported_at
    project.feed = restored
    project.review = ReviewSection.model_validate(snap.get("review") or {"comments": []})
    project.render.last_completed_step = snap.get("render_last_completed_step")
    meta = snap.get("meta")
    if meta and "name" in meta:
        project.meta.name = meta["name"]
    if meta and "ingest_alignment" in meta:
        from podcast_mcp.models.episode import SpeakerIngestAlignment

        project.meta.ingest_alignment = {
            k: SpeakerIngestAlignment.model_validate(v) for k, v in meta["ingest_alignment"].items()
        }
