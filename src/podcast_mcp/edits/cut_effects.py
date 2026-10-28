"""Audio effects, pad origins and receipts a source cut carries, read from the completed candidate.

Builds on ``cut_placement``; ``cut_safety`` assesses acoustics on top of it."""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING

from podcast_mcp.edits.cut_policy import (
    CutJoin,
)
from podcast_mcp.edits.ripple import RippleRemoval, TrimPlan, ripple_track_ids
from podcast_mcp.engines.audio import GainRamp, MuteSampleEnvelope, PlacedSource, SourceAudio
from podcast_mcp.engines.session_timeline import (
    clip_plays_lane,
)
from podcast_mcp.models import (
    AppliedEditRecord,
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
)
from podcast_mcp.util.batch_scope import scoped, scoped_by_file
from podcast_mcp.util.intervals import subtract_intervals
from podcast_mcp.util.media_identity import same_recording

if TYPE_CHECKING:
    from podcast_mcp.edits.timeline_ops import PauseEdgeFade, RoomTonePad

from podcast_mcp.edits.cut_placement import (
    SOURCE_GEOMETRY_TOLERANCE_SEC,
    CutScopeHold,
    DuplicateSourceOccurrence,
)
from podcast_mcp.edits.edit_log import seam_source_by_track
from podcast_mcp.engines import ffmpeg
from podcast_mcp.engines.audio import placed_sources
from podcast_mcp.engines.clips_ops import clip_split_origin, clips_for_track
from podcast_mcp.engines.timeline_render import placed_track_audio, track_grid
from podcast_mcp.engines.track_media import full_span_clip
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.tracks import recording_audio_path


def _probe_on_miss(path: Path) -> ffmpeg.AudioProbe:
    """Probe ``path`` with a new engine; the batch scope calls this only when it has no probe yet."""
    return ffmpeg.FFmpegEngine().probe(path)


@dataclass(frozen=True)
class CutAudioEffect:
    track_id: str
    source_id: str | None
    recording: Path
    start: float
    end: float
    join: CutJoin
    contributors: frozenset[str]
    retained: bool = False
    envelope: GainRamp | MuteSampleEnvelope | None = None
    timeline_start: float = 0.0
    before: PlacedSource | None = None


