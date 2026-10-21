"""Cut planning: onset guards, nudges and kept-neighbour checks."""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

from podcast_mcp.config.defaults import join_micro_fade_ms
from podcast_mcp.edits import cut_policy, cut_safety
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.cut_placement import CutRejected
from podcast_mcp.edits.cut_quality import (
    post_pad_fade_in_bounds_ms,
    recommend_prev_word_lead_out_ms,
)
from podcast_mcp.edits.filler_pacing import (
    MIN_PACED_CUT_SEC,
    PacedPad,
)
from podcast_mcp.edits.tighten_reasons import (
    ACOUSTIC_FILLER_REASON,
)
from podcast_mcp.edits.voiced_runs import (
    HOP_SEC,
)
from podcast_mcp.edits.word_onset import (
    OnsetKind,
    decay_valley_onset,
    edge_decays_into_valley,
    next_kept_word,
    next_onset,
    voice_end,
    voice_onset,
    voice_separates,
)
from podcast_mcp.models import (
    EpisodeProject,
    TranscriptWord,
)
from podcast_mcp.util.text import lexicon_form

if TYPE_CHECKING:
    from podcast_mcp.edits.timeline_ops import (
        PauseEdgeFade,
    )
from podcast_mcp.edits.tighten.acoustic_scan import (
    _ACOUSTIC_MIN_CUT_SEC,
)
from podcast_mcp.edits.tighten.candidate import (
    _clamp_to_candidate,
    _CutCandidate,
)
from podcast_mcp.edits.tighten.repeats import (
    _cut_covers_reparandum,
)

# A word's voice may run this far past its transcript time before a pause or
# filler edge stops following it and the span is reviewed instead (Whisper places
# soft onsets up to ~0.5 s late; see edits/join_speech.py).
# Air kept between a word's voice edge and the cut edge, as join_speech suggests for
# existing clip edges. On the lab tape the 45 ms join-gate window then sits below the
# inaudible-splice floor instead of on the word's decay.
_MIN_NUDGED_CUT_SEC = 0.1


@dataclass(frozen=True)
class _CutPlan:
    """The span a cut removes, the join approving ships, and the pad a ripple inserts.

    Built by :meth:`for_cut` from the edit mode and the paced pad; the join
    decides which edge checks the span gets.
    """

    start: float
    end: float
    join: cut_policy.CutJoin
    pad: PacedPad | None = None
    # Where a plosive burst begins, once the right edge has been fitted to the next
    # word's onset; the decision carries it so the fade-in after the cut ends before it.
    # A gradual onset is not carried: a fade-in may cover it.
    next_burst: float | None = None
    effects: tuple[PauseEdgeFade, ...] = ()
    # The right edge was placed in a valley between the cut sound and the next kept
    # word, not in air under the voice floor: the voiced-edge check reads that valley
    # as a break too (#1358).
    end_in_valley: bool = False

    @classmethod
    def for_cut(
        cls, start: float, end: float, *, mute: bool, pad: PacedPad | None, reason: str
    ) -> _CutPlan:
        """The plan for a ripple (``pad`` from pacing) or a mute."""
        policy = cut_policy.sound_policy(reason, "mute" if mute else "ripple")
        assert policy is not None
        if policy.join is cut_policy.CutJoin.MUTE:
            return cls(start, end, policy.join)
        if pad is None or pad.seconds(start, end) <= 0:
            return cls(start, end, cut_policy.CutJoin.SPLICE)
        return cls(start, end, cut_policy.CutJoin.PADDED, pad)

    @property
    def replace_gap_sec(self) -> float | None:
        if self.pad is None:
            return None
        return self.pad.seconds(self.start, self.end)

    @property
    def checks(self) -> cut_policy.CutEdgeChecks:
        return cut_policy.CUT_EDGE_CHECKS[self.join]


# The right edge of a padded cut or a mute stops this far before the next word's
# onset, which is also the shortest fade-in the post-pad ramp is cut down to.
_ONSET_GUARD_SEC = 0.01


# Word ends carry about a frame of jitter either way: a faded edge that stops within
# two 20 ms frames of the filler's word end has removed the filler.
_FILLER_END_SLACK_SEC = 0.04


def _onset_guard_sec(defaults: dict[str, Any]) -> float:
    """How far a faded right edge stops before an onset: the guard, or the declick fade."""
    return max(_ONSET_GUARD_SEC, join_micro_fade_ms(defaults) / 1000.0)


