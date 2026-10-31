"""Split one recording of several speakers into a lane per speaker (#1095).

Every lane plays the same media through copies of the original lane's clips; nothing
is decoded or written. Each lane is muted (``Clip.mute_regions``) wherever it does not
own the audio. Ownership comes from the speaker turns, which cover the recording
without gaps, so outside crosstalk exactly one lane is open at any moment and the
lanes sum back to the original mix. Flagged crosstalk plays on its most likely
speaker's lane only (``owner``, the default: the flag is often wrong, so nothing plays
twice and the flag stays on the turn for review), on every lane talking in it
(``both``, where the mix carries it twice) or only on a shared crosstalk lane
(``lane``). The fade at each hand-over is centred on the boundary, so one lane's
linear fade-out and the next lane's fade-in sum to one.

Room tone under a mute (``room_tone_fill``) is off by default: the lane that owns the
moment already carries the bed, so a fill adds another copy of it to the mix.
"""

from __future__ import annotations

import uuid
from bisect import bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.timeline_ops import mute_room_tone_fill
from podcast_mcp.engines.clips_ops import clips_for_track, new_clip_id
from podcast_mcp.engines.mute_regions import add_source_mute, merge_mute_regions
from podcast_mcp.engines.render_invalidations import record_invalidation
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.engines.speaker_split import SpeakerAttribution
from podcast_mcp.engines.track_ids import slug_track_id
from podcast_mcp.engines.transcript_sync import rebuild_combined
from podcast_mcp.models import (
    Clip,
    ClipMuteRegion,
    EpisodeProject,
    MediaAsset,
    SpeakerSplit,
    SpeakerSplitCrosstalk,
    SpeakerTurnRecord,
    Track,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.models.words_revision import set_words
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.intervals import merge_intervals, subtract_intervals
from podcast_mcp.util.timebase import SourceSec

CROSSTALK_MODES: tuple[SpeakerSplitCrosstalk, ...] = ("owner", "both", "lane")
SPLIT_FADE_MS = 20
"""Hand-over fade: long enough not to click, short next to a syllable."""
LOW_CONFIDENCE = 0.5
"""A turn below this confidence is reported as one the attribution is unsure of."""
CROSSTALK_LANE_NAME = "crosstalk"

Span = tuple[float, float]


@dataclass(frozen=True)
class LaneSpanMove:
    """Move nominal source ownership of ``[source_start, source_end)`` between split lanes."""

    from_lane: str
    to_lane: str
    source_start: float
    source_end: float


@dataclass(frozen=True)
class SplitMediaIdentity:
    """Primary media fields used to create the attribution being committed."""

    path: str
    duration_sec: float | None

    @classmethod
    def capture(cls, media: MediaAsset) -> SplitMediaIdentity:
        return cls(path=media.path, duration_sec=media.duration_sec)

    def matches(self, media: MediaAsset) -> bool:
        return media.path == self.path and media.duration_sec == self.duration_sec


def _split_lane_ids(split: SpeakerSplit) -> set[str]:
    lanes = set(split.lanes)
    if split.crosstalk_lane is not None:
        lanes.add(split.crosstalk_lane)
    return lanes


def _lane_media_duration(project: EpisodeProject, lane_id: str) -> float:
    track = project.track_by_id(lane_id)
    if track is not None and track.media is not None and track.media.duration_sec is not None:
        return float(track.media.duration_sec)
    clips = clips_for_track(project, lane_id)
    return max((clip.source_end for clip in clips), default=0.0)


def split_for_track(project: EpisodeProject, track_id: str) -> SpeakerSplit | None:
    """The split ``track_id`` is a lane of, if any."""
    return next(
        (
            split
            for split in project.editorial.speaker_splits
            if track_id in split.lanes or track_id == split.crosstalk_lane
        ),
        None,
    )


def _turn_owners(split: SpeakerSplit, turn: SpeakerTurnRecord) -> list[str]:
    if turn.crosstalk and split.crosstalk_lane is not None:
        return [split.crosstalk_lane]
    if split.crosstalk_mode == "both":
        return turn.speakers
    return turn.speakers[:1]


def owned_spans(split: SpeakerSplit) -> dict[str, list[Span]]:
    """Source spans each lane plays, from the split's turns and crosstalk mode."""
    owned: dict[str, list[Span]] = {lane: [] for lane in split.lanes}
    if split.crosstalk_lane is not None:
        owned[split.crosstalk_lane] = []
    for turn in split.turns:
        for lane in _turn_owners(split, turn):
            owned[lane].append((turn.start_s, turn.end_s))
    return {lane: merge_intervals(spans) for lane, spans in owned.items()}


def mute_spans(owned: Sequence[Span], duration: float) -> list[Span]:
    """Where a lane owning ``owned`` is muted within ``[0, duration)``."""
    return subtract_intervals([(0.0, duration)], owned) if duration > 0 else []


def _mute_region(span: Span, duration: float, fade_ms: int) -> ClipMuteRegion:
    """A mute whose fades are centred on the span's edges; none at the media's ends."""
    half = fade_ms / 2000.0
    start, end = span
    at_start, at_end = start <= 1e-9, end >= duration - 1e-9
    return ClipMuteRegion(
        start_s=start if at_start else max(0.0, start - half),
        end_s=end if at_end else end + half,
        fade_out_ms=0 if at_start else fade_ms,
        fade_in_ms=0 if at_end else fade_ms,
    )


def _nominal_mute_span(region: ClipMuteRegion) -> Span:
    """Undo the centred-fade expansion so leftover rebuild can use ``_mute_region``."""
    start = region.start_s + region.fade_out_ms / 2000.0
    end = region.end_s - region.fade_in_ms / 2000.0
    if end <= start + 1e-9:
        return (region.start_s, region.end_s)
    return (start, end)


def _lowered_leftovers(
    region: ClipMuteRegion, start: float, end: float, fade_ms: int
) -> list[ClipMuteRegion]:
    """A lowered region minus ``[start, end)``: each piece keeps its gain and original edge fades."""
    pieces: list[ClipMuteRegion] = []
    for lo, hi in subtract_intervals([(region.start_s, region.end_s)], [(start, end)]):
        if hi <= lo + 1e-9:
            continue
        pieces.append(
            region.model_copy(
                update={
                    "start_s": lo,
                    "end_s": hi,
                    "fade_out_ms": region.fade_out_ms if lo <= region.start_s + 1e-9 else fade_ms,
                    "fade_in_ms": region.fade_in_ms if hi >= region.end_s - 1e-9 else fade_ms,
                }
            )
        )
    return pieces


def _rebuild_leftover_mutes(
    project: EpisodeProject,
    clip: Clip,
    start: float,
    end: float,
    duration: float,
    fade_ms: int,
) -> None:
    """Reopen ``[start, end)`` and rebuild overlapping leftovers with split fade geometry."""
    hole = _mute_region((start, end), duration, fade_ms)
    kept: list[ClipMuteRegion] = []
    leftovers: list[ClipMuteRegion] = []
    for region in clip.mute_regions:
        if region.end_s <= hole.start_s + 1e-9 or region.start_s >= hole.end_s - 1e-9:
            kept.append(region)
            continue
        if region.gain_db is not None:
            leftovers.extend(_lowered_leftovers(region, start, end, fade_ms))
            continue
        for span in subtract_intervals([_nominal_mute_span(region)], [(start, end)]):
            if span[1] <= span[0] + 1e-9:
                continue
            leftover = _mute_region(span, duration, fade_ms)
            if region.fill is not None:
                fill = mute_room_tone_fill(project, clip, *span)
                leftover = leftover.model_copy(update={"fill": fill or region.fill})
            leftovers.append(leftover)
    clip.mute_regions = merge_mute_regions([*kept, *leftovers])


def _unique_track_id(project: EpisodeProject, wanted: str, taken: set[str]) -> str:
    base = slug_track_id(wanted)
    candidate, n = base, 2
    while candidate in taken or project.track_by_id(candidate) is not None:
        candidate, n = f"{base}_{n}", n + 1
    taken.add(candidate)
    return candidate


def _copy_lane(
    project: EpisodeProject, source: Track, lane_id: str, name: str, position: int
) -> None:
    """A new track playing ``source``'s media through copies of its clips and mix."""
    project.tracks.insert(
        position,
        source.model_copy(
            deep=True,
            update={"id": lane_id, "label": name, "speaker": name, "proxy": None},
        ),
    )
    for clip in clips_for_track(project, source.id):
        project.clips.append(
            clip.model_copy(deep=True, update={"id": new_clip_id(), "track_id": lane_id})
        )
    for chain in [c for c in project.processing_chains if c.track_id == source.id]:
        project.processing_chains.append(chain.model_copy(deep=True, update={"track_id": lane_id}))
    for env in [e for e in project.automation_envelopes if e.track_id == source.id]:
        project.automation_envelopes.append(env.model_copy(deep=True, update={"track_id": lane_id}))


def _turn_records(attribution: SpeakerAttribution, lanes: list[str]) -> list[SpeakerTurnRecord]:
    return [
        SpeakerTurnRecord(
            start_s=turn.start,
            end_s=turn.end,
            speakers=[lanes[i] for i in turn.speakers],
            confidence=round(turn.confidence, 3),
        )
        for turn in attribution.turns
        if turn.end > turn.start
    ]


def _transfer_transcript_words(
    project: EpisodeProject, from_lane: str, to_lane: str, start: float, end: float
) -> int:
    from_transcript = project.transcript_for_track(from_lane)
    if from_transcript is None:
        return 0
    to_transcript = project.transcript_for_track(to_lane)
    if to_transcript is None:
        return 0
    moving: list[TranscriptWord] = []
    staying: list[TranscriptWord] = []
    for word in from_transcript.words:
        mid = (word.start + max(word.end, word.start)) / 2.0
        if start <= mid < end:
            moving.append(word)
        else:
            staying.append(word)
    set_words(from_transcript, staying)
    set_words(to_transcript, sorted([*to_transcript.words, *moving], key=lambda w: w.start))
    return len(moving)


def move_lane_span(
    project: EpisodeProject,
    move: LaneSpanMove,
    *,
    fade_ms: int = SPLIT_FADE_MS,
    defaults: EffectiveConfig,
) -> dict[str, Any]:
    """Mute ``move`` on ``from_lane`` and reopen it on ``to_lane`` with split fade geometry."""
    start, end = move.source_start, move.source_end
    if end <= start + 1e-9:
        raise CodedValueError("source span must be non-empty", code="speaker_move_lane_span_empty")
    if move.from_lane == move.to_lane:
        raise CodedValueError(
            "source and target lane must differ", code="speaker_move_lane_span_same_lane"
        )
    split = split_for_track(project, move.from_lane)
    siblings = _split_lane_ids(split) if split is not None else set()
    if split is None or move.from_lane not in siblings or move.to_lane not in siblings:
        raise CodedValueError(
            "both lanes must belong to the same speaker split",
            code="speaker_move_lane_span_not_sibling",
        )
    duration = _lane_media_duration(project, move.from_lane)
    region = _mute_region((start, end), duration, fade_ms)
    for clip in clips_for_track(project, move.from_lane):
        add_source_mute(clip, region)
    for clip in clips_for_track(project, move.to_lane):
        _rebuild_leftover_mutes(project, clip, start, end, duration, fade_ms)
    words_moved = _transfer_transcript_words(project, move.from_lane, move.to_lane, start, end)
    rebuild_combined(project, defaults=defaults)
    record_invalidation(project, track_ids=[move.from_lane, move.to_lane])
    return {
        "from_lane": move.from_lane,
        "to_lane": move.to_lane,
        "source_start": start,
        "source_end": end,
        "mute_region": {
            "start_s": region.start_s,
            "end_s": region.end_s,
            "fade_out_ms": region.fade_out_ms,
            "fade_in_ms": region.fade_in_ms,
        },
        "words_moved": words_moved,
    }


def _split_transcripts(project: EpisodeProject, split: SpeakerSplit, track_id: str) -> None:
    """Give each word to the most likely speaker of the turn holding its midpoint."""
    original = project.transcript_for_source(track_id, None)
    if original is None:
        return
    starts = [t.start_s for t in split.turns]
    by_lane: dict[str, list[TranscriptWord]] = {lane: [] for lane in split.lanes}
    for word in original.words:
        mid = (word.start + max(word.end, word.start)) / 2.0
        i = max(0, bisect_right(starts, mid) - 1)
        by_lane[split.turns[i].speakers[0] if split.turns else track_id].append(word)
    set_words(original, by_lane[track_id])
    for lane in split.lanes:
        if lane == track_id:
            continue
        project.transcripts.append(
            Transcript.model_validate(
                {
                    **original.model_dump(exclude={"words", "archived_words"}),
                    "track_id": lane,
                    "words": [w.model_dump() for w in by_lane[lane]],
                }
            )
        )


def ensure_splittable(project: EpisodeProject, track_id: str) -> tuple[Track, str]:
    """The track ``track_id`` names and its media path, if it holds one recording not yet split."""
    track = project.track_by_id(track_id)
    if track is None or track.media is None:
        raise CodedValueError(
            f"track {track_id} has no media to split. Add media to that track first.",
            code="speaker_split_no_media",
        )
    if split_for_track(project, track_id) is not None:
        raise CodedValueError(
            f"track {track_id} is already split by speaker", code="speaker_split_already_split"
        )
    clips = clips_for_track(project, track_id)
    if not clips:
        raise CodedValueError(
            f"track {track_id} has no clips to split. Add clips to that track first.",
            code="speaker_split_no_media",
        )
    if any(clip.source_id is not None for clip in clips):
        raise CodedValueError(
            f"track {track_id} plays more than one recording; split needs one",
            code="speaker_split_multiple_recordings",
        )
    return track, track.media.path


def unsure_spans(split: SpeakerSplit) -> list[Span]:
    """Source spans whose speaker the attribution was unsure of, merged."""
    return merge_intervals(
        [(t.start_s, t.end_s) for t in split.turns if t.confidence < LOW_CONFIDENCE]
    )


def split_track_by_speaker(
    project: EpisodeProject,
    track_id: str,
    attribution: SpeakerAttribution,
    *,
    media_identity: SplitMediaIdentity,
    names: Sequence[str],
    crosstalk_mode: SpeakerSplitCrosstalk = "owner",
    room_tone_fill: bool = False,
    fade_ms: int = SPLIT_FADE_MS,
    defaults: EffectiveConfig,
) -> dict:
    """Turn ``track_id`` into one lane per speaker of ``attribution``; mutates ``project``.

    The original track becomes the first speaker's lane, keeping its id, transcript
    words of that speaker, FX and clips. Each other speaker (and the crosstalk lane in
    ``lane`` mode) gets a copy of it.
    """
    track, media_path = ensure_splittable(project, track_id)
    if track.media is None or not media_identity.matches(track.media):
        raise CodedValueError(
            "the track's primary media changed while speaker recognition was running",
            code="speaker_split_media_changed",
        )
    if crosstalk_mode not in CROSSTALK_MODES:
        raise CodedValueError(
            f"crosstalk_mode must be one of {CROSSTALK_MODES}", code="crosstalk_mode_invalid"
        )
    if len(names) != attribution.speaker_count:
        raise CodedValueError(
            f"expected {attribution.speaker_count} speaker names, got {len(names)}. Pass one name per speaker.",
            code="speaker_names_count_mismatch",
        )

    taken: set[str] = {track_id}
    lanes = [track_id] + [
        _unique_track_id(project, f"{track_id}_{name}", taken) for name in names[1:]
    ]
    crosstalk_lane = (
        _unique_track_id(project, f"{track_id}_{CROSSTALK_LANE_NAME}", taken)
        if crosstalk_mode == "lane"
        else None
    )
    split = SpeakerSplit(
        id=f"split_{uuid.uuid4().hex[:8]}",
        media_path=media_path,
        lanes=lanes,
        crosstalk_mode=crosstalk_mode,
        crosstalk_lane=crosstalk_lane,
        turns=_turn_records(attribution, lanes),
        backend=attribution.backend,
        method=attribution.method,
    )
    copies = list(zip(lanes[1:], names[1:], strict=True))
    if crosstalk_lane is not None:
        copies.append((crosstalk_lane, CROSSTALK_LANE_NAME.title()))
    after = project.tracks.index(track) + 1
    for offset, (lane, name) in enumerate(copies):
        _copy_lane(project, track, lane, name, after + offset)
    track.label = names[0]
    track.speaker = names[0]

    duration = attribution.duration
    muted_sec: dict[str, float] = {}
    for lane, spans in owned_spans(split).items():
        mutes = mute_spans(spans, duration)
        muted_sec[lane] = round(sum(e - s for s, e in mutes), 3)
        for clip in clips_for_track(project, lane):
            for span in mutes:
                region = _mute_region(span, duration, fade_ms)
                if room_tone_fill:
                    fill = mute_room_tone_fill(project, clip, *span)
                    region = region.model_copy(update={"fill": fill})
                add_source_mute(clip, region)
    _split_transcripts(project, split, track_id)
    project.editorial.speaker_splits.append(split)
    rebuild_combined(project, defaults=defaults)
    record_invalidation(project, track_ids=[*lanes, *([crosstalk_lane] if crosstalk_lane else [])])
    crosstalk = split.crosstalk_spans()
    unsure = unsure_spans(split)
    timeline = SessionTimeline(project)
    return {
        "split_id": split.id,
        "lanes": [
            {"track_id": lane, "name": name, "muted_sec": muted_sec[lane]}
            for lane, name in zip(lanes, names, strict=True)
        ],
        "crosstalk_lane": crosstalk_lane,
        "crosstalk_mode": crosstalk_mode,
        "crosstalk_sec": round(sum(e - s for s, e in crosstalk), 3),
        "crosstalk_regions": len(crosstalk),
        "low_confidence_sec": round(sum(e - s for s, e in unsure), 3),
        "low_confidence_regions": len(unsure),
        "turns": len(split.turns),
        "review_spans": [
            {
                "start_s": turn.start_s,
                "end_s": turn.end_s,
                "speakers": list(turn.speakers),
                "unsure": turn.confidence < LOW_CONFIDENCE,
                "overlapping": turn.crosstalk,
                "timeline_spans": [
                    {"start_s": float(start), "end_s": float(end)}
                    for start, end in timeline.map_source_span(
                        split.lanes[0], SourceSec(turn.start_s), SourceSec(turn.end_s)
                    )
                ],
            }
            for turn in split.turns
            if turn.confidence < LOW_CONFIDENCE or turn.crosstalk
        ],
        "backend": split.backend,
        "method": split.method,
    }