def completed_audio_effects(
    before: EpisodeProject,
    candidate: EpisodeProject,
    contributors: frozenset[str],
    *,
    defaults: dict,
    contributors_by_clip: Mapping[str, frozenset[str]] | None = None,
    introduced_clips: frozenset[str] = frozenset(),
) -> tuple[CutAudioEffect, ...]:

    effects: list[CutAudioEffect] = []
    curve = str(defaults.get("render", {}).get("crossfade_curve", "tri"))
    for track in candidate.tracks:
        if track == before.track_by_id(track.id) and clips_for_track(
            before, track.id
        ) == clips_for_track(candidate, track.id):
            continue
        clip_sets = []
        for project in (before, candidate):
            clips = clips_for_track(project, track.id)
            lane = project.track_by_id(track.id)
            if (
                not clips
                and lane
                and not lane.timeline_empty
                and lane.media
                and lane.media.duration_sec
            ):
                clips = [full_span_clip(track.id, lane.media.duration_sec)]
            clip_sets.append(clips)
        old_clips, new_clips = clip_sets
        if old_clips == new_clips:
            continue
        graphs = []
        for project, clips in ((before, old_clips), (candidate, new_clips)):
            graphs.append(
                placed_sources(
                    placed_track_audio(
                        project,
                        track,
                        clips,
                        grid=track_grid(project, track, clips),
                    ).audio,
                    crossfade_curve=curve,
                )
                if clips
                else []
            )
        old, new = graphs
        bindings = _before_occurrences(old, new, introduced_clips)

        def append(
            leaf: PlacedSource,
            start: float,
            end: float,
            join: CutJoin,
            retained: bool = False,
            envelope: GainRamp | MuteSampleEnvelope | None = None,
            track_id: str = track.id,
            before_leaf: PlacedSource | None = None,
        ) -> None:
            source = leaf.source
            ids = (contributors_by_clip or {}).get(source.clip_id or "", contributors)
            effects.append(
                CutAudioEffect(
                    track_id,
                    source.source_id,
                    source.path.resolve(),
                    start,
                    end,
                    join,
                    ids,
                    retained,
                    envelope,
                    leaf.timeline_start + start - source.src_start,
                    before_leaf
                    if before_leaf is not None
                    and before_leaf.source.src_start <= start + SOURCE_GEOMETRY_TOLERANCE_SEC
                    and before_leaf.source.src_end >= end - SOURCE_GEOMETRY_TOLERANCE_SEC
                    else None,
                )
            )

        def envelopes(
            leaf: PlacedSource,
        ) -> list[tuple[float, float, CutJoin, bool, GainRamp | MuteSampleEnvelope | None]]:
            source = leaf.source
            result: list[
                tuple[float, float, CutJoin, bool, GainRamp | MuteSampleEnvelope | None]
            ] = [
                (source.src_start, source.src_start, CutJoin.SPLICE, False, None),
                (source.src_end, source.src_end, CutJoin.SPLICE, False, None),
            ]
            for ramp in leaf.ramps:
                local = replace(
                    ramp,
                    start=max(
                        source.src_start, source.src_start + ramp.start - leaf.timeline_start
                    ),
                    end=min(source.src_end, source.src_start + ramp.end - leaf.timeline_start),
                )
                result.append((local.start, local.end, CutJoin.SPLICE, True, local))
            if source.mute_spans:
                rate = scoped_by_file(
                    "complete_effect_probe",
                    source.path,
                    None,
                    partial(_probe_on_miss, source.path),
                ).sample_rate
                for mute in source.mute_spans:
                    samples = mute.samples(rate, source_start=source.src_start)
                    result.append(
                        (
                            max(source.src_start, samples.first / rate),
                            min(source.src_end, samples.last / rate),
                            CutJoin.MUTE,
                            False,
                            samples,
                        )
                    )
                    if samples.fade_out + samples.fade_in <= samples.last - samples.first:
                        for first, last in (
                            (samples.first, samples.first + samples.fade_out),
                            (samples.last - samples.fade_in, samples.last),
                        ):
                            lo, hi = (
                                max(source.src_start, first / rate),
                                min(source.src_end, last / rate),
                            )
                            if lo < hi:
                                result.append((lo, hi, CutJoin.MUTE, True, samples))
            return result

        for leaf, binding in zip(new, bindings, strict=True):
            previous = envelopes(old[binding]) if binding is not None else []
            for start, end, join, retained, envelope in envelopes(leaf):
                if not any(
                    prior_start <= start + SOURCE_GEOMETRY_TOLERANCE_SEC
                    and end <= prior_end + SOURCE_GEOMETRY_TOLERANCE_SEC
                    and (join, retained) == (prior_join, prior_retained)
                    and _same_envelope(envelope, prior_envelope)
                    for prior_start, prior_end, prior_join, prior_retained, prior_envelope in previous
                ):
                    append(
                        leaf,
                        start,
                        end,
                        join,
                        retained,
                        envelope,
                        before_leaf=old[binding] if binding is not None else None,
                    )
        for index, leaf in enumerate(old):
            surviving = [
                (n.source.src_start, n.source.src_end)
                for n, binding in zip(new, bindings, strict=True)
                if binding == index
            ]
            for start, end in subtract_intervals(
                [(leaf.source.src_start, leaf.source.src_end)], surviving
            ):
                append(leaf, start, end, CutJoin.SPLICE, before_leaf=leaf)
    return tuple(effects)


def _same_envelope(
    new: GainRamp | MuteSampleEnvelope | None, prior: GainRamp | MuteSampleEnvelope | None
) -> bool:
    """Whether two envelopes are the same, ramp times compared within the geometry tolerance.

    A ripple shifts a downstream ramp by a float subtraction that leaves ~1e-14 of drift, so
    exact equality would call every unchanged downstream ramp a new effect.
    """
    if isinstance(new, GainRamp) and isinstance(prior, GainRamp):
        return (
            new.rising == prior.rising
            and new.curve == prior.curve
            and abs(new.start - prior.start) <= SOURCE_GEOMETRY_TOLERANCE_SEC
            and abs(new.end - prior.end) <= SOURCE_GEOMETRY_TOLERANCE_SEC
        )
    return new == prior


