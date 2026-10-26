"""Measure speech an operation removes outside the selected source extents.

The cut application owner records these observations on its private candidate.
The peer predicate alone decides whether they require interactive review.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from typing import Any, Final, Literal

from pydantic import BaseModel

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.ripple import RippleRemoval, ripple_track_ids
from podcast_mcp.edits.speech_energy_guard import (
    guard_min_overlap_sec,
    measure_peer_speech,
    speech_energy_guard_enabled,
    speech_words_in,
)
from podcast_mcp.engines.audio_audit import TrackRmsCacheSet, build_track_rms_caches
from podcast_mcp.engines.clips_ops import clips_for_track
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    CutSpeech,
    CutSpeechTrack,
    CutSpeechWord,
    EpisodeProject,
)
from podcast_mcp.models.episode import RangeInterval
from podcast_mcp.util.intervals import merge_intervals, subtract_intervals
from podcast_mcp.util.timebase import SourceSec, clock_label

CUT_SPEECH_REASON: Final = "cuts_other_speech"
_QUOTED_WORDS_MAX = 8
# Own-sound evidence is read in windows this long, so a short remark is not averaged
# away under a long span.
_SOUND_WINDOW_SEC = 0.5
# Past this many window reads, decode each track once instead.
_WINDOW_READS_MAX = 8

APPLY_ANYWAY = (
    "To apply it as is, repeat the call with override_audio_checks=true "
    "(CLI --override-audio-checks)."
)


class CutSpeechConfirmation(BaseModel):
    """A programmatic cut held for interactive review; nothing changed."""

    status: Literal["needs_confirmation"] = "needs_confirmation"
    reason: Literal["cuts_other_speech"] = CUT_SPEECH_REASON
    message: str
    speech: CutSpeech

    def result(self, operation: str) -> dict[str, Any]:
        """The command result: unchanged, with this confirmation to show the person."""
        return {
            "operation": operation,
            "unchanged": True,
            "needs_confirmation": self.model_dump(mode="json"),
            "apply_anyway": APPLY_ANYWAY,
        }


@dataclass(frozen=True)
class LaneSourceExtent:
    track_id: str
    start: float
    end: float


@dataclass(frozen=True)
class RecordingSourceExtent:
    track_id: str
    start: float
    end: float
    source_id: str | None


SourceExtent = LaneSourceExtent | RecordingSourceExtent


def cut_speech_params(speech: CutSpeech | None) -> dict[str, Any]:
    return {"cut_speech": speech.model_dump(mode="json")} if speech is not None else {}


class UnconfirmedCutSpeech(Exception):
    """An approval that would cut other speech unconfirmed; raised to roll it back."""

    def __init__(self, confirmation: CutSpeechConfirmation) -> None:
        super().__init__(confirmation.message)
        self.confirmation = confirmation


def _speaker(project: EpisodeProject, track_id: str) -> str:
    track = project.track_by_id(track_id)
    if track is None:
        return track_id
    return track.speaker or track.label or track_id


def _chosen_on_timeline(
    project: EpisodeProject, track_id: str, chosen: Sequence[SourceExtent], start: float, end: float
) -> list[tuple[float, float]]:
    """Where ``track_id``'s ``chosen`` source spans sit inside timeline ``[start, end)`` now."""
    timeline = SessionTimeline(project)
    out: list[tuple[float, float]] = []
    for extent in (e for e in chosen if e.track_id == track_id):
        if isinstance(extent, LaneSourceExtent):
            source_ids = {clip.source_id for clip in clips_for_track(project, track_id)}
            mapped = [
                span
                for source_id in source_ids
                for span in timeline.map_selected_source_span(
                    track_id, source_id, SourceSec(extent.start), SourceSec(extent.end)
                )
            ]
        else:
            mapped = timeline.map_placements_source_span(
                track_id,
                project.equivalent_source_ids(track_id, extent.source_id),
                SourceSec(extent.start),
                SourceSec(extent.end),
            )
        for tl_start, tl_end in mapped:
            a = max(float(tl_start), start)
            b = min(float(tl_end), end)
            if b > a:
                out.append((a, b))
    return merge_intervals(out, gap=1e-6)


def _windows(start: float, end: float) -> list[tuple[float, float]]:
    count = max(1, math.ceil((end - start) / _SOUND_WINDOW_SEC - 1e-9))
    size = (end - start) / count
    edges = [start, *(min(end, start + i * size) for i in range(1, count)), end]
    return list(pairwise(edges))


def _own_sound(
    project: EpisodeProject,
    removal: RippleRemoval,
    unlabeled: list[tuple[str, list[tuple[float, float]]]],
    scope: list[str],
    cfg: dict[str, Any],
    *,
    timeline_caches: TrackRmsCacheSet | None = None,
    defaults: EffectiveConfig,
) -> dict[str, list[RangeInterval]]:
    """Windows where a track without words there speaks with its own sound.

    ``unlabeled`` pairs each such track with the parts of the removal it did not
    select. Short windows keep a brief remark from averaging away under a long span.
    The tracks that selected a window are its owners for the bleed rule.
    """
    jobs = [
        (window, _owners(removal, *window), tid)
        for tid, parts in unlabeled
        for start, end in parts
        for window in _windows(start, end)
    ]
    caches = timeline_caches
    if caches is None and len(jobs) > _WINDOW_READS_MAX:
        caches = build_track_rms_caches(
            project, track_ids=scope, unprocessed=True, defaults=defaults
        )
    found: dict[str, list[tuple[float, float]]] = {}
    for window, owners, tid in jobs:
        levels = measure_peer_speech(
            project,
            [window],
            owner_track_ids=owners,
            peer_track_ids=[tid],
            defaults=cfg,
            caches=caches,
            _admissible_spans=(window,),
            _removal_spans=removal.spans,
        )
        if levels is not None and tid in levels.speaking:
            found.setdefault(tid, []).append(window)
    return {
        tid: [RangeInterval(start=s, end=e) for s, e in merge_intervals(spans, gap=1e-6)]
        for tid, spans in found.items()
    }


