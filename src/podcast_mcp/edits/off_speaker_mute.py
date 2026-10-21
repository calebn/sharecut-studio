"""Mute a track wherever another speaker is talking and this track's own speaker is not (#1740).

On a call recording each person's track also carries the others (bleed). The bleed gate
reduces the copies it can verify; this command is the plainer rule a person applies by ear:
a stretch where another speaker's track has words, this track has none, and this track holds
no sound louder than a copy of that speaker would be, is not this speaker, so it is muted.
The muted stretches are exact-range mute edits, so Studio shows each as a region and History
or Restore brings it back.

Evidence per stretch, all relative to the recordings' own levels (``level_profile``):

* transcript: another dialogue track has an unsuppressed word and this track has none
  within ``OWN_WORD_PAD_SEC`` (a track's quiet words are never judged by level, #1594);
* leak ratio: how far under the other speaker this track sits where it is only a copy,
  measured on this track's own audible frames, so the rule follows the recording's gain;
* own energy: a frame this track holds well over that ratio is its own speaker (an
  untranscribed laugh, a backchannel under the other voice) and stays open.
"""

from __future__ import annotations

import itertools
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.engines.level_profile import (
    LEVEL_FRAME_SEC,
    LevelProfile,
    frame_levels_db,
    track_profile,
)
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.engines.transcript_gated_play import word_intervals
from podcast_mcp.engines.ungated_audio import load_mono_full
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.progress import ProgressReporter, resolve_progress_task
from podcast_mcp.util.tracks import dialogue_track_ids

OFF_SPEAKER_REASON = "bleed_mute:off_speaker"

_SAMPLE_RATE = 16000
# A stretch of another speaker's words is one turn across pauses this short.
PEER_MERGE_GAP_SEC = 0.5
# The other speaker's copy starts and ends a little around their words.
PEER_PAD_SEC = 0.08
# Held open around this track's own words, so a word's onset and tail are never muted.
OWN_WORD_PAD_SEC = 0.12
# A frame is this track's own sound when it is this far over what a copy would be.
OWN_OVER_LEAK_DB = 12.0
# Held open around own-energy runs, which must last this long to count (not a click).
OWN_ENERGY_MIN_SEC = 0.03
OWN_ENERGY_PAD_SEC = 0.06
# This track is audible, so there is something to mute, over its room by this much.
AUDIBLE_OVER_ROOM_DB = 6.0
# The other speaker is loud enough to leave a measurable copy within this of their speech.
LOUD_UNDER_SPEECH_DB = 12.0
# Leak ratio from this percentile of (this track - other speaker): own sound only raises it.
LEAK_PERCENTILE = 40.0
MIN_LEAK_SEC = 1.0
MIN_REGION_SEC = 0.15
MIN_HEARD_SEC = 0.08
DOUBTFUL_WORD_MAX_SEC = 0.6
DOUBTFUL_ISOLATION_SEC = 0.6
COPY_WORD_CORRELATION_MIN = 0.7
COPY_CORRELATION_REVIEW_MIN = 0.5
COPY_WORD_LEVEL_SLACK_DB = 6.0
# A turn's copy is told from this track's own sounds by its envelope following the peer's.
COPY_CORRELATION_MIN = 0.6
COPY_LAG_EARLY_SEC = 0.05
COPY_LAG_LATE_SEC = 0.3
MIN_TURN_SEC = 0.25
AUDIBLE_FOOTPRINT_PAD_SEC = 0.1
ACTIVE_UNDER_SPEECH_DB = 15.0
ACTIVE_MIN_SEC = 0.03
# A gate holds closed across a pause this short inside a turn unless the lane's own voice is in it.
HOLD_CLOSED_SEC = 0.5


