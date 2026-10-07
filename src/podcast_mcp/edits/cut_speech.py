"""The speech guard: a ripple that cuts speech it did not select asks first.

Every rippling edit plans its :class:`RippleRemoval` and asks :func:`clear_ripple`
before it changes anything, approvals included (at approval time, from the current
transcript). What the edit selected is per track (``RippleRemoval.selected``): a
deleted clip's own extent, a named track's range. Speech is any scope track's
unsuppressed transcript words inside a removed span but outside that track's
selected extents (a range cut that names no tracks selects nothing, so it counts
every track's speech), or, where those parts have no such words, its own sound at
speech level (``speech_energy_guard.measure_peer_speech``). With speech there and no
``confirm_cut_speech``, the edit returns a :class:`CutSpeechConfirmation` and changes
nothing; confirmed, it applies and the speech it cut is recorded with it. With no
other speech in the span it applies at once. The apply functions take a
:class:`SpeechClearance`, which only :func:`clear_ripple` and a preview make, so no
ripple removes time without the guard.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Final, Literal, overload

from pydantic import BaseModel

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.edits.ripple import RippleRemoval, ripple_track_ids
from podcast_mcp.edits.speech_energy_guard import (
    guard_min_overlap_sec,
    measure_peer_speech,
    speech_energy_guard_enabled,
)
from podcast_mcp.engines.audio_audit import build_track_rms_caches
from podcast_mcp.engines.session_timeline import (
    clip_source_to_timeline_shift,
    clip_timeline_overlap_to_source,
    word_source_span,
)
from podcast_mcp.models import (
    CutSpeech,
    CutSpeechTrack,
    CutSpeechWord,
    EpisodeProject,
)
from podcast_mcp.models.episode import RangeInterval
from podcast_mcp.util.intervals import merge_intervals
from podcast_mcp.util.timebase import clock_label

CUT_SPEECH_REASON: Final = "cuts_other_speech"
CUT_ANYWAY_LABEL: Final = "Cut anyway"
_QUOTED_WORDS_MAX = 8
# Own-sound evidence is read in windows this long, so a short remark is not averaged
# away under a long span.
_SOUND_WINDOW_SEC = 0.5
# Past this many window reads, decode each track once instead.
_WINDOW_READS_MAX = 8


class CutSpeechConfirmation(BaseModel):
    """A ripple that would cut other speech and was not confirmed; nothing changed."""

    status: Literal["needs_confirmation"] = "needs_confirmation"
    reason: Literal["cuts_other_speech"] = CUT_SPEECH_REASON
    message: str
    confirm_label: Literal["Cut anyway"] = CUT_ANYWAY_LABEL
    confirm_field: Literal["confirm_cut_speech"] = "confirm_cut_speech"
    speech: CutSpeech

    def result(self, operation: str) -> dict[str, Any]:
        """The command result: unchanged, with this confirmation to show the person."""
        return {
            "operation": operation,
            "unchanged": True,
            "needs_confirmation": self.model_dump(mode="json"),
        }


@dataclass(frozen=True)
class SpeechClearance:
    """Permission for a ripple to remove ``removal``.

    ``cut_speech`` is the other tracks' speech the person confirmed cutting, or
    ``None`` when the removal cuts none.
    """

    removal: RippleRemoval | None
    cut_speech: CutSpeech | None = None

    @classmethod
    def for_preview(cls, removal: RippleRemoval | None) -> SpeechClearance:
        """A preview renders a copy and saves nothing, so it needs no confirmation."""
        return cls(removal)

    def require(self, removal: RippleRemoval | None) -> None:
        if removal != self.removal:
            raise ValueError("speech clearance does not match this edit's removal")

    def log_params(self) -> dict[str, Any]:
        """Edit-log params naming the confirmed speech, empty when none was cut."""
        if self.cut_speech is None:
            return {}
        return {"cut_speech": self.cut_speech.model_dump(mode="json")}


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


def _words_in_parts(
    project: EpisodeProject,
    track_id: str,
    parts: list[tuple[float, float]],
    min_overlap: float,
) -> list[CutSpeechWord]:
    """``track_id``'s unsuppressed words overlapping one of the timeline ``parts``."""
    words: list[CutSpeechWord] = []
    for clip in clips_for_track(project, track_id):
        sources = [
            source
            for start, end in parts
            if (source := clip_timeline_overlap_to_source(clip, start, end)) is not None
        ]
        if not sources:
            continue
        transcript = project.transcript_for_source(clip.track_id, clip.source_id)
        if transcript is None:
            continue
        shift = clip_source_to_timeline_shift(clip)
        for word in transcript.words:
            if word.suppressed or word.ignored or word.suspect_hallucination:
                continue
            w_start, w_end = word_source_span(word.start, word.end)
            overlap = max(min(w_end, hi) - max(w_start, lo) for lo, hi in sources)
            if overlap <= 0 or overlap < min(min_overlap, w_end - w_start) - 1e-9:
                continue
            words.append(
                CutSpeechWord(
                    text=word.text,
                    timeline_start=w_start + shift,
                    timeline_end=w_end + shift,
                )
            )
    return sorted(words, key=lambda w: w.timeline_start)


