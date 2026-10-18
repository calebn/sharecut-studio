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

import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from podcast_mcp.config import load_defaults
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
OWN_ENERGY_MIN_SEC = 0.05
OWN_ENERGY_PAD_SEC = 0.06
# This track is audible, so there is something to mute, over its room by this much.
AUDIBLE_OVER_ROOM_DB = 6.0
# The other speaker is loud enough to leave a measurable copy within this of their speech.
LOUD_UNDER_SPEECH_DB = 12.0
# Leak ratio from this percentile of (this track - other speaker): own sound only raises it.
LEAK_PERCENTILE = 40.0
MIN_LEAK_SEC = 1.0
MIN_REGION_SEC = 0.15


@dataclass
class OffSpeakerPlan:
    track_id: str
    regions: list[dict[str, Any]] = field(default_factory=list)
    leak_ratio_db: float | None = None
    refusal: str | None = None
    kept_own_word_sec: float = 0.0
    kept_own_energy_sec: float = 0.0
    already_quiet_sec: float = 0.0

    @property
    def muted_sec(self) -> float:
        return round(sum(r["duration"] for r in self.regions), 3)

    def summary(self) -> dict[str, Any]:
        return {
            "track_id": self.track_id,
            "region_count": len(self.regions),
            "muted_sec": self.muted_sec,
            "leak_ratio_db": self.leak_ratio_db,
            "kept_own_word_sec": round(self.kept_own_word_sec, 3),
            "kept_own_energy_sec": round(self.kept_own_energy_sec, 3),
            "already_quiet_sec": round(self.already_quiet_sec, 3),
            "refusal": self.refusal,
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


def plan_from_evidence(
    track_id: str,
    levels: np.ndarray,
    profile: LevelProfile,
    own_words: list[tuple[float, float]],
    peers: list[PeerEvidence],
) -> OffSpeakerPlan:
    """The off-speaker mute plan from one track's levels, words and its peers' (all 10 ms frames)."""
    plan = OffSpeakerPlan(track_id)
    n = levels.size
    peer_spans = _merge([w for p in peers for w in p.words], PEER_MERGE_GAP_SEC)
    peer_mask = _mask(peer_spans, n, PEER_PAD_SEC)
    own_word_mask = _mask(own_words, n, OWN_WORD_PAD_SEC)
    candidate = peer_mask & ~own_word_mask
    plan.kept_own_word_sec = float((peer_mask & own_word_mask).sum()) * LEVEL_FRAME_SEC
    if not candidate.any():
        return plan

    audible = levels > profile.room_db + AUDIBLE_OVER_ROOM_DB
    peer_level = np.full(n, -np.inf)
    loud = np.zeros(n, dtype=bool)
    for p in peers:
        m = min(n, p.levels.size)
        speaking = _mask(p.words, n, PEER_PAD_SEC)[:m]
        lv = np.maximum(p.levels[:m], p.profile.room_db)
        peer_level[:m] = np.where(speaking, np.maximum(peer_level[:m], lv), peer_level[:m])
        loud[:m] |= speaking & (p.levels[:m] > p.profile.speech_db - LOUD_UNDER_SPEECH_DB)

    sample = candidate & audible & loud & np.isfinite(peer_level)
    if sample.sum() * LEVEL_FRAME_SEC < MIN_LEAK_SEC:
        plan.already_quiet_sec = float((candidate & ~audible).sum()) * LEVEL_FRAME_SEC
        if (candidate & audible).any():
            plan.refusal = "no_leak_evidence"
        return plan
    leak = float(np.percentile((levels - peer_level)[sample], LEAK_PERCENTILE))
    plan.leak_ratio_db = round(leak, 1)

    own_energy = (
        candidate
        & audible
        & np.isfinite(peer_level)
        & (levels > peer_level + leak + OWN_OVER_LEAK_DB)
    )
    keep = np.zeros(n, dtype=bool)
    for lo, hi in _runs(own_energy):
        if hi - lo >= _frames(OWN_ENERGY_MIN_SEC):
            keep[lo:hi] = True
    keep = _dilate(keep, _frames(OWN_ENERGY_PAD_SEC))
    plan.kept_own_energy_sec = float((candidate & keep).sum()) * LEVEL_FRAME_SEC

    mute = candidate & ~keep
    for lo, hi in _runs(mute):
        seg_audible = audible[lo:hi]
        duration = (hi - lo) * LEVEL_FRAME_SEC
        if not seg_audible.any():
            plan.already_quiet_sec += duration
            continue
        if duration < MIN_REGION_SEC:
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
                "audible_sec": round(float(seg_audible.sum()) * LEVEL_FRAME_SEC, 3),
            }
        )
    return plan