@dataclass
class OffSpeakerPlan:
    track_id: str
    regions: list[dict[str, Any]] = field(default_factory=list)
    leak_ratio_db: float | None = None
    refusal: str | None = None
    kept_own_word_sec: float = 0.0
    kept_own_energy_sec: float = 0.0
    already_quiet_sec: float = 0.0
    own_word_overlap_sec: float = 0.0
    kept_uncorrelated_sec: float = 0.0
    kept_gaps: list[dict[str, Any]] = field(default_factory=list)
    still_audible_sec: float = 0.0
    still_audible_copy_sec: float = 0.0
    judged_words: list[dict[str, Any]] = field(default_factory=list)

    @property
    def audible_muted_sec(self) -> float:
        return round(sum(r["audible_sec"] for r in self.regions), 3)

    @property
    def muted_sec(self) -> float:
        return round(sum(r["duration"] for r in self.regions), 3)

    def summary(self) -> dict[str, Any]:
        return {
            "track_id": self.track_id,
            "region_count": len(self.regions),
            "muted_sec": self.muted_sec,
            "audible_muted_sec": self.audible_muted_sec,
            "quiet_muted_sec": round(self.muted_sec - self.audible_muted_sec, 3),
            "own_word_overlap_sec": round(self.own_word_overlap_sec, 3),
            "kept_uncorrelated_sec": round(self.kept_uncorrelated_sec, 3),
            "leak_ratio_db": self.leak_ratio_db,
            "kept_own_word_sec": round(self.kept_own_word_sec, 3),
            "kept_own_energy_sec": round(self.kept_own_energy_sec, 3),
            "already_quiet_sec": round(self.already_quiet_sec, 3),
            "refusal": self.refusal,
            "still_audible_sec": round(self.still_audible_sec, 3),
            "still_audible_copy_sec": round(self.still_audible_copy_sec, 3),
            "judged_words": self.judged_words,
            "kept_gaps": self.kept_gaps,
            "regions": self.regions,
        }


@dataclass(frozen=True)
class PeerEvidence:
    track_id: str
    levels: np.ndarray
    profile: LevelProfile
    words: list[tuple[float, float]]


def _frames(sec: float) -> int:
    return max(0, round(sec / LEVEL_FRAME_SEC))


def _mask(spans: list[tuple[float, float]], n: int, pad_sec: float = 0.0) -> np.ndarray:
    out = np.zeros(n, dtype=bool)
    for a, b in spans:
        lo = max(0, _frames(a - pad_sec))
        hi = min(n, _frames(b + pad_sec))
        if hi > lo:
            out[lo:hi] = True
    return out


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    if not mask.any():
        return []
    padded = np.concatenate(([False], mask, [False]))
    edges = np.flatnonzero(padded[1:] != padded[:-1])
    return [(int(a), int(b)) for a, b in zip(edges[::2], edges[1::2], strict=True)]


def _dilate(mask: np.ndarray, frames: int) -> np.ndarray:
    out = mask.copy()
    for lo, hi in _runs(mask):
        out[max(0, lo - frames) : min(mask.size, hi + frames)] = True
    return out


def _merge(spans: list[tuple[float, float]], gap: float) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for a, b in sorted(spans):
        if out and a <= out[-1][1] + gap:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def _envelope_copy(mine: np.ndarray, theirs: np.ndarray, idx: np.ndarray) -> tuple[float, int]:
    """Best correlation of this track's level envelope with the peer's at ``idx`` (and its lag, frames).

    A copy of the peer's voice rises and falls with it, a little later; a breath or a laugh
    of this track's own speaker does not. Lags run from slightly early to a room's delay.
    """
    best = (-1.0, 0)
    x_all = mine
    for lag in range(-_frames(COPY_LAG_EARLY_SEC), _frames(COPY_LAG_LATE_SEC) + 1):
        j = idx + lag
        ok = (j >= 0) & (j < theirs.size)
        if ok.sum() < _frames(MIN_TURN_SEC):
            continue
        x = x_all[idx[ok]]
        y = theirs[j[ok]]
        if np.ptp(x) <= 0 or np.ptp(y) <= 0:
            continue
        r = float(np.corrcoef(x, y)[0, 1])
        if r > best[0]:
            best = (r, lag)
    return best