def _same_recording_leaves(old: Sequence[PlacedSource]) -> Callable[[SourceAudio], list[int]]:
    """Indexes of the ``old`` leaves that play ``source``'s recording, ascending.

    Leaves are grouped by source id, fill flag and path, so each distinct path pair within
    a source id and fill group is compared once however many leaves play it. Paths are
    compared in order of their first leaf, so the first comparison to raise is the one an
    all-pairs scan reaches first.
    """
    by_path: dict[tuple[str | None, bool], dict[Path, list[int]]] = {}
    for index, previous in enumerate(old):
        paths = by_path.setdefault((previous.source.source_id, previous.source.is_fill), {})
        paths.setdefault(previous.source.path, []).append(index)
    found: dict[tuple[str | None, bool, Path], list[int]] = {}

    def matching(source: SourceAudio) -> list[int]:
        key = (source.source_id, source.is_fill, source.path)
        if key not in found:
            found[key] = sorted(
                index
                for path, indexes in by_path.get(key[:2], {}).items()
                if same_recording(path, source.path)
                for index in indexes
            )
        return found[key]

    return matching


def _before_occurrences(
    old: Sequence[PlacedSource],
    new: Sequence[PlacedSource],
    introduced_clips: frozenset[str],
) -> list[int | None]:
    """Bind each surviving renderer leaf without conflating repeated source plays."""

    before_ids = {leaf.source.clip_id for leaf in old}
    bindings: list[int | None] = [None] * len(new)
    same_old_recording = _same_recording_leaves(old)
    for position in sorted(range(len(new)), key=lambda i: new[i].source.is_fill):
        leaf = new[position]
        source = leaf.source
        if source.clip_id in introduced_clips:
            continue
        qualified = same_old_recording(source)
        origin = clip_split_origin(source.clip_id, before_ids)
        containing = [
            i
            for i in qualified
            if old[i].source.src_start <= source.src_start + SOURCE_GEOMETRY_TOLERANCE_SEC
            and old[i].source.src_end >= source.src_end - SOURCE_GEOMETRY_TOLERANCE_SEC
        ]
        if not containing and not source.is_fill:
            # A trim that extends a clip's edge keeps all of the clip's old audio inside the new
            # leaf; that old leaf is the one this leaf continues, not a removal.
            containing = [
                i
                for i in qualified
                if old[i].source.clip_id == source.clip_id
                and source.src_start <= old[i].source.src_start + SOURCE_GEOMETRY_TOLERANCE_SEC
                and source.src_end >= old[i].source.src_end - SOURCE_GEOMETRY_TOLERANCE_SEC
            ]
        matches = (
            [i for i in containing if old[i].source.clip_id == origin]
            if origin in before_ids
            else containing
        )
        if source.is_fill:
            parents = [
                (n, old[binding])
                for n, binding in zip(new, bindings, strict=True)
                if not n.source.is_fill
                and n.source.clip_id == source.clip_id
                and binding is not None
            ]
            matches = [
                i
                for i in matches
                if any(
                    old[i].source.clip_id == prior.source.clip_id
                    and abs(
                        old[i].timeline_start
                        - old[i].source.src_start
                        - leaf.timeline_start
                        + source.src_start
                        - prior.timeline_start
                        + prior.source.src_start
                        + parent.timeline_start
                        - parent.source.src_start
                    )
                    <= SOURCE_GEOMETRY_TOLERANCE_SEC
                    for parent, prior in parents
                )
            ]
        if len(matches) > 1:
            raise DuplicateSourceOccurrence("ambiguous BEFORE source occurrence")
        if matches:
            bindings[position] = matches[0]
    for i, binding in enumerate(bindings):
        if binding is None:
            continue
        if any(
            other_binding == binding and _replays_source(new[i], other)
            for other, other_binding in zip(new[:i], bindings[:i], strict=True)
        ):
            raise DuplicateSourceOccurrence("duplicated BEFORE source occurrence")
    return bindings


def _replays_source(a: PlacedSource, b: PlacedSource) -> bool:
    """Whether two leaves bound to one old leaf play the same source audio twice.

    Widened ranges that overlap are a replay, except between the two leaves a blending join
    itself placed together.
    """

    tolerance = SOURCE_GEOMETRY_TOLERANCE_SEC
    widened_overlap = min(a.source.src_end, b.source.src_end) - max(
        a.source.src_start, b.source.src_start
    )
    if widened_overlap <= tolerance:
        return False
    first, second = (a, b) if a.timeline_start <= b.timeline_start else (b, a)
    return not _joined_partners(first, second)


