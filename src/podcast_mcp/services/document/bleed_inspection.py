from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Literal, TypedDict

from pydantic import BaseModel

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.bleed_restore_targets import (
    BleedRegionKind,
    BleedRestoreChangedError,
    BleedRestoreTarget,
    late_source_regions,
    merged_restore_choice,
    region_fragments,
    selected_occurrence,
    state_digest,
)
from podcast_mcp.engines.bleed_gate import bleed_gate_payload, build_bleed_gate_plan
from podcast_mcp.engines.play_audit import RenderDependencies, stem_is_fresh
from podcast_mcp.engines.session_timeline import shift_at
from podcast_mcp.engines.timeline_render import resolve_clip_audio_path
from podcast_mcp.models import Clip, EpisodeProject, Track
from podcast_mcp.models.episode import RangeInterval, SourceSpan
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.project_state import FileRevision, file_revision
from podcast_mcp.util.tracks import stem_path


class BleedRegion(BaseModel):
    model_config = {"extra": "forbid"}

    kind: BleedRegionKind
    actual_source: SourceSpan
    source: SourceSpan
    timeline: RangeInterval
    restore_state: Literal["available", "saved", "unavailable"]
    target: BleedRestoreTarget | None = None


class ClipBleedInspection(BaseModel):
    model_config = {"extra": "forbid"}

    clip_id: str
    track_id: str
    plan_state: Literal["disabled", "ready", "unavailable_evidence"]
    artifact_state: Literal["missing", "stale", "current"]
    restore_state: Literal["none", "current", "changed_content", "unverified"]
    reasons: list[str]
    fade_sec: float | None
    reduction: Literal["mute", "attenuate"] | None
    attenuation_db: float | None
    saved_source_regions: list[SourceSpan]
    regions: list[BleedRegion]


class BleedRestoreResult(TypedDict):
    clip_id: str
    track_id: str
    history_head_id: str


def _content(path: Path) -> tuple[str, FileRevision]:
    before = file_revision(path)
    digest = sha256_file(path)
    if file_revision(path) != before:
        raise BleedRestoreChangedError("The recording changed. Inspect the clip again.")
    return digest, before


def _gate_state(project: EpisodeProject, track_id: str, defaults: EffectiveConfig) -> dict:
    payload = bleed_gate_payload(project, track_id, defaults=defaults)
    return {
        "gate": payload,
        "lanes": [
            lane.model_dump(mode="json")
            for item in payload.get("inputs", [])
            if (lane := project.track_by_id(item["track_id"])) is not None
        ],
    }


def _media_seal(
    project: EpisodeProject, track: Track, clip: Clip, path: Path, revision: FileRevision
) -> str:
    selected = project.source_by_id(clip.source_id) if clip.source_id else track.media
    assert selected is not None
    return state_digest(
        {"reference": selected.model_dump(mode="json"), "path": str(path), "revision": revision}
    )