def _active_spans(p: PeerEvidence) -> list[tuple[float, float]]:
    """Seconds where the peer's own track sounds at speech level, word or not (a clap, a laugh)."""
    loud = p.levels > p.profile.speech_db - ACTIVE_UNDER_SPEECH_DB
    return [
        (lo * LEVEL_FRAME_SEC, hi * LEVEL_FRAME_SEC)
        for lo, hi in _runs(loud)
        if hi - lo >= _frames(ACTIVE_MIN_SEC)
    ]


def _peer_turns(peers: list[PeerEvidence]) -> list[tuple[float, float]]:
    """Turns of the other speakers: their words, held together across pauses and loud non-word sounds.

    A sound on the peer's track counts only when it joins a turn that has words, so a peer
    that is loud for another reason never opens a turn alone.
    """
    words = [w for p in peers for w in p.words]
    active = [a for p in peers for a in _active_spans(p)]
    turns = _merge(words + active, PEER_MERGE_GAP_SEC)
    return [t for t in turns if any(a < t[1] and b > t[0] for a, b in words)]


def _judge_doubtful_words(
    own_words: list[tuple[float, float]],
    levels: np.ndarray,
    mine: np.ndarray,
    theirs: np.ndarray,
    peer_level: np.ndarray,
    peer_mask: np.ndarray,
    leak: float,
) -> list[dict[str, Any]]:
    """Judge from the audio each short, isolated own word inside another speaker's turn.

    Reconcile can leave a one-word fragment of the other speaker unsuppressed between words it
    did suppress. Such a word is a copy when this track's envelope follows the other speaker's
    around it and it is no louder than a copy would be; ``review`` when only one of the two
    holds, so a person can listen; otherwise it is the speaker's own and stays.
    """
    out = []
    ordered = sorted(own_words)
    for i, (a, b) in enumerate(ordered):
        before = ordered[i - 1][1] if i else -np.inf
        after = ordered[i + 1][0] if i + 1 < len(ordered) else np.inf
        lo, hi = _frames(a), min(levels.size, _frames(b))
        if (
            b - a > DOUBTFUL_WORD_MAX_SEC
            or a - before < DOUBTFUL_ISOLATION_SEC
            or after - b < DOUBTFUL_ISOLATION_SEC
            or hi <= lo
            or peer_mask[lo:hi].mean() < 0.8
        ):
            continue
        ctx = np.zeros(levels.size, dtype=bool)
        ctx[max(0, lo - _frames(0.4)) : hi + _frames(0.4)] = True
        ctx &= peer_mask
        r, _ = _envelope_copy(mine, theirs, np.flatnonzero(ctx))
        seen = np.isfinite(peer_level[lo:hi])
        ratio = float(np.median((levels[lo:hi] - peer_level[lo:hi])[seen])) if seen.any() else None
        quiet_enough = ratio is not None and ratio <= leak + COPY_WORD_LEVEL_SLACK_DB
        if r >= COPY_WORD_CORRELATION_MIN and quiet_enough:
            verdict = "copy"
        elif r >= COPY_CORRELATION_REVIEW_MIN or quiet_enough:
            verdict = "review"
        else:
            verdict = "own"
        out.append(
            {
                "start": a,
                "end": b,
                "verdict": verdict,
                "correlation": round(r, 2),
                "level_over_peer_db": None if ratio is None else round(ratio, 1),
                "over_copy_db": None if ratio is None else round(ratio - leak, 1),
            }
        )
    return out


