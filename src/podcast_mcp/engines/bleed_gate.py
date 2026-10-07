from __future__ import annotations

import json
import math
import wave
from contextlib import suppress
from dataclasses import dataclass
from functools import cached_property, lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from podcast_mcp.engines.audio_audit import AnalysisPolicy, BleedHandling, BleedReduction
from podcast_mcp.engines.copy_timbre import (
    LIKENESS_FRAMES,
    LIKENESS_PERCENTILE,
    TIMBRE_BAND_HZ,
    TIMBRE_SMOOTH_BINS,
    copy_likeness,
    copy_similarity,
)
from podcast_mcp.engines.envelope_lag import (
    CONTOUR_SEC,
    COPY_FRAME_SEC,
    COPY_HOP_SEC,
    FULL_COPY_SEC,
    LEVEL_FLOOR_DB,
    MAX_COPY_LAG_SEC,
    MIN_COPY_SEC,
    MIN_CORRELATION,
    MIN_NULL_MARGIN,
    NULL_SHIFTS_SEC,
    PEER_OPEN_DB,
    copy_lag,
    copy_levels_db,
)
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    clip_source_to_timeline_shift,
    clip_timeline_overlap_to_source,
)
from podcast_mcp.engines.ungated_audio import raw_evidence_layout_reason, raw_timeline_samples
from podcast_mcp.models import EpisodeProject, TranscriptGateScope, TranscriptWord
from podcast_mcp.util.dsp import bool_runs, bridge_short_dips, frame_rms_db_stream
from podcast_mcp.util.intervals import (
    HalfOpenIntervalIndex,
    intersect_intervals,
    merge_intervals,
    subtract_intervals,
)
from podcast_mcp.util.process import CalledProcessError
from podcast_mcp.util.project_state import file_revision
from podcast_mcp.util.timebase import SourceSec, TimelineSec
from podcast_mcp.util.tracks import dialogue_track_ids, track_audio_path

BLEED_GATE_REV = 13
EVIDENCE_RATE = 8000
# Gain ramps inside each reduced span, after a hold at full level around the lane's
# own speech. On the lab tape (#945) the level just outside Caleb's reduced spans is
# his own onsets and tails until the hold covers them, then his mic's bed. With
# forced-aligner word times it reads -42 dBFS with no hold, -48 dBFS at 40 ms
# before and after, and reaches its -57 dBFS power mean beside the copies at 40 ms
# before and 80 ms after, where longer holds leave it. Whisper's looser word times
# reach it at 20/40 ms. So the hold is 40 ms before and 80 ms after, which also
# covers plosive bursts (#978).
# It keeps the copy at full level for 10 s of Audra's 280 s of speech, half what
# 80/150 ms would. The 20 ms ramp is the editor's recommended join fade: long enough
# not to click, short enough to keep the copy out.
GATE_FADE_SEC = 0.02
_ONSET_HOLD_SEC = 0.04
_TAIL_HOLD_SEC = 0.08
_LEVEL_FRAME_SEC = COPY_FRAME_SEC
# ``auto`` attenuates only a lane whose bed would still be heard once turned down:
# its median level away from its own speech and the peers' copies, less
# bleed_attenuation_db, must stay above the evidence level floor (-90 dB, about one
# 16-bit step). Below it, attenuating leaves digital silence where the bed was, so
# muting changes nothing audible and keeps no echo. A call app's gated track sits at
# that floor most of the time, so its median is the floor.
_AUDIBLE_BED_DB = LEVEL_FLOOR_DB
_COPY_HOLD_SEC = 0.05
_ONSET_REACH_SEC = 0.2
_OWN_MARGIN_DB = 4.0
_OWN_HOLD_MARGIN_DB = 2.0
_MIN_OWN_SEC = 0.05
_SPREAD_PERCENTILE = 95
_TIMBRE_WINDOW_SEC = 0.2
_OWNER_FRAME_SEC = 0.02
_OWNER_HOP_SEC = COPY_HOP_SEC
_OWNER_FLOOR_DB = -80.0
_OWNER_FLOOR_PERCENTILE = 10
_OWNER_FLOOR_MARGIN_DB = 6
_OWNER_BRIDGE_FRAMES = 15
# ffmpeg's stereo to mono matrix: each channel at -3 dB.
_STEREO_MONO_GAIN = np.float32(math.sqrt(0.5))
# Channels that differ by less than this, in every frame that carries sound, are one
# signal. A channel at 1 - r of the other reads (1 - r / 2) as loud on the two-channel
# mixdown, so the own-versus-copy excess shifts by 20 log10(1 - r / 2). Half the own
# margin is the most a shift may cost before it can flip a verdict, which gives
# r = 2 (1 - 10 ** (-margin / 40)): 0.41, the channel gap 7.7 dB under the loudest one.
_SAME_SIGNAL_GAP_DB = 20 * math.log10(2 * (1 - 10 ** (-_OWN_MARGIN_DB / 40)))
# A codec quantises a transform block at once, so its noise follows the block's level
# and lands in every frame the block covers, including the quiet ones either side of a
# sound (#1159). The longest block in podcast delivery is AAC-LC's 2048-sample window:
# 43 ms at 48 kHz. Opus frames run 20 ms, up to 60 ms.
_CODEC_REACH_SEC = 0.05
_ONSET_REACH = round(_ONSET_REACH_SEC / _OWNER_HOP_SEC)