def _timeline_levels(
    project: EpisodeProject, track_id: str, scratch: Path
) -> tuple[np.ndarray, LevelProfile] | None:
    """10 ms levels of ``track_id`` on the timeline clock, before any bleed gate."""
    track = project.track_by_id(track_id)
    if track is None or track.media is None:
        return None
    ungated = project.model_copy(deep=True)
    ungated_track = ungated.track_by_id(track_id)
    assert ungated_track is not None
    ungated_track.transcript_gate = False
    out = scratch / f"{track_id}.wav"
    render_track_from_timeline(ungated, ungated_track, out, load_defaults())
    samples = load_mono_full(out, sample_rate=_SAMPLE_RATE)
    levels = frame_levels_db(samples, _SAMPLE_RATE)
    return levels, track_profile(samples, _SAMPLE_RATE)


def plan_off_speaker_mutes(project: EpisodeProject, track_id: str) -> OffSpeakerPlan:
    """The stretches of ``track_id`` where only another speaker is talking."""
    if project.track_by_id(track_id) is None:
        raise ValueError(f"unknown track {track_id!r}")
    others = [t for t in dialogue_track_ids(project) if t != track_id]
    plan = OffSpeakerPlan(track_id)
    if not others:
        plan.refusal = "no_other_dialogue_track"
        return plan
    with tempfile.TemporaryDirectory(prefix="offspk-") as tmp:
        scratch = Path(tmp)
        mine = _timeline_levels(project, track_id, scratch)
        if mine is None:
            plan.refusal = "track_has_no_audio"
            return plan
        levels, profile = mine
        duration = levels.size * LEVEL_FRAME_SEC
        peers: list[PeerEvidence] = []
        for pid in others:
            words = word_intervals(project, pid, 0.0, duration, merge_gap_sec=0.0)
            theirs = _timeline_levels(project, pid, scratch) if words else None
            if theirs is not None:
                peers.append(PeerEvidence(pid, theirs[0], theirs[1], words))
    own_words = word_intervals(project, track_id, 0.0, duration, merge_gap_sec=0.0)
    if not peers:
        plan.refusal = "no_peer_speech"
        return plan
    return plan_from_evidence(track_id, levels, profile, own_words, peers)


def apply_off_speaker_mutes(project: EpisodeProject, plan: OffSpeakerPlan) -> dict[str, Any]:
    """Mute ``plan``'s regions as exact-range edits; a region the safety checks hold stays open.

    One batch, so History undoes the command whole; each region is its own archived edit,
    so Studio shows it as a muted region and Restore brings it back alone.
    """
    from uuid import uuid4

    from podcast_mcp.edits.cut_application import apply_ranges
    from podcast_mcp.edits.range_edits import build_range_target
    from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
    from podcast_mcp.models import EditDecision, EditDecisionType
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
    held: list[dict[str, Any]] = []
    by_id = {e.id: e for e in edits}
    while edits:
        try:
            apply_ranges(project, edits)
            break
        except ScopeChangedAtApproval as exc:
            held_ids = set(exc.ids)
            if not held_ids & {e.id for e in edits}:
                raise
            held.extend(
                {"start": by_id[i].start, "end": by_id[i].end, "reason": h.reason}
                for h in exc.held
                for i in [h.edit_id]
                if i in by_id
            )
            edits = [e for e in edits if e.id not in held_ids]
    return {
        "applied_count": len(edits),
        "applied_sec": round(sum(e.end - e.start for e in edits), 3),
        "held": held,
        "edit_ids": [e.id for e in edits],
    }
