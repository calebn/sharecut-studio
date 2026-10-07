"""Split one recording of several speakers into a lane per speaker (#1095).

Every lane plays the same media through copies of the original lane's clips; nothing
is decoded or written. Each lane is muted (``Clip.mute_regions``) wherever it does not
own the audio. Ownership comes from the speaker turns, which cover the recording
without gaps, so outside crosstalk exactly one lane is open at any moment and the
lanes sum back to the original mix. Crosstalk plays on every lane talking in it
(``both``, where the mix carries it twice) or only on a shared crosstalk lane
(``lane``, where the sum stays exact). The fade at each hand-over is centred on the
boundary, so one lane's linear fade-out and the next lane's fade-in sum to one.

Room tone under a mute (``room_tone_fill``) is off by default: the lane that owns the
moment already carries the bed, so a fill adds another copy of it to the mix.
"""

from __future__ import annotations

import uuid
from bisect import bisect_right
from collections.abc import Sequence
from typing import Literal

from podcast_mcp.edits.clips_ops import clips_for_track, new_clip_id
from podcast_mcp.edits.mute_regions import add_source_mute
from podcast_mcp.edits.timeline_ops import mute_room_tone_fill
from podcast_mcp.edits.track_ids import slug_track_id
from podcast_mcp.edits.transcript_sync import rebuild_combined
from podcast_mcp.engines.render_invalidations import record_invalidation
from podcast_mcp.engines.speaker_split import SpeakerAttribution
from podcast_mcp.models import (
    ClipMuteRegion,
    EpisodeProject,
    SpeakerSplit,
    SpeakerTurnRecord,
    Track,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.intervals import merge_intervals, subtract_intervals

CrosstalkMode = Literal["both", "lane"]
CROSSTALK_MODES: tuple[CrosstalkMode, ...] = ("both", "lane")
SPLIT_FADE_MS = 20
"""Hand-over fade: long enough not to click, short next to a syllable."""
CROSSTALK_LANE_NAME = "crosstalk"

Span = tuple[float, float]


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


def owned_spans(split: SpeakerSplit) -> dict[str, list[Span]]:
    """Source spans each lane plays, from the split's turns and crosstalk lane."""
    owned: dict[str, list[Span]] = {lane: [] for lane in split.lanes}
    if split.crosstalk_lane is not None:
        owned[split.crosstalk_lane] = []
    for turn in split.turns:
        span = (turn.start_s, turn.end_s)
        if turn.crosstalk and split.crosstalk_lane is not None:
            owned[split.crosstalk_lane].append(span)
        else:
            for lane in turn.speakers:
                owned[lane].append(span)
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


def _split_transcripts(project: EpisodeProject, split: SpeakerSplit, source_id: str) -> None:
    """Give each word to the most likely speaker of the turn holding its midpoint."""
    original = project.transcript_for_source(source_id, None)
    if original is None:
        return
    starts = [t.start_s for t in split.turns]
    by_lane: dict[str, list[TranscriptWord]] = {lane: [] for lane in split.lanes}
    for word in original.words:
        mid = (word.start + max(word.end, word.start)) / 2.0
        i = max(0, bisect_right(starts, mid) - 1)
        by_lane[split.turns[i].speakers[0] if split.turns else source_id].append(word)
    original.words = by_lane[source_id]
    for lane in split.lanes:
        if lane == source_id:
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


def split_track_by_speaker(
    project: EpisodeProject,
    track_id: str,
    attribution: SpeakerAttribution,
    *,
    names: Sequence[str],
    crosstalk_mode: CrosstalkMode = "both",
    room_tone_fill: bool = False,
    fade_ms: int = SPLIT_FADE_MS,
) -> dict:
    """Turn ``track_id`` into one lane per speaker of ``attribution``; mutates ``project``.

    The original track becomes the first speaker's lane, keeping its id, transcript
    words of that speaker, FX and clips. Each other speaker (and the crosstalk lane in
    ``lane`` mode) gets a copy of it.
    """
    track = project.track_by_id(track_id)
    if track is None or track.media is None:
        raise ValueError(f"track {track_id} has no media to split")
    if split_for_track(project, track_id) is not None:
        raise ValueError(f"track {track_id} is already split by speaker")
    if crosstalk_mode not in CROSSTALK_MODES:
        raise ValueError(f"crosstalk_mode must be one of {CROSSTALK_MODES}")
    if len(names) != attribution.speaker_count:
        raise ValueError(f"expected {attribution.speaker_count} speaker names, got {len(names)}")
    clips = clips_for_track(project, track_id)
    if not clips:
        raise ValueError(f"track {track_id} has no clips to split")
    if any(clip.source_id is not None for clip in clips):
        raise ValueError(f"track {track_id} plays more than one recording; split needs one")

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
        media_path=track.media.path,
        lanes=lanes,
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
    rebuild_combined(project)
    record_invalidation(project, track_ids=[*lanes, *([crosstalk_lane] if crosstalk_lane else [])])
    crosstalk = split.crosstalk_spans()
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
        "turns": len(split.turns),
        "backend": split.backend,
        "method": split.method,
    }