@dataclass(frozen=True)
class BleedGatePlan:
    attenuation_spans: tuple[tuple[float, float], ...] = ()
    protected_spans: tuple[tuple[float, float], ...] = ()
    reasons: tuple[str, ...] = ()
    fade_sec: float = GATE_FADE_SEC
    reduction: BleedReduction = "mute"
    attenuation_db: float = AnalysisPolicy.bleed_attenuation_db
    bed_db: float | None = None
    """The lane's median level away from its own speech and the copies; ``auto`` reads it."""

    @property
    def floor_gain(self) -> float:
        return 0.0 if self.reduction == "mute" else 10 ** (-self.attenuation_db / 20)

    @cached_property
    def _attenuation_index(self) -> HalfOpenIntervalIndex:
        return HalfOpenIntervalIndex.build(self.attenuation_spans)

    def gains_for_frames(self, first_frame: int, count: int, rate: int) -> np.ndarray:
        """Gain on the absolute clock, with transitions inside justified attenuation."""
        gains = np.ones(count, dtype=np.float32)
        floor = self.floor_gain
        overlapping = self._attenuation_index.overlapping_ordinals(
            first_frame / rate, (first_frame + count) / rate
        )
        if not overlapping:
            return gains
        positions = np.arange(first_frame, first_frame + count)
        for ordinal in overlapping:
            start, end = self.attenuation_spans[ordinal]
            lo, hi = math.ceil(start * rate), math.ceil(end * rate)
            width = min(round(self.fade_sec * rate), (hi - lo) // 2)
            selected = (positions >= lo) & (positions < hi)
            values = np.full(count, floor, dtype=np.float32)
            if width:
                ramp = np.maximum(
                    np.clip((lo + width - positions) / width, 0, 1),
                    np.clip((positions - (hi - width - 1)) / width, 0, 1),
                )
                values = (floor + (1 - floor) * ramp).astype(np.float32)
            gains[selected] = np.minimum(gains[selected], values[selected])
        return gains


@dataclass(frozen=True)
class BleedWordMapping:
    source_id: str | None
    word: TranscriptWord
    spans: tuple[tuple[TimelineSec, TimelineSec], ...]
    boundary_spans: tuple[tuple[TimelineSec, TimelineSec], ...]

    @property
    def is_candidate(self) -> bool:
        word = self.word
        return bool(
            word.suppressed
            and word.audibility_status == "bleed"
            and word.dominant_track
            and word.end > word.start
            and not word.ignored
            and not word.audibility_locked
            and self.spans
        )


@dataclass(frozen=True)
class BleedGateGeometry:
    words: tuple[BleedWordMapping, ...]
    untranscribed_spans: tuple[tuple[float, float], ...]


def bleed_gate_geometry(project: EpisodeProject, track_id: str) -> BleedGateGeometry:
    """Map eligibility and protection metadata through selected recordings only."""
    timeline = SessionTimeline(project)
    placements = timeline.lane_clip_spans(track_id)
    transcripts = project.selected_source_transcripts(track_id)
    transcribed = {source_id for source_id, _ in transcripts}
    words: list[BleedWordMapping] = []
    for source_id, transcript in transcripts:
        bounds = [(SourceSec(word.start), SourceSec(word.end)) for word in transcript.words]
        spans = (
            timeline.map_selected_source_spans(track_id, source_id, bounds)
            if placements
            else [[(TimelineSec(a), TimelineSec(b))] if b > a else [] for a, b in bounds]
        )
        boundaries = (
            timeline.map_selected_word_spans(track_id, source_id, bounds)
            if placements
            else timeline.map_word_spans(track_id, bounds)
        )
        words.extend(
            BleedWordMapping(source_id, word, tuple(mapped), tuple(boundary))
            for word, mapped, boundary in zip(transcript.words, spans, boundaries, strict=True)
        )
    return BleedGateGeometry(
        tuple(words),
        tuple(
            (float(span.timeline_start), float(span.timeline_end))
            for span in placements
            if span.clip.source_id not in transcribed
        ),
    )


def gate_scope_for_window(
    project: EpisodeProject, track_id: str, start: float, end: float
) -> list[TranscriptGateScope]:

    scopes: list[TranscriptGateScope] = []
    clips = SessionTimeline(project).lane_clip_spans(track_id)
    for span in clips:
        mapped = clip_timeline_overlap_to_source(span.clip, start, end)
        if mapped is not None:
            scopes.append(
                TranscriptGateScope(
                    start_s=float(mapped[0]), end_s=float(mapped[1]), source_id=span.clip.source_id
                )
            )
    if not clips and end > start:
        scopes.append(TranscriptGateScope(start_s=start, end_s=end))
    return merge_gate_scopes(scopes)


def merge_gate_scopes(scopes: list[TranscriptGateScope]) -> list[TranscriptGateScope]:
    """Canonical source selections make repeated and overlapping applies idempotent."""
    sources = sorted({scope.source_id for scope in scopes}, key=lambda source: source or "")
    return [
        TranscriptGateScope(start_s=start, end_s=end, source_id=source)
        for source in sources
        for start, end in merge_intervals(
            (scope.start_s, scope.end_s) for scope in scopes if scope.source_id == source
        )
    ]


def _scope_intervals(project: EpisodeProject, track_id: str) -> list[tuple[float, float]]:
    track = project.track_by_id(track_id)
    if track is None or track.transcript_gate_scope is None:
        return [(0, math.inf)]
    clips = SessionTimeline(project).lane_clip_spans(track_id)
    if not clips:
        return [
            (scope.start_s, scope.end_s)
            for scope in track.transcript_gate_scope
            if not scope.source_id
        ]
    intervals: list[tuple[float, float]] = []
    for scope in track.transcript_gate_scope:
        for span in clips:
            if span.clip.source_id != scope.source_id:
                continue
            start, end = (
                max(scope.start_s, float(span.source_start)),
                min(scope.end_s, float(span.source_end)),
            )
            if end > start:
                shift = clip_source_to_timeline_shift(span.clip)
                intervals.append((start + shift, end + shift))
    return merge_intervals(intervals)


def _owner_levels(samples: np.ndarray) -> np.ndarray:
    frame, hop = round(_OWNER_FRAME_SEC * EVIDENCE_RATE), round(_OWNER_HOP_SEC * EVIDENCE_RATE)
    return frame_rms_db_stream(
        (samples[first : first + EVIDENCE_RATE] for first in range(0, samples.size, EVIDENCE_RATE)),
        frame,
        hop,
    )


def _owner_floor_db(levels: np.ndarray) -> float:
    """The level above which a frame of this lane is sound rather than its noise floor."""
    return max(
        _OWNER_FLOOR_DB,
        float(np.percentile(levels, _OWNER_FLOOR_PERCENTILE)) + _OWNER_FLOOR_MARGIN_DB,
    )


def _owner_protection(
    samples: np.ndarray,
    seeds: list[tuple[float, float]],
    foreign: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """Own words plus the voiced runs touching them, stopping where a peer owns the speech."""
    if not seeds or samples.size < round(_OWNER_FRAME_SEC * EVIDENCE_RATE):
        return seeds
    levels = _owner_levels(samples)
    active = bridge_short_dips(levels > _owner_floor_db(levels), _OWNER_BRIDGE_FRAMES)
    for start, end in foreign:
        active[max(0, math.ceil(start / _OWNER_HOP_SEC)) : math.floor(end / _OWNER_HOP_SEC)] = False
    runs = [
        (lo * _OWNER_HOP_SEC, hi * _OWNER_HOP_SEC + _OWNER_HOP_SEC) for lo, hi in bool_runs(active)
    ]
    expanded = list(seeds)
    seed_index = HalfOpenIntervalIndex.build(seeds)
    for start, end in runs:
        if seed_index.overlaps(start, end):
            expanded.append((start, end))
    return merge_intervals(expanded)


def _levels_db(samples: np.ndarray) -> np.ndarray:
    return copy_levels_db(samples, sample_rate=EVIDENCE_RATE)


def _hop_mask(size: int, spans: list[tuple[float, float]], pad_sec: float = 0.0) -> np.ndarray:
    mask = np.zeros(size, dtype=bool)
    for start, end in spans:
        lo = max(0, math.floor((start - pad_sec) / _OWNER_HOP_SEC))
        mask[lo : max(lo, math.ceil((end + pad_sec) / _OWNER_HOP_SEC))] = True
    return mask


def _path_lag(own: np.ndarray, peer: np.ndarray, spans: list[tuple[float, float]]) -> int | None:
    """Hops by which the peer's own track trails its copy here, around ``spans`` (#1068)."""
    return copy_lag(own, peer, np.flatnonzero(_hop_mask(own.size, spans, MAX_COPY_LAG_SEC)))


def _frame_spans(runs: list[tuple[int, int]], *, whole_frame: bool) -> list[tuple[float, float]]:
    """Seconds read by any frame of each run, or only the seconds every frame read covers."""
    lead, tail = (
        (0.0, _LEVEL_FRAME_SEC)
        if whole_frame
        else (_LEVEL_FRAME_SEC - _OWNER_HOP_SEC, _OWNER_HOP_SEC)
    )
    spans = [(lo * _OWNER_HOP_SEC + lead, (hi - 1) * _OWNER_HOP_SEC + tail) for lo, hi in runs]
    return [(start, end) for start, end in spans if end > start]


def _on_lane_clock(levels: np.ndarray, lag: int, size: int) -> np.ndarray:
    """A peer track's levels moved ``lag`` hops earlier, onto this lane's clock."""
    out = np.full(size, LEVEL_FLOOR_DB)
    lo, hi = max(0, -lag), min(size, levels.size - lag)
    out[lo:hi] = levels[lo + lag : hi + lag]
    return out


@dataclass(frozen=True, eq=False)
class _PeerCopy:
    """A peer's verified copy on this lane: its delay, lead, level and timbre there.

    ``lead`` is, per level frame, how many hops ahead of the peer's opening the copy
    was heard here, at most the 200 ms the gate reads ahead. It sets only how loud
    the copy is expected when own sound is judged.
    """

    levels: np.ndarray
    samples: np.ndarray
    lag: int
    coupling_db: float = 0.0
    spread_db: float = 0.0
    likeness: float = 1.0
    lead: np.ndarray | int = _ONSET_REACH

    def direct(self, size: int) -> np.ndarray:
        """The peer's direct-track levels moved onto this lane's clock."""
        return _on_lane_clock(self.levels, self.lag, size)

    def reach(self, size: int, lead: np.ndarray | int = _ONSET_REACH) -> np.ndarray:
        """The direct-track level the copy here can carry in each frame.

        The copy rings on in the room after the peer's gate shuts, so frames read
        the direct track held briefly. Where the direct track was gated shut within
        the last level frame, its level is diluted or missing while the copy may
        already carry the peer's onset, so those frames also read ahead, each as far
        as ``lead`` there: by default the full 200 ms, which is where the copy can be.
        """
        direct = self.direct(size)
        hop = _OWNER_HOP_SEC
        hold = round(_COPY_HOLD_SEC / hop)
        held = _sliding_max(direct, hold, hold)
        onset = _sliding_max(-direct, round(_LEVEL_FRAME_SEC / hop), 0) >= -PEER_OPEN_DB
        steps = np.broadcast_to(lead, size)
        ahead = direct.copy()
        for step in range(1, min(_ONSET_REACH, size) + 1):
            later = np.concatenate([direct[step:], np.full(step, LEVEL_FLOOR_DB)])
            ahead = np.where(steps >= step, np.maximum(ahead, later), ahead)
        return np.where(onset, np.maximum(held, ahead), held)

    def power(self, size: int, *, held: bool) -> np.ndarray:
        """Power of the copy on this lane, frame by frame or as loud as it is expected."""
        level = self.reach(size, self.lead) if held else self.direct(size)
        return 10 ** ((level + self.coupling_db) / 10)

    def similarity(self, own_samples: np.ndarray, frames: np.ndarray) -> np.ndarray:
        """Per frame, how much this lane's fine spectrum matches the peer's at the lag."""
        return copy_similarity(
            own_samples, self.samples, frames, self.lag, sample_rate=EVIDENCE_RATE
        )

    def timbre_windows(self, own_samples: np.ndarray, judged: np.ndarray) -> np.ndarray:
        """Frames of each fifth of a second whose ``judged`` frames sound like the copy."""
        width = round(_TIMBRE_WINDOW_SEC / _OWNER_HOP_SEC)
        frames = np.flatnonzero(judged)
        like = np.zeros(-(-judged.size // width), dtype=bool)
        if frames.size:
            similarity = self.similarity(own_samples, frames)
            windows, starts = np.unique(frames // width, return_index=True)
            medians = np.array([np.median(part) for part in np.split(similarity, starts[1:])])
            like[windows[medians >= self.likeness]] = True
        return np.repeat(like, width)[: judged.size]


def _sliding_max(levels: np.ndarray, before: int, after: int) -> np.ndarray:
    padded = np.pad(levels, (before, after), constant_values=LEVEL_FLOOR_DB)
    return np.lib.stride_tricks.sliding_window_view(padded, before + after + 1).max(axis=1)


def _peer_copy(
    own: np.ndarray,
    own_samples: np.ndarray,
    peer: np.ndarray,
    peer_samples: np.ndarray,
    spans: list[tuple[float, float]],
    own_words: list[tuple[float, float]],
) -> _PeerCopy | None:
    """The lag, then the copy's level and timbre on this mic where only the peer speaks.

    ``spans`` is the peer's speech on its own track's clock; the copy here leads it
    by the lag. The coupling is the median lane-to-direct level over the louder half
    of the peer's open frames, away from this lane's own words, so the lane's noise
    floor and any overlapping own speech do not move it. On the lab tape it is about
    -20 dB for Audra on Caleb's mic. The spread is how far over the coupling the copy
    reaches on those frames, at their 95th percentile: the peer's phonemes and the
    call software's noise suppression move it 10.5 dB on the lab, and 10.6 dB on the
    owner-confirmed Audra-only passages. The likeness is the 40th percentile of the
    fine-spectrum match on frames at the coupling. The room and call software blur and
    spread it on the lab (0.35; median 0.41); a copy that keeps its timbre sits in a
    narrow band near 1.

    All three are read against the full 200 ms reach, where the copy can be, not
    against the measured lead. A coupling read against the lead would expect more
    copy inside the peer's words, and a breath 4 dB over the copy there was cut whole.
    """
    lag = _path_lag(own, peer, spans)
    if lag is None:
        return None
    reach = _PeerCopy(peer, peer_samples, lag).reach(own.size)
    shift = lag * _OWNER_HOP_SEC
    frames = (
        _hop_mask(own.size, [(start - shift, end - shift) for start, end in spans])
        & ~_hop_mask(own.size, own_words, MAX_COPY_LAG_SEC)
        & (reach > PEER_OPEN_DB)
        & (own > LEVEL_FLOOR_DB)
    )
    if not frames.any():
        return None
    loud = frames & (reach >= np.median(reach[frames]))
    coupling = float(np.median(own[loud] - reach[loud]))
    spread = float(np.percentile(own[loud] - reach[loud], _SPREAD_PERCENTILE)) - coupling
    typical = np.flatnonzero(loud & (np.abs(own - reach - coupling) < _OWN_HOLD_MARGIN_DB))
    sample = typical[:: max(1, typical.size // LIKENESS_FRAMES)]
    copy = _PeerCopy(peer, peer_samples, lag, coupling)
    likeness = copy_likeness(copy.similarity(own_samples, sample)) if sample.size else 1.0
    lead = _copy_lead(own_samples, peer_samples, lag, own.size)
    return _PeerCopy(peer, peer_samples, lag, coupling, spread, likeness, lead)


def _copy_lead(
    own_samples: np.ndarray, peer_samples: np.ndarray, lag: int, size: int
) -> np.ndarray:
    """Per level frame, how far ahead of the peer's track the copy is expected to sound.

    A call app can open a speaker's gate late, by a different amount on each word,
    so the copy on a mic in the room starts first. The 200 ms before every opening of
    the peer's track stays where the copy can be. How loud the copy is expected there,
    when own sound is judged, reads ahead of each opening only as far as this lane has
    been sounding without a break up to it: over the mic's own floor, as own words'
    voiced runs are, through dips shorter than the copy rings. A lane quiet just
    before an opening shows that the copy came with the track, so sound near that
    opening is judged against what the track carries, not its next word. The lane's
    sound is not judged as copy or own sound here: the copy is never expected later
    than the lane heard it, and own sound running into an opening is judged as if it
    might be the copy's start. The lead holds from the 200 ms and the level frame
    before each opening to the level frame after it.
    """
    hop = _OWNER_HOP_SEC
    lane = _owner_levels(own_samples)
    direct = _on_lane_clock(_owner_levels(peer_samples), lag, lane.size)
    frame = round(_LEVEL_FRAME_SEC / hop)
    sounding = bridge_short_dips(lane > _owner_floor_db(lane), round(_COPY_HOLD_SEC / hop) - 1)
    starts = np.zeros(lane.size, dtype=int)
    for lo, hi in bool_runs(sounding):
        starts[lo:hi] = lo
    opened = direct > PEER_OPEN_DB
    lead = np.zeros(size, dtype=int)
    for opening in np.flatnonzero(opened[1:] & ~opened[:-1] & sounding[:-1]) + 1:
        near = slice(max(0, opening - _ONSET_REACH - frame), opening + frame + 1)
        lead[near] = np.maximum(lead[near], min(_ONSET_REACH, opening - starts[opening - 1]))
    return lead


def _own_voice(
    own: np.ndarray, own_samples: np.ndarray, copies: list[_PeerCopy]
) -> list[tuple[float, float]]:
    """Seconds where this lane's speaker is heard over the peers' copies.

    The expected level is the copies plus this mic's own noise floor. Sound more than
    a copy's spread above it is the lane's speaker whatever its timbre, since the copy
    stays under that in 95 of 100 loud frames. Nearer the expected level, level alone
    cannot tell, so each fifth of a second is judged by timbre: it is the copy where
    the median fine-spectrum match of its frames over the hold margin reaches the
    copy's likeness. Judging short windows, not whole runs of sound, keeps seconds of
    copy or of the lane's own speech from outvoting a word beside them. Own sound is
    held through short dips, so a short "mm" is kept whole, and needs a syllable over
    the own margin to count. Transcript words play no part, so untranscribed
    backchannels, laughs, and words reconciliation gave to a peer are kept too.
    """
    opened = own[own > LEVEL_FLOOR_DB]
    noise = 10 ** (
        (float(np.percentile(opened, _OWNER_FLOOR_PERCENTILE)) if opened.size else LEVEL_FLOOR_DB)
        / 10
    )
    reach = sum((copy.power(own.size, held=True) for copy in copies), np.zeros(own.size))
    excess = own - 10 * np.log10(reach + noise)
    above = excess > _OWN_HOLD_MARGIN_DB
    copy_like = np.zeros(own.size, dtype=bool)
    for copy in copies:
        copy_like |= copy.timbre_windows(
            own_samples, above & (copy.power(own.size, held=False) > noise)
        )
    clear = excess > max([_OWN_MARGIN_DB, *(copy.spread_db for copy in copies)])
    heard = (bridge_short_dips(above, _OWNER_BRIDGE_FRAMES) & ~copy_like) | clear
    hot = excess > _OWN_MARGIN_DB
    least = round(_MIN_OWN_SEC / _OWNER_HOP_SEC)
    runs = [
        (lo, hi)
        for lo, hi in bool_runs(heard)
        if any(b - a >= least for a, b in bool_runs(hot[lo:hi]))
    ]
    return _frame_spans(runs, whole_frame=True)


def _foreign_speech(size: int, copies: list[_PeerCopy]) -> list[tuple[float, float]]:
    """Every frame a verified peer's copy can reach on this lane.

    Found from the peers' own tracks, not from this lane's transcript, so a copy
    with no bleed word on this lane is covered too. The lane's own speech is
    protected from it afterwards.
    """
    reached = np.zeros(size, dtype=bool)
    for copy in copies:
        reached |= copy.reach(size) > PEER_OPEN_DB
    return _frame_spans(
        bool_runs(bridge_short_dips(reached, _OWNER_BRIDGE_FRAMES)), whole_frame=True
    )


def _channels_are_one_signal(channels: np.ndarray) -> bool:
    """Whether every channel is the first one up to codec noise.

    A call app's dual-mono track is exact in a WAV, but AAC and Opus decode its two
    channels a little apart. Their difference counts only where it stands above the
    lane's noise floor and within ``_SAME_SIGNAL_GAP_DB`` of the loudest channel
    anywhere in a codec block's reach, since a codec's noise follows its block's level
    and not the frame's own. Sound on one channel sits near that channel's own level,
    which is the loudest there, so it never passes.
    """
    levels = [_owner_levels(channel) for channel in channels.T]
    loudest = np.maximum.reduce(levels)
    if not loudest.size:
        return bool((channels == channels[:, :1]).all())
    floor = _owner_floor_db(loudest)
    reach = round(_CODEC_REACH_SEC / _OWNER_HOP_SEC)
    loudest = _sliding_max(loudest, reach, reach)
    for channel in channels.T[1:]:
        gap = _owner_levels(channel - channels[:, 0])
        if ((gap > floor) & (gap - loudest > _SAME_SIGNAL_GAP_DB)).any():
            return False
    return True


def _lane_signals(project: EpisodeProject, track_id: str) -> list[np.ndarray]:
    """Each channel the lane records, or ffmpeg's mono mixdown when they are one signal.

    A stereo or ambisonic mic can carry its speaker on one channel while a peer's
    copy reaches all of them. A mixdown halves that own sound against the copy, so a
    quiet "uh-huh" there was judged copy (#1094). Channels that carry one signal are
    judged once, on the mono level the gate's absolute floors were set on. Stereo is
    mixed here, as ffmpeg does; any other layout asks ffmpeg for its own matrix
    (LFE, centre and surround weights differ by layout) at the cost of a second decode.
    """
    channels = raw_timeline_samples(
        project, track_id, sample_rate=EVIDENCE_RATE, preserve_channels=True
    )
    if channels.shape[1] == 1:
        return [channels[:, 0]]
    if _channels_are_one_signal(channels):
        if channels.shape[1] == 2:
            return [channels.sum(axis=1) * _STEREO_MONO_GAIN]
        return [raw_timeline_samples(project, track_id, sample_rate=EVIDENCE_RATE)]
    return [np.ascontiguousarray(channel) for channel in channels.T]


def _bed_db(
    own: np.ndarray, placed: list[tuple[float, float]], busy: list[tuple[float, float]]
) -> float | None:
    """This lane's median level where it carries media and nobody it carries speaks.

    ``busy`` is the lane's own speech and hold and the peers' copies. A median, because
    copy tails and the lane's breaths fill a few percent of the rest and would set a
    mean: on the lab tape 3% of Caleb's frames beside the copies gave 97% of their
    power. A call app's gated track reads the level floor there most of the time.
    """
    quiet = _hop_mask(own.size, placed) & ~_hop_mask(own.size, busy)
    if not quiet.any():
        return None
    return round(float(np.median(own[quiet])), 1)


def _reduction(
    handling: BleedHandling, bed_db: float | None, attenuation_db: float
) -> BleedReduction:
    if handling != "auto":
        return handling
    audible = bed_db is not None and bed_db - attenuation_db > _AUDIBLE_BED_DB
    return "attenuate" if audible else "mute"


def _peer_ids(project: EpisodeProject, track_id: str) -> list[str]:
    return [
        tid
        for tid in dialogue_track_ids(project)
        if tid != track_id and (track := project.track_by_id(tid)) is not None and track.media
    ]


class _UnavailableGateEvidence(Exception):
    def __init__(self, plan: BleedGatePlan) -> None:
        super().__init__("gate evidence is temporarily unavailable")
        self.plan = plan


@lru_cache(maxsize=16)
def _cached_bleed_gate_plan(
    project_json: str, track_id: str, _media_revision: str, source_clock: bool, ignore_scope: bool
) -> BleedGatePlan:
    plan = _compute_bleed_gate_plan(
        EpisodeProject.model_validate_json(project_json),
        track_id,
        source_clock=source_clock,
        ignore_scope=ignore_scope,
    )
    if any(reason.startswith("unavailable_") for reason in plan.reasons):
        raise _UnavailableGateEvidence(plan)
    return plan


def build_bleed_gate_plan(
    project: EpisodeProject,
    track_id: str,
    *,
    source_clock: bool = False,
    ignore_scope: bool = False,
) -> BleedGatePlan:
    """Reuse immutable acoustic evidence until selected media, metadata, or policy changes."""
    serialized = project.model_dump_json(
        by_alias=True, include={"version", "meta", "sources", "timeline", "transcript_data"}
    )
    revision = json.dumps(
        bleed_gate_payload(project, track_id), sort_keys=True, separators=(",", ":")
    )
    try:
        return _cached_bleed_gate_plan(serialized, track_id, revision, source_clock, ignore_scope)
    except _UnavailableGateEvidence as exc:
        return exc.plan


def _compute_bleed_gate_plan(
    project: EpisodeProject,
    track_id: str,
    *,
    source_clock: bool = False,
    ignore_scope: bool = False,
) -> BleedGatePlan:
    timeline = SessionTimeline(project)
    if source_clock:
        from podcast_mcp.engines.timeline_render import resolve_clip_audio_path

        track = project.track_by_id(track_id)
        try:
            primary = track_audio_path(project, track_id).resolve()
            if track is None or any(
                resolve_clip_audio_path(project, track, span.clip).resolve() != primary
                for span in timeline.lane_clip_spans(track_id)
            ):
                return BleedGatePlan(reasons=("unsupported_source_proxy_layout",))
        except (OSError, ValueError):
            return BleedGatePlan(reasons=("unavailable_owner_source",))
    transcripts = project.selected_source_transcripts(track_id)
    if not transcripts:
        return BleedGatePlan(reasons=("missing_transcript",))
    geometry = bleed_gate_geometry(project, track_id)
    untranscribed_spans = list(geometry.untranscribed_spans)
    peer_ids = _peer_ids(project, track_id)
    if not peer_ids:
        return BleedGatePlan(reasons=("no_peer_tracks",))
    if any(raw_evidence_layout_reason(project, tid) for tid in [track_id, *peer_ids]):
        return BleedGatePlan(reasons=("unsupported_crossfade_evidence_clock",))
    policy = AnalysisPolicy.from_defaults()
    sources: dict[Path, np.ndarray] = {}
    try:
        signals = _lane_signals(project, track_id)
    except (OSError, ValueError, wave.Error, CalledProcessError):
        return BleedGatePlan(reasons=("unavailable_owner_source",))
    lanes = [(_levels_db(signal), signal) for signal in signals]
    seeds = [
        (float(start), float(end))
        for mapped in geometry.words
        if not mapped.word.suppressed
        for start, end in mapped.spans
    ]
    copies: list[list[_PeerCopy]] = [[] for _ in lanes]
    reasons = {"untranscribed_source_protected"} if untranscribed_spans else set()
    for peer_id in peer_ids:
        try:
            peer = raw_timeline_samples(
                project, peer_id, sources=sources, sample_rate=EVIDENCE_RATE
            )
        except (OSError, ValueError, wave.Error, CalledProcessError):
            reasons.add("unavailable_peer_source")
            continue
        levels = _levels_db(peer)
        speech = subtract_intervals(
            _frame_spans(bool_runs(levels > PEER_OPEN_DB), whole_frame=True), seeds
        )
        for found, (own_levels, own) in zip(copies, lanes, strict=True):
            copy = _peer_copy(own_levels, own, levels, peer, speech, seeds)
            if copy is None:
                reasons.add("uncertain_foreign_ownership")
            else:
                found.append(copy)
    size = lanes[0][0].size
    verified = [copy for found in copies for copy in found]
    foreign = _foreign_speech(size, verified)
    own_voice = (
        [
            span
            for found, (own_levels, own) in zip(copies, lanes, strict=True)
            for span in _own_voice(own_levels, own, found)
        ]
        if verified
        else []
    )
    protected = merge_intervals(
        [
            *(span for _, own in lanes for span in _owner_protection(own, seeds, foreign)),
            *own_voice,
            *untranscribed_spans,
        ]
    )
    kept = merge_intervals(
        (start - _ONSET_HOLD_SEC, end + _TAIL_HOLD_SEC) for start, end in protected
    )
    attenuation = subtract_intervals(foreign, kept)
    placements = timeline.lane_clip_spans(track_id)
    placed = (
        [(float(span.timeline_start), float(span.timeline_end)) for span in placements]
        if placements
        else [(0.0, size * _OWNER_HOP_SEC)]
    )
    beds = [
        bed
        for own_levels, _ in lanes
        if (bed := _bed_db(own_levels, placed, [*foreign, *kept])) is not None
    ]
    bed_db = max(beds, default=None)
    if not ignore_scope:
        attenuation = intersect_intervals(attenuation, _scope_intervals(project, track_id))
    attenuation = [(start, end) for start, end in attenuation if end - start > 2 * GATE_FADE_SEC]
    if source_clock and placements:
        attenuation = merge_intervals(
            (float(source_span[0]), float(source_span[1]))
            for lo, hi in attenuation
            for placement in placements
            if (source_span := clip_timeline_overlap_to_source(placement.clip, lo, hi)) is not None
        )
        protected = merge_intervals(
            (float(source_span[0]), float(source_span[1]))
            for lo, hi in protected
            for placement in placements
            if (source_span := clip_timeline_overlap_to_source(placement.clip, lo, hi)) is not None
        )
    return BleedGatePlan(
        tuple(attenuation),
        tuple(protected),
        tuple(sorted(reasons)),
        reduction=_reduction(policy.bleed_handling, bed_db, policy.bleed_attenuation_db),
        attenuation_db=policy.bleed_attenuation_db,
        bed_db=bed_db,
    )


def bleed_gate_payload(project: EpisodeProject, track_id: str) -> dict[str, Any]:
    """Gate-driving metadata and media revisions without decoding acoustic evidence."""
    from podcast_mcp.engines.timeline_render import resolve_clip_audio_path

    track = project.track_by_id(track_id)
    if track is None:
        return {}
    relevant = {track_id, *_peer_ids(project, track_id)}
    inputs: list[dict[str, Any]] = []
    for tid in sorted(relevant):
        lane = project.track_by_id(tid)
        if lane is None:
            continue
        clips = SessionTimeline(project).lane_clip_spans(tid)
        paths: list[Path] = []
        with suppress(OSError, ValueError):
            paths = (
                [resolve_clip_audio_path(project, lane, span.clip) for span in clips]
                if clips
                else [track_audio_path(project, tid)]
            )
        media: list[dict[str, Any]] = []
        for path in sorted(set(paths)):
            try:
                media.append({"path": str(path), "revision": file_revision(path)})
            except OSError:
                media.append({"path": str(path), "unavailable": True})
        words = project.selected_source_transcripts(tid)
        inputs.append(
            {
                "track_id": tid,
                "media": media,
                "clips": [span.clip.model_dump(mode="json") for span in clips],
                "transcribed_source_ids": [source_id for source_id, _ in words],
                "words": [
                    {
                        "source_id": source_id,
                        "start": word.start,
                        "end": word.end,
                        "suppressed": word.suppressed,
                        "status": word.audibility_status,
                        "dominant_track": word.dominant_track,
                        "locked": word.audibility_locked,
                        "ignored": word.ignored,
                    }
                    for source_id, transcript in words
                    for word in transcript.words
                ],
            }
        )
    policy = AnalysisPolicy.from_defaults()
    return {
        "revision": BLEED_GATE_REV,
        "fade_sec": GATE_FADE_SEC,
        "policy": {
            "handling": policy.bleed_handling,
            "attenuation_db": policy.bleed_attenuation_db,
            "audible_bed_db": _AUDIBLE_BED_DB,
            "onset_hold_sec": _ONSET_HOLD_SEC,
            "tail_hold_sec": _TAIL_HOLD_SEC,
            "evidence_rate": EVIDENCE_RATE,
            "level_frame_sec": _LEVEL_FRAME_SEC,
            "level_floor_db": LEVEL_FLOOR_DB,
            "max_path_lag_sec": MAX_COPY_LAG_SEC,
            "null_shifts_sec": list(NULL_SHIFTS_SEC),
            "min_path_correlation": MIN_CORRELATION,
            "min_null_margin": MIN_NULL_MARGIN,
            "min_path_frames": round(MIN_COPY_SEC / COPY_HOP_SEC),
            "full_path_frames": round(FULL_COPY_SEC / COPY_HOP_SEC),
            "contour_sec": CONTOUR_SEC,
            "peer_open_db": PEER_OPEN_DB,
            "copy_hold_sec": _COPY_HOLD_SEC,
            "onset_reach_sec": _ONSET_REACH_SEC,
            "own_margin_db": _OWN_MARGIN_DB,
            "own_hold_margin_db": _OWN_HOLD_MARGIN_DB,
            "min_own_sec": _MIN_OWN_SEC,
            "spread_percentile": _SPREAD_PERCENTILE,
            "timbre_window_sec": _TIMBRE_WINDOW_SEC,
            "likeness_percentile": LIKENESS_PERCENTILE,
            "timbre_band_hz": list(TIMBRE_BAND_HZ),
            "timbre_smooth_bins": TIMBRE_SMOOTH_BINS,
            "likeness_frames": LIKENESS_FRAMES,
            "owner_frame_sec": _OWNER_FRAME_SEC,
            "owner_hop_sec": _OWNER_HOP_SEC,
            "owner_floor_db": _OWNER_FLOOR_DB,
            "owner_floor_percentile": _OWNER_FLOOR_PERCENTILE,
            "owner_floor_margin_db": _OWNER_FLOOR_MARGIN_DB,
            "owner_bridge_frames": _OWNER_BRIDGE_FRAMES,
        },
        "scope": [scope.model_dump(mode="json") for scope in track.transcript_gate_scope]
        if track.transcript_gate_scope is not None
        else None,
        "inputs": inputs,
    }