def _shrink_to_next_onset(
    plan: _CutPlan,
    candidate: _CutCandidate,
    *,
    audio_cache: TrackAudioCache,
    defaults: dict[str, Any],
) -> _CutPlan | CutRejected:
    """End ``plan`` before the next word's acoustic onset; refuse it if the filler stays.

    A burst onset stays on the plan, so approval can end the fade-in after the cut
    before it; a gradual onset moves the edge but leaves the fade-in free.
    """
    guard = _onset_guard_sec(defaults)
    # Look as far as the longest post-pad fade-in could reach: an onset there does
    # not move the cut, but approval must still end the fade before it.
    fade_reach = post_pad_fade_in_bounds_ms(defaults)[1] / 1000.0
    onset = next_onset(audio_cache, candidate.end, plan.end + guard + fade_reach)
    if onset is None:
        return plan
    burst = onset.sec if onset.kind is OnsetKind.BURST else None
    # A cut that ends in a valley already carries the frame after the valley bottom as the
    # fade-in cap (#1358); a later onset never raises it.
    burst = min((b for b in (burst, plan.next_burst) if b is not None), default=None)
    if onset.sec >= plan.end + guard:
        return replace(plan, next_burst=burst)
    end = min(plan.end, onset.sec - guard)
    if end < candidate.end - _FILLER_END_SLACK_SEC:
        return CutRejected("next_onset")
    return replace(plan, end=end, next_burst=burst)


# How far before its word start a filler's voice is looked for: word times drift by
# up to ~1.2 s on the lab tape.
_FILLER_ONSET_REACH_SEC = 2.0


def _start_at_filler_onset(
    project: EpisodeProject,
    plan: _CutPlan,
    candidate: _CutCandidate,
    *,
    audio_cache: TrackAudioCache,
    defaults: dict[str, Any],
) -> _CutPlan | CutRejected:
    """Start ``plan`` before the filler's acoustic onset; refuse it if a kept word runs into it.

    The walk back never passes the previous kept word's end. When the level stays
    audible all the way there, the filler and that word share one stretch of voice:
    an edge at the word's end cuts its tail (lab "to like" at 424.6: the vowel of
    "to" runs 80 ms past its word end into "like"), and an edge at the word start
    leaves the filler's head, so the cut is skipped.
    """
    walk_floor = candidate.start - _FILLER_ONSET_REACH_SEC
    tr = project.transcript_for_source(candidate.track_id, None)
    for w in tr.words if tr else ():
        if w.suppressed or w.end <= w.start or candidate.start <= w.start:
            continue
        walk_floor = max(walk_floor, min(w.end, candidate.start))
    before, _after = _kept_neighbours(project, candidate)
    decay_safe: float | None = None
    if before is not None:
        air_after_prev = candidate.start - before.end
        if air_after_prev > 1e-9 and voice_separates(audio_cache, before.end, candidate.start):
            decay_safe = before.end + (
                recommend_prev_word_lead_out_ms(
                    project,
                    candidate.track_id,
                    before.end,
                    defaults=defaults,
                    audio_cache=audio_cache,
                )
                / 1000.0
            )
    onset = voice_onset(audio_cache, candidate.start, walk_floor)
    prev_voice_runs_on = (
        before is not None
        and voice_end(audio_cache, before.end, candidate.start) is None
        and voice_separates(audio_cache, before.end, candidate.start)
    )
    if onset is None:
        if (
            decay_safe is not None
            and before is not None
            and prev_voice_runs_on
            and before.end < plan.start < decay_safe - 1e-9
        ):
            return replace(plan, start=decay_safe)
        return CutRejected("filler_onset")
    start = max(walk_floor, onset - _ONSET_GUARD_SEC)
    gradual_onset = onset + 1e-9 >= candidate.start
    if (
        decay_safe is not None
        and before is not None
        and prev_voice_runs_on
        and gradual_onset
        and before.end < plan.start < decay_safe - 1e-9
    ):
        return replace(plan, start=max(start, decay_safe))
    if onset < candidate.start and start + 1e-9 < plan.start:
        return replace(plan, start=start)
    return plan


def _kept_neighbours(
    project: EpisodeProject, candidate: _CutCandidate
) -> tuple[TranscriptWord | None, TranscriptWord | None]:
    """The kept words that end last before the candidate and start first after it."""
    before: TranscriptWord | None = None
    tr = project.transcript_for_source(candidate.track_id, None)
    for w in tr.words if tr else ():
        if w.suppressed or w.end <= w.start:
            continue
        if w.end <= candidate.start and (before is None or w.end > before.end):
            before = w
    return before, next_kept_word(tr, candidate.end)


def _cut_minimum_sec(candidate: _CutCandidate) -> float:
    return (
        _ACOUSTIC_MIN_CUT_SEC if candidate.reason == ACOUSTIC_FILLER_REASON else MIN_PACED_CUT_SEC
    )