def _joined_partners(first: PlacedSource, second: PlacedSource) -> bool:
    """Whether a blending join placed `second` directly after `first` over contiguous ranges."""

    tolerance = SOURCE_GEOMETRY_TOLERANCE_SEC
    left, right = first.source, second.source
    if left.reach_out <= 0 or right.reach_in <= 0:
        return False
    if abs(left.nominal_end - right.nominal_start) > tolerance:
        return False
    overlap = left.reach_out + right.reach_in
    joined_at = first.timeline_start + (left.src_end - left.src_start) - overlap
    return abs(second.timeline_start - joined_at) <= tolerance


@dataclass(frozen=True)
class PadEffect:
    edit_id: str
    plan: RoomTonePad
    clip_ids: frozenset[str]


def native_pad_origins() -> dict[str, PadEffect]:
    """Native tile IDs and original insertion effects, retained only for this batch."""
    return scoped("cut_pad_origins", dict)


def pause_edge_clips(project: EpisodeProject, edge: PauseEdgeFade) -> list[Clip]:

    matched = []
    for clip in clips_for_track(project, edge.track_id):
        if clip.source_id != edge.source_id:
            continue
        try:
            media = recording_audio_path(project, clip.track_id, clip.source_id).resolve(
                strict=True
            )
        except (CodedError, OSError, ValueError):
            continue
        if (
            same_recording(media, edge._media)
            and abs(
                (clip.source_end if edge.side == "left" else clip.source_start) - edge.source_sec
            )
            <= 1e-6
            and abs(
                (clip.timeline_end if edge.side == "left" else clip.timeline_start)
                - edge.timeline_sec
            )
            <= 1e-6
            and clip.source_start <= edge.source_start + 1e-6
            and clip.source_end >= edge.source_end - 1e-6
        ):
            matched.append(clip)
    return matched


def _is_recorded_pad(
    clip: Clip,
    pad_origins: dict[str, PadEffect],
    written_by_edit: dict[str, AppliedEditRecord],
) -> bool:
    """A native pad clip that the edit which laid it recorded: its window and its samples."""

    origin = pad_origins.get(clip_split_origin(clip.id, set(pad_origins)) or "")
    row = written_by_edit.get(origin.edit_id) if origin is not None else None
    return (
        origin is not None
        and row is not None
        and row.timeline_start is not None
        and origin.plan.at_time >= row.timeline_start - 1e-6
        and origin.plan.at_time + origin.plan.seconds
        <= row.timeline_start + float(row.params.get("replace_gap_sec") or 0) + 1e-6
        and any(
            sample["track_id"] == clip.track_id
            and sample.get("source_id") == clip.source_id
            and clip.source_start >= sample["source_start"] - 1e-6
            and clip.source_end <= sample["source_end"] + 1e-6
            for sample in row.params.get("pad_samples", [])
        )
    )