def _inspect_locked(
    project: EpisodeProject, clip_id: str, track_id: str, defaults: EffectiveConfig
) -> ClipBleedInspection:
    clip, occurrence_kind = selected_occurrence(project, clip_id, track_id)
    track = project.track_by_id(track_id)
    assert track is not None
    opening_head = project.history.head_id()
    opening_clip = clip.model_dump(mode="json")
    payload = _gate_state(project, track_id, defaults)
    payload_digest = state_digest(payload)
    dependencies: RenderDependencies | None = None
    path: Path | None = None
    sha: str | None = None
    revision: FileRevision | None = None
    media_seal: str | None = None
    try:
        path = resolve_clip_audio_path(project, track, clip).resolve()
        dependencies = RenderDependencies.capture(project, track_id, (path,), defaults=defaults)
        sha, revision = _content(path)
        media_seal = _media_seal(project, track, clip, path, revision)
    except BleedRestoreChangedError:
        raise
    except (OSError, ValueError):
        sha = None
    plan = (
        build_bleed_gate_plan(project, track_id, defaults=defaults)
        if track.transcript_gate
        else None
    )
    plan_state: Literal["disabled", "ready", "unavailable_evidence"] = "disabled"
    if plan is not None:
        plan_state = (
            "unavailable_evidence"
            if any(
                reason.startswith(("unavailable_", "unsupported_"))
                or reason == "missing_transcript"
                for reason in plan.reasons
            )
            else "ready"
        )
    restore = clip.bleed_restore
    restore_state: Literal["none", "current", "changed_content", "unverified"] = "none"
    saved: list[SourceSpan] = []
    if restore is not None:
        restore_state = (
            "unverified"
            if sha is None
            else "current"
            if sha == restore.source_sha256
            else "changed_content"
        )
        if restore_state == "current":
            saved = restore.regions
    dependencies_digest = state_digest(
        {
            "gate": payload,
            "render": dependencies.fingerprint if dependencies else None,
            "media": [(str(p), rev) for p, rev in dependencies.media] if dependencies else [],
        }
    )
    candidates: list[tuple[BleedRegionKind, SourceSpan, str, bool]] = []
    if plan is not None and plan.floor_gain < 1.0:
        plan_digest = state_digest(asdict(plan))
        candidates.extend(
            ("late_gate", region, plan_digest, plan_state == "ready")
            for region in late_source_regions(clip, plan.attenuation_spans)
        )
    authored_digest = state_digest(
        [region.model_dump(mode="json") for region in clip.off_speaker_mute_regions]
    )
    candidates.extend(
        ("bleed_mute:off_speaker", region, authored_digest, True)
        for region in clip.off_speaker_mute_regions
    )
    regions: list[BleedRegion] = []
    for kind, actual, plan_digest, eligible in candidates:
        covered, available = region_fragments(clip, actual, saved)
        for source, is_saved in sorted(
            [(source, True) for source in covered] + [(source, False) for source in available],
            key=lambda item: item[0].start_s,
        ):
            target = None
            if not is_saved and eligible and sha and media_seal and dependencies is not None:
                target = BleedRestoreTarget(
                    track_id=track_id,
                    occurrence_kind=occurrence_kind,
                    clip=clip,
                    kind=kind,
                    region=source,
                    media_seal=media_seal,
                    source_sha256=sha,
                    dependencies_digest=dependencies_digest,
                    plan_digest=plan_digest,
                    expected_head_id=opening_head,
                )
            regions.append(
                BleedRegion(
                    kind=kind,
                    actual_source=SourceSpan(start_s=actual.start_s, end_s=actual.end_s),
                    source=source,
                    timeline=RangeInterval(
                        start=source.start_s + shift_at(clip, source.start_s),
                        end=source.end_s + shift_at(clip, source.end_s - 1e-6),
                    ),
                    restore_state="saved" if is_saved else "available" if target else "unavailable",
                    target=target,
                )
            )
    artifact_state: Literal["missing", "stale", "current"] = "missing"
    if stem_path(project, track_id).is_file():
        artifact_state = (
            "current" if stem_is_fresh(project, track_id, defaults=defaults) else "stale"
        )
    current_clip, current_kind = selected_occurrence(project, clip_id, track_id)
    if (
        current_clip.model_dump(mode="json") != opening_clip
        or current_kind != occurrence_kind
        or project.history.head_id() != opening_head
        or state_digest(_gate_state(project, track_id, defaults)) != payload_digest
    ):
        raise BleedRestoreChangedError("The selected audio changed. Inspect the clip again.")
    if path is not None and revision is not None:
        try:
            current_path = resolve_clip_audio_path(project, track, current_clip).resolve()
            if (
                current_path != path
                or file_revision(path) != revision
                or _media_seal(project, track, current_clip, path, revision) != media_seal
            ):
                raise BleedRestoreChangedError("The recording changed. Inspect the clip again.")
        except OSError as exc:
            raise BleedRestoreChangedError(
                "The recording changed. Inspect the clip again."
            ) from exc
    if dependencies is not None:
        try:
            dependencies.validate(project, track_id, defaults=defaults)
        except ValueError as exc:
            raise BleedRestoreChangedError(
                "The selected audio changed. Inspect the clip again."
            ) from exc
    return ClipBleedInspection(
        clip_id=clip_id,
        track_id=track_id,
        plan_state=plan_state,
        artifact_state=artifact_state,
        restore_state=restore_state,
        reasons=list(plan.reasons) if plan else [],
        fade_sec=plan.fade_sec if plan else None,
        reduction=plan.reduction if plan else None,
        attenuation_db=plan.attenuation_db if plan else None,
        saved_source_regions=[span.model_copy(deep=True) for span in restore.regions]
        if restore
        else [],
        regions=regions,
    )


def inspect_clip_bleed(ws: ProjectWorkspace, clip_id: str, *, track_id: str) -> ClipBleedInspection:
    with ws.transaction() as project:
        return _inspect_locked(project, clip_id, track_id, ws.effective_config())


def restore_clip_bleed(ws: ProjectWorkspace, target: BleedRestoreTarget) -> BleedRestoreResult:
    if not isinstance(target, BleedRestoreTarget):
        raise BleedRestoreChangedError("Inspect the clip again before restoring audio.")
    with ws.transaction() as project:
        if project.history.head_id() != target.expected_head_id:
            raise BleedRestoreChangedError("The project changed. Inspect the clip again.")
        inspection = _inspect_locked(
            project, target.clip.id, target.track_id, ws.effective_config()
        )
        if not any(region.target == target for region in inspection.regions if region.target):
            raise BleedRestoreChangedError(
                "The selected reduction changed. Inspect the clip again."
            )

        def apply(current: EpisodeProject) -> None:
            clip, occurrence_kind = selected_occurrence(current, target.clip.id, target.track_id)
            clip.bleed_restore = merged_restore_choice(clip, target.source_sha256, target.region)
            if occurrence_kind == "implicit":
                current.clips.append(clip)
            else:
                selected = next(c for c in current.clips if c.id == target.clip.id)
                selected.bleed_restore = clip.bleed_restore

        ws.mutate(
            "before restore clip bleed",
            "after restore clip bleed",
            apply,
            operation="restore_clip_bleed",
            params={"clip_id": target.clip.id, "track_id": target.track_id},
        )
        return {
            "clip_id": target.clip.id,
            "track_id": target.track_id,
            "history_head_id": project.history.head_id(),
        }