def plan_from_evidence(
    track_id: str,
    levels: np.ndarray,
    profile: LevelProfile,
    own_words: list[tuple[float, float]],
    peers: list[PeerEvidence],
    rendered: np.ndarray | None = None,
    _judged: list[dict[str, Any]] | None = None,
) -> OffSpeakerPlan:
    """The off-speaker mute plan from one track's levels, words and its peers' (all 10 ms frames).

    ``levels`` are the track before any mute (the evidence); ``rendered`` is what plays now,
    so a stretch an earlier run silenced is neither written again nor counted as still audible.
    """
    plan = OffSpeakerPlan(track_id)
    n = levels.size
    peer_spans = _peer_turns(peers)
    own_word_mask = _mask(own_words, n, OWN_WORD_PAD_SEC)
    peer_mask = _mask(peer_spans, n, PEER_PAD_SEC)
    candidate = peer_mask & ~own_word_mask
    plan.kept_own_word_sec = float((peer_mask & own_word_mask).sum()) * LEVEL_FRAME_SEC
    if not candidate.any():
        return plan

    audible = levels > profile.room_db + AUDIBLE_OVER_ROOM_DB
    heard_now = audible
    if rendered is not None:
        heard_now = np.zeros(n, dtype=bool)
        m = min(n, rendered.size)
        heard_now[:m] = rendered[:m] > profile.room_db + AUDIBLE_OVER_ROOM_DB
    mine = np.maximum(levels - profile.room_db, 0.0)
    theirs = np.zeros(n)
    peer_level = np.full(n, -np.inf)
    loud = np.zeros(n, dtype=bool)
    for p in peers:
        m = min(n, p.levels.size)
        speaking = _mask([*p.words, *_active_spans(p)], n, PEER_PAD_SEC)[:m]
        lv = np.maximum(p.levels[:m], p.profile.room_db)
        theirs[:m] = np.where(speaking, np.maximum(theirs[:m], lv - p.profile.room_db), theirs[:m])
        peer_level[:m] = np.where(speaking, np.maximum(peer_level[:m], lv), peer_level[:m])
        loud[:m] |= speaking & (p.levels[:m] > p.profile.speech_db - LOUD_UNDER_SPEECH_DB)

    confirmed = np.zeros(n, dtype=bool)
    uncorrelated_sec = 0.0
    for a, b in peer_spans:
        lo, hi = max(0, _frames(a - PEER_PAD_SEC)), min(n, _frames(b + PEER_PAD_SEC))
        turn = np.zeros(n, dtype=bool)
        turn[lo:hi] = True
        turn &= candidate
        heard = turn & audible
        if heard.sum() < _frames(MIN_REGION_SEC):
            plan.already_quiet_sec += float(turn.sum()) * LEVEL_FRAME_SEC
            continue
        r, _lag = _envelope_copy(mine, theirs, np.flatnonzero(turn))
        if r >= COPY_CORRELATION_MIN:
            confirmed |= turn
        else:
            uncorrelated_sec += float(heard.sum()) * LEVEL_FRAME_SEC
    plan.kept_uncorrelated_sec = uncorrelated_sec
    if not confirmed.any():
        if uncorrelated_sec > 0:
            plan.refusal = "no_copy_evidence"
        return plan

    sample = confirmed & audible & loud & np.isfinite(peer_level)
    if sample.sum() * LEVEL_FRAME_SEC < MIN_LEAK_SEC:
        plan.refusal = "no_leak_evidence"
        return plan
    leak = float(np.percentile((levels - peer_level)[sample], LEAK_PERCENTILE))
    plan.leak_ratio_db = round(leak, 1)

    if _judged is None:
        judged = _judge_doubtful_words(own_words, levels, mine, theirs, peer_level, peer_mask, leak)
        released = [j for j in judged if j["verdict"] == "copy"]
        if released:
            gone = {(j["start"], j["end"]) for j in released}
            again = plan_from_evidence(
                track_id,
                levels,
                profile,
                [w for w in own_words if w not in gone],
                peers,
                rendered,
                _judged=judged,
            )
            return again
        plan.judged_words = judged
    else:
        plan.judged_words = _judged

    # Where the other speaker is silent (a pause inside their turn) there is no copy to compare
    # with, so any sound on this lane there is its own.
    own_energy = (
        confirmed
        & audible
        & (~np.isfinite(peer_level) | (levels > peer_level + leak + OWN_OVER_LEAK_DB))
    )
    keep = np.zeros(n, dtype=bool)
    for lo, hi in _runs(own_energy):
        if hi - lo >= _frames(OWN_ENERGY_MIN_SEC):
            keep[lo:hi] = True
    keep = _dilate(keep, _frames(OWN_ENERGY_PAD_SEC))
    plan.kept_own_energy_sec = float((confirmed & keep).sum()) * LEVEL_FRAME_SEC

    # Only where the track sounds: a silent gap between two copies needs no region.
    closable = confirmed & ~keep
    mute = closable & _dilate(heard_now, _frames(AUDIBLE_FOOTPRINT_PAD_SEC))
    runs = _runs(mute)
    for (_, prev_hi), (next_lo, _) in itertools.pairwise(runs):
        if next_lo - prev_hi <= _frames(HOLD_CLOSED_SEC) and closable[prev_hi:next_lo].all():
            mute[prev_hi:next_lo] = True
    runs = _runs(mute)
    plan.still_audible_sec = float((candidate & heard_now & ~mute).sum()) * LEVEL_FRAME_SEC
    plan.still_audible_copy_sec = (
        float((confirmed & heard_now & ~mute & ~keep).sum()) * LEVEL_FRAME_SEC
    )
    plan.kept_gaps = _kept_gaps(
        runs, candidate, confirmed, keep, own_word_mask, peer_mask, heard_now, n
    )
    for lo, hi in runs:
        duration = (hi - lo) * LEVEL_FRAME_SEC
        # The fades an earlier mute leaves at its edges are not sound worth another region.
        if duration < MIN_REGION_SEC or heard_now[lo:hi].sum() < _frames(MIN_HEARD_SEC):
            continue
        start, end = lo * LEVEL_FRAME_SEC, hi * LEVEL_FRAME_SEC
        plan.regions.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "duration": round(end - start, 3),
                "peer_tracks": sorted(
                    p.track_id for p in peers if any(a < end and b > start for a, b in p.words)
                ),
                "audible_sec": round(float(heard_now[lo:hi].sum()) * LEVEL_FRAME_SEC, 3),
                "peak_db": round(float(levels[lo:hi].max()), 1),
            }
        )
    return plan