def _windows(start: float, end: float) -> list[tuple[float, float]]:
    count = max(1, math.ceil((end - start) / _SOUND_WINDOW_SEC - 1e-9))
    size = (end - start) / count
    return [(start + i * size, start + (i + 1) * size) for i in range(count)]


def _own_sound(
    project: EpisodeProject,
    removal: RippleRemoval,
    unlabeled: list[tuple[str, list[tuple[float, float]]]],
    scope: list[str],
    cfg: dict[str, Any],
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
    caches = (
        build_track_rms_caches(project, track_ids=scope) if len(jobs) > _WINDOW_READS_MAX else None
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
    defaults: dict[str, Any] | None = None,
) -> CutSpeech | None:
    """Speech ``removal`` cuts outside what it selected, or ``None`` when it cuts none."""
    cfg = defaults if defaults is not None else load_defaults()
    min_overlap = guard_min_overlap_sec(cfg)
    scope = ripple_track_ids(project, removal.edited_track_ids)
    words: dict[str, list[CutSpeechWord]] = {}
    sound: dict[str, list[RangeInterval]] = {}
    unlabeled: list[tuple[str, list[tuple[float, float]]]] = []
    for start, end in removal.spans:
        for tid in scope:
            parts = removal.unselected_on(tid, start, end)
            if not parts:
                continue
            found = _words_in_parts(project, tid, parts, min_overlap)
            if found:
                words.setdefault(tid, []).extend(found)
            else:
                unlabeled.append((tid, parts))
    if unlabeled and speech_energy_guard_enabled(cfg):
        sound = _own_sound(project, removal, unlabeled, scope, cfg)
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
        return f"This also cuts {phrases}. Cut anyway, or leave a gap to keep it."
    return f"This cuts {phrases}. Cut anyway, or choose which tracks to cut."


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


@overload
def clear_ripple(
    project: EpisodeProject,
    removal: RippleRemoval | None,
    *,
    confirm_cut_speech: Literal[True],
    defaults: dict[str, Any] | None = None,
) -> SpeechClearance: ...


@overload
def clear_ripple(
    project: EpisodeProject,
    removal: RippleRemoval | None,
    *,
    confirm_cut_speech: bool,
    defaults: dict[str, Any] | None = None,
) -> SpeechClearance | CutSpeechConfirmation: ...


def clear_ripple(
    project: EpisodeProject,
    removal: RippleRemoval | None,
    *,
    confirm_cut_speech: bool,
    defaults: dict[str, Any] | None = None,
) -> SpeechClearance | CutSpeechConfirmation:
    """The one guard every rippling path calls before it removes time.

    Clears ``removal`` to apply, or asks to confirm the speech it would cut outside
    what it selected. Confirmed, the clearance carries that speech for the record.
    """
    if removal is None:
        return SpeechClearance(None)
    speech = assess_cut_speech(project, removal, defaults=defaults)
    if speech is None:
        return SpeechClearance(removal)
    if not confirm_cut_speech:
        return confirmation_for(speech, owned=bool(removal.selected))
    return SpeechClearance(removal, cut_speech=speech)