def _between_kept_voices(
    project: EpisodeProject,
    plan: _CutPlan,
    candidate: _CutCandidate,
    *,
    audio_cache: TrackAudioCache,
    defaults: dict[str, Any],
) -> _CutPlan | CutRejected:
    """Keep ``plan`` out of the voice of the kept words either side of it (#1064).

    Word times end a word before its voice does: the lab "So" ends at 230.78 and
    voices until 230.98, and a mute from 230.805 cut its second half. The neighbours'
    voices are read from the audio against the track's own voice floor, as the
    filler's own onset is: ``voice_end`` walks forward from the previous kept word's
    end to where its voice breaks, ``voice_onset`` back from the next kept word's
    start to where its voice breaks.

    A cut without words of its own (an acoustic run, a pause) starts after the
    previous word's voice and ends before the next word's, with the voiced-edge air
    (``cut_safety.VOICE_EDGE_PAD_SEC``) either side, in every join. One that a kept word's
    voice runs on through, or that is too short or misses its run once moved, is
    dropped as ``kept_voice``. A cut with words of its own reads each neighbour only
    up to those words and keeps the faded-edge margins its onset rules use: it starts
    no earlier than the first quiet frame after the previous word (the filler-onset
    rule's edge, #1061) and ends 10 ms before the next word's voice. Voice that runs
    on between such a cut and a neighbour with no quiet frame is the filler-onset and
    next-onset rules' to judge (the latter finds the foot of the rise), unless nothing
    at all separates the previous word's voice from the whole cut: then the cut lies
    inside that word's voice and is dropped as ``kept_voice`` (#1024: skip what cannot
    be removed without clipping a neighbour; Whisper times the lab repeat "that" at
    752.72-752.90 inside the voice of "well,"). Word times cannot stand in for them:
    Whisper starts the lab "we" after "Uh," 180 ms early.
    """
    wordless = candidate.cut_kind == "pause" or candidate.reason == ACOUSTIC_FILLER_REASON
    before, after = _kept_neighbours(project, candidate)
    start, end = plan.start, plan.end
    in_valley = plan.end_in_valley
    if before is not None:
        ceiling = end if wordless else min(end, candidate.start)
        ends = voice_end(audio_cache, before.end, ceiling)
        if ends is None and (wordless or not voice_separates(audio_cache, before.end, end)):
            return CutRejected("kept_voice")
        if ends is not None and ends > before.end:
            # A word cut's own onset edge sits at the start of a quiet frame (#1061),
            # one hop before the voiced-run edge ``voice_end`` reports.
            start = max(start, ends + cut_safety.VOICE_EDGE_PAD_SEC if wordless else ends - HOP_SEC)
    next_burst = plan.next_burst
    if after is not None:
        floor = start if wordless else max(start, candidate.end)
        onset = voice_onset(audio_cache, after.start, floor)
        air = cut_safety.VOICE_EDGE_PAD_SEC if wordless else _onset_guard_sec(defaults)
        valley = False
        if candidate.reason == ACOUSTIC_FILLER_REASON:
            # A hum the transcript missed can decay into a valley that stays over the
            # voice floor, 19 dB deep, 13 dB under the speech level (lab 646.88, #1358):
            # the word's voice does not run back through that. The edge sits in the
            # valley, where the air is, not 60 ms before the word. A sound with several
            # bursts of level before the valley (two syllables, a phrase, "uh-huh"), or a
            # quiet plateau before a louder syllable, may be speech whose own dip this
            # is, so it keeps the word's voice.
            apart = decay_valley_onset(audio_cache, after.start, start)
            if apart is not None:
                onset, air, valley = apart, _onset_guard_sec(defaults), True
        if onset is not None and onset < after.start:
            end = min(end, onset - air)
        # Only an edge that lies in the valley is read as in it: a run that ends in the
        # decay, well before the valley, keeps the plain voiced-edge check. The valley
        # can end at the word start itself, past the run's end (lab 647.285).
        in_valley = in_valley or (
            valley and edge_decays_into_valley(audio_cache, start, end, after.start)
        )
        if valley and in_valley and onset is not None:
            # The mute's fade-in ends at the frame after the valley bottom, not over the
            # word's first syllable (the fade-in cap of a plosive burst).
            next_burst = onset
    if (start, end, in_valley, next_burst) == (
        plan.start,
        plan.end,
        plan.end_in_valley,
        plan.next_burst,
    ):
        return plan
    if end - start + 1e-9 < _cut_minimum_sec(candidate) or (
        candidate.cut_kind != "pause" and not _cut_covers_reparandum(candidate, start, end)
    ):
        return CutRejected("kept_voice")
    return replace(plan, start=start, end=end, end_in_valley=in_valley, next_burst=next_burst)


def _covered_kept_word(
    project: EpisodeProject, candidate: _CutCandidate, start: float, end: float
) -> str | None:
    """The first kept word whose whole span ``[start, end]`` covers, in lexicon form.

    A kept word is any unsuppressed word outside the candidate's own tokens.
    """
    tr = project.transcript_for_source(candidate.track_id, None)
    for w in tr.words if tr else ():
        if w.suppressed or w.end <= w.start:
            continue
        if candidate.start <= w.start and w.end <= candidate.end:
            continue
        if start <= w.start and w.end <= end:
            return lexicon_form(w.text) or w.text
    return None


def _accept_nudge(
    candidate: _CutCandidate, before: tuple[float, float], start: float, end: float
) -> tuple[float, float] | None:
    """``(start, end)`` when the nudged span is one this candidate may still propose."""
    if (
        abs(start - before[0]) > cut_safety.EDGE_NUDGE_MAX_SEC
        or abs(end - before[1]) > cut_safety.EDGE_NUDGE_MAX_SEC
    ):
        return None
    if _clamp_to_candidate(candidate, start, end) != (start, end):
        return None
    if end - start < _MIN_NUDGED_CUT_SEC:
        return None
    if candidate.cut_kind != "pause" and not _cut_covers_reparandum(candidate, start, end):
        return None
    return start, end