def _kept_gaps(
    runs: list[tuple[int, int]],
    candidate: np.ndarray,
    confirmed: np.ndarray,
    keep: np.ndarray,
    own_word_mask: np.ndarray,
    peer_mask: np.ndarray,
    audible: np.ndarray,
    n: int,
) -> list[dict[str, Any]]:
    """Each audible stretch left open between two muted regions under a second apart, and why."""
    gaps = []
    for (_, prev_hi), (next_lo, _) in itertools.pairwise(runs):
        if next_lo - prev_hi > _frames(1.0) or not audible[prev_hi:next_lo].any():
            continue
        span = slice(prev_hi, next_lo)
        if own_word_mask[span].any():
            reason = "own_word"
        elif keep[span].any():
            reason = "own_energy"
        elif not peer_mask[span].any():
            reason = "other_speaker_silent"
        elif not confirmed[span].all():
            reason = "no_copy_evidence"
        else:
            reason = "short_region"
        gaps.append(
            {
                "start": round(prev_hi * LEVEL_FRAME_SEC, 3),
                "end": round(next_lo * LEVEL_FRAME_SEC, 3),
                "reason": reason,
            }
        )
    return gaps[:200]


def _timeline_levels(
    project: EpisodeProject,
    track_id: str,
    scratch: Path,
    *,
    unmuted: bool = True,
    defaults: EffectiveConfig,
) -> tuple[np.ndarray, LevelProfile] | None:
    """10 ms levels of ``track_id`` on the timeline clock, before any bleed gate.

    ``unmuted`` also drops the clips' mute regions: the evidence for a copy is the copy,
    which an earlier run of this command has already silenced in the rendered track.
    """
    track = project.track_by_id(track_id)
    if track is None or track.media is None:
        return None
    ungated = project.model_copy(deep=True)
    ungated_track = ungated.track_by_id(track_id)
    assert ungated_track is not None
    if unmuted:
        ungated_track.transcript_gate = False
        for clip in ungated.clips:
            if clip.track_id == track_id:
                clip.mute_regions = []
                clip.off_speaker_mute_regions = []
    out = scratch / f"{track_id}-{'unmuted' if unmuted else 'played'}.wav"
    render_track_from_timeline(ungated, ungated_track, out, defaults)
    samples = load_mono_full(out, sample_rate=_SAMPLE_RATE)
    levels = frame_levels_db(samples, _SAMPLE_RATE)
    return levels, track_profile(samples, _SAMPLE_RATE)