def _owners(removal: RippleRemoval, start: float, end: float) -> frozenset[str]:
    return frozenset(e.track_id for e in removal.selected if e.start < end and e.end > start)


def assess_cut_speech(
    project: EpisodeProject,
    removal: RippleRemoval,
    *,
    also_chosen: Sequence[SourceExtent] = (),
    defaults: EffectiveConfig,
    timeline_caches: TrackRmsCacheSet | None = None,
) -> CutSpeech | None:
    """Speech ``removal`` cuts outside what it selected, or ``None`` when it cuts none.

    ``also_chosen`` is source time other edits in the same approval cut, so the
    speech there is chosen too.
    """
    min_overlap = guard_min_overlap_sec(defaults)
    scope = ripple_track_ids(project, removal.edited_track_ids)
    guard_on = speech_energy_guard_enabled(defaults)
    words: dict[str, list[CutSpeechWord]] = {}
    sound: dict[str, list[RangeInterval]] = {}
    unlabeled: list[tuple[str, list[tuple[float, float]]]] = []
    for start, end in removal.spans:
        for tid in scope:
            parts = subtract_intervals(
                removal.unselected_on(tid, start, end),
                _chosen_on_timeline(project, tid, also_chosen, start, end),
                epsilon=1e-6,
            )
            if not parts:
                continue
            found = speech_words_in(
                project,
                tid,
                parts,
                min_overlap,
                voiced=guard_on,
                caches=timeline_caches,
                defaults=defaults,
            )
            if found:
                words.setdefault(tid, []).extend(found)
            else:
                unlabeled.append((tid, parts))
    if unlabeled and guard_on:
        sound = _own_sound(
            project,
            removal,
            unlabeled,
            scope,
            defaults,
            timeline_caches=timeline_caches,
            defaults=defaults,
        )
    tracks = [
        CutSpeechTrack(
            track_id=tid,
            speaker=_speaker(project, tid),
            words=words.get(tid, []),
            sound_spans=sound.get(tid, []),
        )
        for tid in scope
        if tid in words or tid in sound
    ]
    if not tracks:
        return None
    return CutSpeech(
        spans=[RangeInterval(start=start, end=end) for start, end in removal.spans],
        tracks=tracks,
    )


def _first_time(track: CutSpeechTrack) -> float:
    return min([w.timeline_start for w in track.words] + [s.start for s in track.sound_spans])


def _track_phrase(track: CutSpeechTrack) -> str:
    phrase = f"{track.speaker}'s speech at {clock_label(_first_time(track))}"
    if not track.words:
        return phrase
    quoted = " ".join(w.text for w in track.words[:_QUOTED_WORDS_MAX])
    if len(track.words) > _QUOTED_WORDS_MAX:
        quoted += "…"
    return f'{phrase} ("{quoted}")'


def _join(parts: Sequence[str]) -> str:
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]


def cut_speech_message(speech: CutSpeech, *, owned: bool = True) -> str:
    """Confirmation copy: what gets cut, then the two ways forward.

    An ``owned`` cut names tracks it means to cut, so the speech is on the others and
    a gap keeps it. An unowned cut (a range with no tracks named) cuts everyone's, so
    the way to keep some is to name the tracks to cut.
    """
    phrases = _join([_track_phrase(t) for t in sorted(speech.tracks, key=_first_time)])
    if owned:
        return f"This also cuts {phrases}. Review this cut in Studio, or leave a gap to keep it."
    return f"This cuts {phrases}. Review this cut in Studio, or choose which tracks to cut."


def replace_confirmation_for(speech: CutSpeech) -> CutSpeechConfirmation:
    """The hold for a pickup that would also replace speech of a track it did not record."""
    phrases = _join([_track_phrase(t) for t in sorted(speech.tracks, key=_first_time)])
    return CutSpeechConfirmation(
        message=(
            f"Replacing this range also removes {phrases}, which this pickup did not record. "
            "Replace anyway to apply it; undo brings it back."
        ),
        speech=speech,
    )


def merge_cut_speech(speeches: Sequence[CutSpeech]) -> CutSpeech:
    """One report for several edits' cut speech, one row per track."""
    tracks: dict[str, CutSpeechTrack] = {}
    for speech in speeches:
        for track in speech.tracks:
            seen = tracks.get(track.track_id)
            tracks[track.track_id] = (
                track
                if seen is None
                else seen.model_copy(
                    update={
                        "words": [*seen.words, *track.words],
                        "sound_spans": [*seen.sound_spans, *track.sound_spans],
                    }
                )
            )
    return CutSpeech(
        spans=[span for speech in speeches for span in speech.spans],
        tracks=list(tracks.values()),
    )


def confirmation_for(speech: CutSpeech, *, owned: bool = True) -> CutSpeechConfirmation:
    return CutSpeechConfirmation(message=cut_speech_message(speech, owned=owned), speech=speech)