def complete_effect_receipts(
    before: EpisodeProject,
    candidate: EpisodeProject,
    accepted: Sequence[EditDecision] = (),
    *,
    operation_ids: frozenset[str] = frozenset(),
    removal: RippleRemoval | None = None,
    trim: TrimPlan | None = None,
    clip_ids: tuple[str, ...] = (),
) -> list[CutScopeHold]:
    pad_origins = native_pad_origins()
    old = before.editorial.edit_log
    rows = candidate.editorial.edit_log
    bad: set[str] = set()
    ids = operation_ids | frozenset(edit.id for edit in accepted)
    if rows[: len(old)] != old or len({row.id for row in rows}) != len(rows):
        bad.update(ids)
    for row in rows[len(old) :]:
        if any(candidate.track_by_id(track_id) is None for track_id in row.track_ids):
            bad.update(row.decision_ids or ids)
        for lo, hi in ((row.source_start, row.source_end), (row.timeline_start, row.timeline_end)):
            if (
                lo is not None
                and hi is not None
                and (not math.isfinite(lo) or not math.isfinite(hi) or lo < 0 or hi < lo)
            ):
                bad.update(row.decision_ids or ids)
    new_rows = rows[len(old) :]
    if trim is not None:
        original = next((clip for clip in before.clips if clip.id == trim.clip_id), None)
        clipped = next((clip for clip in candidate.clips if clip.id == trim.clip_id), None)
        if original is None or clipped is None or len(new_rows) != 1:
            bad.update(ids)
        else:
            row = new_rows[0]
            if (
                (row.source_start, row.source_end, row.timeline_start, row.timeline_end)
                != (
                    clipped.source_start,
                    clipped.source_end,
                    clipped.timeline_start,
                    clipped.timeline_end,
                )
                or row.params.get("previous_source_start") != original.source_start
                or row.params.get("previous_source_end") != original.source_end
                or row.params.get("previous_timeline_start") != original.timeline_start
                or row.params.get("previous_timeline_end") != original.timeline_end
                or set(row.track_ids) != set(trim.track_ids)
                or any(
                    not any(
                        clip.id == move.clip_id
                        and clip.track_id == move.track_id
                        and abs(
                            (clip.source_start if trim.edge == "in" else clip.source_end)
                            - move.source_sec
                        )
                        <= 1e-6
                        for clip in candidate.clips
                    )
                    for move in trim.moves
                )
            ):
                bad.update(ids)
    elif removal is not None and clip_ids:
        selected = [clip for clip in before.clips if clip.id in clip_ids]
        if len(selected) != len(set(clip_ids)) or len(new_rows) != 1:
            bad.update(ids)
        else:
            row = new_rows[0]
            if row.params.get("mode") == "ripple":
                expected_spans = {
                    tid: [list(span) for span in removal.spans]
                    for tid in ripple_track_ids(before, removal.edited_track_ids)
                }
            else:
                expected_spans = {}
                for clip in sorted(selected, key=lambda c: c.timeline_start, reverse=True):
                    expected_spans.setdefault(clip.track_id, []).append(
                        [clip.timeline_start, clip.timeline_end]
                    )
            if (
                row.params.get("cut_spans") != expected_spans
                or row.params.get("clip_ids") != list(clip_ids)
                or any(clip.id in clip_ids for clip in candidate.clips)
            ):
                bad.update(ids)
    elif removal is not None:
        if {(row.timeline_start, row.timeline_end) for row in new_rows} != set(removal.spans):
            bad.update(ids)

        for row in new_rows:
            if row.timeline_start is None or row.timeline_end is None:
                bad.update(ids)
                continue
            expected = seam_source_by_track(
                {tid: clips_for_track(before, tid) for tid in row.track_ids},
                row.timeline_start,
                row.timeline_end,
            )
            if row.params.get("per_track_source") != expected:
                bad.update(ids)
    written_by_edit = {
        edit.id: written[0]
        for edit in accepted
        if len(written := [row for row in new_rows if edit.id in row.decision_ids]) == 1
    }
    for edit in accepted:
        if edit.exact_range is not None and edit.type not in (
            EditDecisionType.REMOVE,
            EditDecisionType.MUTE,
        ):
            bad.add(edit.id)
        previous = [row for row in old if edit.id in row.decision_ids]
        written = [row for row in rows[len(old) :] if edit.id in row.decision_ids]
        if previous or len(written) != 1:
            bad.add(edit.id)
            continue
        row = written[0]
        if edit.exact_range is None and (
            row.source_start != edit.start or row.source_end != edit.end
        ):
            bad.add(edit.id)
        if edit.source_timeline_span is not None and row.params.get("source_id") != edit.source_id:
            bad.add(edit.id)
        if (
            edit.type is EditDecisionType.REMOVE
            and edit.exact_range is None
            and not row.params.get("mute")
        ):
            source_ids = before.equivalent_source_ids(edit.track_id, edit.source_id)
            if any(
                clip.source_id in source_ids
                and clip_plays_lane(candidate, clip, edit.track_id)
                and min(edit.end, clip.source_end) - max(edit.start, clip.source_start) > 1e-6
                and not _is_recorded_pad(clip, pad_origins, written_by_edit)
                for clip in candidate.clips
            ):
                bad.add(edit.id)
    return [
        CutScopeHold(edit_id, (), "source_geometry", detail="source_receipt")
        for edit_id in sorted(bad)
    ]