def plan_off_speaker_mutes(
    project: EpisodeProject,
    track_id: str,
    *,
    progress: ProgressReporter | None = None,
    defaults: EffectiveConfig,
) -> OffSpeakerPlan:
    """The stretches of ``track_id`` where only another speaker is talking."""
    if project.track_by_id(track_id) is None:
        raise CodedValueError(
            f"unknown track {track_id!r}. List the project's tracks and pick one of them.",
            code="track_not_found",
        )
    others = [t for t in dialogue_track_ids(project) if t != track_id]
    plan = OffSpeakerPlan(track_id)
    if not others:
        plan.refusal = "no_other_dialogue_track"
        return plan
    with (
        resolve_progress_task(
            "mute-off-speaker",
            "Find off-speaker copies",
            total=len(others) + 1,
            prefer_parent=True,
            progress=progress,
        ) as task,
        tempfile.TemporaryDirectory(prefix="offspk-") as tmp,
    ):
        scratch = Path(tmp)
        mine = _timeline_levels(project, track_id, scratch, defaults=defaults)
        task.advance(1, total=len(others) + 1)
        if mine is None:
            plan.refusal = "track_has_no_audio"
            return plan
        levels, profile = mine
        shown = _timeline_levels(project, track_id, scratch, unmuted=False, defaults=defaults)
        rendered = shown[0] if shown is not None else None
        duration = levels.size * LEVEL_FRAME_SEC
        peers: list[PeerEvidence] = []
        for pid in others:
            words = word_intervals(project, pid, 0.0, duration, merge_gap_sec=0.0)
            theirs = _timeline_levels(project, pid, scratch, defaults=defaults) if words else None
            if theirs is not None:
                peers.append(PeerEvidence(pid, theirs[0], theirs[1], words))
            task.advance(1, total=len(others) + 1)
    own_words = word_intervals(project, track_id, 0.0, duration, merge_gap_sec=0.0)
    if not peers:
        plan.refusal = "no_peer_speech"
        return plan
    plan = plan_from_evidence(track_id, levels, profile, own_words, peers, rendered)
    released = {(j["start"], j["end"]) for j in plan.judged_words if j["verdict"] == "copy"}
    plan.own_word_overlap_sec = _overlap_sec(
        [w for w in own_words if w not in released], plan.regions
    )
    _name_judged_words(project, track_id, plan)
    _name_holding_words(project, track_id, plan)
    return plan


def _name_judged_words(project: EpisodeProject, track_id: str, plan: OffSpeakerPlan) -> None:
    """Put each judged word's text and source times beside its timeline span."""
    if not plan.judged_words:
        return
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.util.timebase import SourceSec

    transcript = project.transcript_for_track(track_id)
    if transcript is None:
        return
    words = [w for w in transcript.words if not w.suppressed]
    mapped = SessionTimeline(project).map_source_spans(
        track_id, [(SourceSec(w.start), SourceSec(w.end)) for w in words]
    )
    for judged in plan.judged_words:
        for w, spans in zip(words, mapped, strict=True):
            if any(
                abs(float(a) - judged["start"]) < 0.005 and abs(float(b) - judged["end"]) < 0.005
                for a, b in spans
            ):
                judged["text"] = w.text
                judged["source"] = [w.start, w.end]
                break


def _name_holding_words(project: EpisodeProject, track_id: str, plan: OffSpeakerPlan) -> None:
    """Name, in each kept gap held by an own word, the words whose padding reaches it."""
    if not any(g["reason"] == "own_word" for g in plan.kept_gaps):
        return
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.util.timebase import SourceSec

    transcript = project.transcript_for_track(track_id)
    if transcript is None:
        return
    words = [w for w in transcript.words if not w.suppressed]
    mapped = SessionTimeline(project).map_source_spans(
        track_id, [(SourceSec(w.start), SourceSec(w.end)) for w in words]
    )
    for gap in plan.kept_gaps:
        if gap["reason"] != "own_word":
            continue
        gap["words"] = [
            {
                "text": w.text,
                "source": [w.start, w.end],
                "timeline": [round(float(a), 3), round(float(b), 3)],
            }
            for w, spans in zip(words, mapped, strict=True)
            for a, b in spans
            if a - OWN_WORD_PAD_SEC < gap["end"] and b + OWN_WORD_PAD_SEC > gap["start"]
        ][:6]


