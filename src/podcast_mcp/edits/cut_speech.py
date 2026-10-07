"""The speech guard: a ripple that cuts another track's speech asks first.

Every rippling edit plans its :class:`RippleRemoval` and asks :func:`clear_ripple`
before it changes anything. Speech is another scope track's unsuppressed transcript
words inside a removed span, or, where it has no such words, its own sound at speech
level (``speech_energy_guard.measure_peer_speech``). With speech there and no
``confirm_cut_speech``, the edit returns a :class:`CutSpeechConfirmation` and changes
nothing; confirmed, it applies and the speech it cut is recorded with it. With no
other speech in the span it applies at once. The apply functions take a
:class:`SpeechClearance`, so no ripple removes time without one.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Final, Literal

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

    @classmethod
    def scope_guarded(cls, removal: RippleRemoval) -> SpeechClearance:
        """Tighten and NL removes: ``resolve_cut_scope`` already turned a cut over
        speaking peers into a track-local punch, so this ripple is the clear case."""
        return cls(removal)

    def require(self, removal: RippleRemoval | None) -> None:
        if removal != self.removal:
            raise ValueError("speech clearance does not match this edit's removal")

    def log_params(self) -> dict[str, Any]:
        """Edit-log params naming the confirmed speech, empty when none was cut."""
        if self.cut_speech is None:
            return {}
        return {"cut_speech": self.cut_speech.model_dump(mode="json")}


def _speaker(project: EpisodeProject, track_id: str) -> str:
    track = project.track_by_id(track_id)
    if track is None:
        return track_id
    return track.speaker or track.label or track_id


def _words_in_span(
    project: EpisodeProject, track_id: str, start: float, end: float, min_overlap: float
) -> list[CutSpeechWord]:
    words: list[CutSpeechWord] = []
    for clip in clips_for_track(project, track_id):
        source = clip_timeline_overlap_to_source(clip, start, end)
        if source is None:
            continue
        transcript = project.transcript_for_source(clip.track_id, clip.source_id)
        if transcript is None:
            continue
        lo, hi = source
        shift = clip_source_to_timeline_shift(clip)
        for word in transcript.words:
            if word.suppressed or word.ignored or word.suspect_hallucination:
                continue
            w_start, w_end = word_source_span(word.start, word.end)
            overlap = min(w_end, hi) - max(w_start, lo)
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
    unlabeled: list[tuple[int, list[str]]],
    scope: list[str],
    cfg: dict[str, Any],
) -> dict[str, list[RangeInterval]]:
    """Windows where a peer without words in the span speaks with its own sound.

    Short windows keep a brief remark from averaging away under a long span.
    """
    jobs = [
        (window, removal.spans[index].edited_track_ids, peers)
        for index, peers in unlabeled
        for window in _windows(removal.spans[index].start, removal.spans[index].end)
    ]
    caches = (
        build_track_rms_caches(project, track_ids=scope) if len(jobs) > _WINDOW_READS_MAX else None
    )
    found: dict[str, list[tuple[float, float]]] = {}
    for window, owners, peers in jobs:
        levels = measure_peer_speech(
            project,
            [window],
            owner_track_ids=owners,
            peer_track_ids=peers,
            defaults=cfg,
            caches=caches,
        )
        for tid in levels.speaking if levels is not None else ():
            found.setdefault(tid, []).append(window)
    return {
        tid: [RangeInterval(start=s, end=e) for s, e in merge_intervals(spans, gap=1e-6)]
        for tid, spans in found.items()
    }


def assess_cut_speech(
    project: EpisodeProject,
    removal: RippleRemoval,
    *,
    defaults: dict[str, Any] | None = None,
) -> CutSpeech | None:
    """Other tracks' speech inside ``removal``, or ``None`` when it cuts none."""
    cfg = defaults if defaults is not None else load_defaults()
    min_overlap = guard_min_overlap_sec(cfg)
    scope = ripple_track_ids(project, removal.edited_track_ids)
    words: dict[str, list[CutSpeechWord]] = {}
    sound: dict[str, list[RangeInterval]] = {}
    unlabeled: list[tuple[int, list[str]]] = []
    for index, span in enumerate(removal.spans):
        quiet_text: list[str] = []
        for tid in scope:
            if tid in span.edited_track_ids:
                continue
            found = _words_in_span(project, tid, span.start, span.end, min_overlap)
            if found:
                words.setdefault(tid, []).extend(found)
            else:
                quiet_text.append(tid)
        if quiet_text:
            unlabeled.append((index, quiet_text))
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
        spans=[RangeInterval(start=span.start, end=span.end) for span in removal.spans],
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


def cut_speech_message(speech: CutSpeech) -> str:
    """Confirmation copy: what else gets cut, then the two ways forward."""
    phrases = [_track_phrase(t) for t in sorted(speech.tracks, key=_first_time)]
    return f"This also cuts {_join(phrases)}. Cut anyway, or leave a gap to keep it."


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


def confirmation_for(speech: CutSpeech) -> CutSpeechConfirmation:
    return CutSpeechConfirmation(message=cut_speech_message(speech), speech=speech)


def clear_ripple(
    project: EpisodeProject,
    removal: RippleRemoval | None,
    *,
    confirm_cut_speech: bool,
    defaults: dict[str, Any] | None = None,
) -> SpeechClearance | CutSpeechConfirmation:
    """Clear ``removal`` to apply, or ask to confirm the other speech it would cut."""
    if removal is None:
        return SpeechClearance(None)
    speech = assess_cut_speech(project, removal, defaults=defaults)
    if speech is None:
        return SpeechClearance(removal)
    if not confirm_cut_speech:
        return confirmation_for(speech)
    return SpeechClearance(removal, cut_speech=speech)