def _overlap_sec(words: list[tuple[float, float]], regions: list[dict[str, Any]]) -> float:
    """Seconds of the track's own words (timeline clock) a region covers: the self-check, 0 when sound."""
    return sum(max(0.0, min(b, r["end"]) - max(a, r["start"])) for a, b in words for r in regions)


def apply_off_speaker_mutes(
    project: EpisodeProject, plan: OffSpeakerPlan, *, defaults: EffectiveConfig
) -> dict[str, Any]:
    """Mute ``plan``'s regions as exact-range edits; a region the safety checks hold stays open.

    One batch, so History undoes the command whole; each region is its own archived edit,
    so Studio shows it as a muted region and Restore brings it back alone.
    """
    from uuid import uuid4

    from podcast_mcp.edits.cut_application import apply_ranges
    from podcast_mcp.edits.off_speaker_regions import MuteOwnership
    from podcast_mcp.edits.range_target import build_range_target
    from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
    from podcast_mcp.engines.session_timeline import clip_timeline_overlap_to_source
    from podcast_mcp.models import (
        ClipOffSpeakerMuteRegion,
        CutIntent,
        EditDecision,
        EditDecisionType,
    )
    from podcast_mcp.models.episode import RangeInterval

    edits: list[EditDecision] = []
    for region in plan.regions:
        target = build_range_target(
            project,
            [RangeInterval(start=region["start"], end=region["end"])],
            [plan.track_id],
        )
        if not target.clips:
            continue
        if all(
            ClipOffSpeakerMuteRegion(start_s=bounds[0], end_s=bounds[1])
            in clip.off_speaker_mute_regions
            for clip in target.clips
            for interval in target.intervals
            if (bounds := clip_timeline_overlap_to_source(clip, interval.start, interval.end))
            is not None
        ):
            continue
        edits.append(
            EditDecision(
                id=f"offspk_{uuid4().hex[:10]}",
                track_id="",
                track_ids=target.track_ids,
                type=EditDecisionType.MUTE,
                start=region["start"],
                end=region["end"],
                timebase="timeline",
                scope="selected_tracks",
                review_required=False,
                applied=False,
                reason=OFF_SPEAKER_REASON,
                exact_range=target,
            )
        )
    held: dict[str, dict[str, Any]] = {}
    by_id = {e.id: e for e in edits}
    while edits:
        try:
            # The plan's own audio evidence (copy envelope, leak ratio, own-energy check)
            # is the audio check, so its chosen edges stand; scope and geometry holds still hold.
            apply_ranges(
                project,
                edits,
                application_intent=CutIntent.HUMAN_BOUNDARIES,
                mute_ownership=MuteOwnership.OFF_SPEAKER,
                defaults=defaults,
            )
            break
        except ScopeChangedAtApproval as exc:
            held_ids = set(exc.ids) & {e.id for e in edits}
            if not held_ids:
                raise
            for hold in exc.held:
                if hold.edit_id in held_ids:
                    edit = by_id[hold.edit_id]
                    held.setdefault(
                        hold.edit_id,
                        {
                            "start": edit.start,
                            "end": edit.end,
                            "reason": hold.reason,
                            **({"detail": hold.detail} if hold.detail else {}),
                        },
                    )
            edits = [e for e in edits if e.id not in held_ids]
    held_rows = sorted(held.values(), key=lambda row: row["start"])
    return {
        "applied_count": len(edits),
        "applied_sec": round(sum(e.end - e.start for e in edits), 3),
        "held_count": len(held_rows),
        "held_sec": round(sum(row["end"] - row["start"] for row in held_rows), 3),
        "held": held_rows,
    }
