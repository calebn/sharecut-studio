"""Voiced speech cut through at a splice: a clipped onset or a clipped tail.

ASR word times are an editing agent's only view of where speech starts, and Whisper
places a soft onset ("Um,") hundreds of milliseconds late. A cut that leaves a pad
before the ASR onset can still remove the first syllable. This module measures the
raw source audio on both sides of each clip edge at a join and reports voiced audio
that continues across the edge into the removed material, with the milliseconds
removed and the edge to trim back to. The join sweep and the audition context share it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any, Literal

import numpy as np

from podcast_mcp.edits.clips_ops import clips_for_track, splice_joins
from podcast_mcp.engines.align import AudioWindowUnavailableError, load_mono_window
from podcast_mcp.models import Clip, EpisodeProject, TranscriptWord
from podcast_mcp.util.dsp import autocorr_peak, bool_runs, bridge_short_dips, frame_rms_db
from podcast_mcp.util.process import CalledProcessError
from podcast_mcp.util.tracks import track_audio_path

Direction = Literal["clipped_onset", "clipped_tail"]
Side = Literal["onset", "tail"]

_VOICING_PROBE_SEC = 0.04


@dataclass(frozen=True)
class JoinSpeechConfig:
    sample_rate: int = 16000
    # Removed source audio inspected beyond a clip edge (where the voice edge may be)
    # and kept audio inspected inside the clip.
    removed_window_sec: float = 1.0
    kept_window_sec: float = 0.4
    frame_sec: float = 0.02
    hop_sec: float = 0.01
    # A frame is speech when it sits within ``speech_dynamic_db`` of the window's loud
    # frames (95th percentile) and above ``abs_floor_db``; a window whose loud frames stay
    # under ``speech_min_db`` holds no speech to clip.
    speech_dynamic_db: float = 25.0
    abs_floor_db: float = -50.0
    speech_min_db: float = -35.0
    # Dips inside one phrase (stop closures) shorter than this do not end the run.
    bridge_sec: float = 0.03
    min_removed_ms: float = 40.0
    # Speech must go on this long inside the clip; a shorter run is a decaying remnant
    # of the removed sound, not a clipped phrase.
    min_kept_ms: float = 100.0
    # Air kept between the voice edge and the suggested clip edge.
    pad_sec: float = 0.06
    voiced_peak: float = 0.28
    f0_min_hz: float = 70.0
    f0_max_hz: float = 350.0
    # How far past the edge to look for the ASR word the cut was placed against.
    asr_lookahead_sec: float = 0.6


@dataclass(frozen=True)
class SpeechCrossing:
    """Voiced audio that continues across a clip edge into the removed material."""

    track_id: str
    clip_id: str
    join_timeline_sec: float
    direction: Direction
    cut_source_sec: float
    voice_edge_source_sec: float
    removed_ms: float
    suggested_source_sec: float
    kept_level_db: float
    removed_level_db: float
    # The transcript words on either side of the cut (source clock) and how far the
    # word time the cut was placed against sits from the measured voice edge.
    asr_prev_word: str | None
    asr_prev_end_sec: float | None
    asr_next_word: str | None
    asr_next_start_sec: float | None
    asr_lag_ms: float | None
    asr_disagrees: bool
    """The transcript puts the cut clear of every word while the voice runs through it."""

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        for key in (
            "join_timeline_sec",
            "cut_source_sec",
            "voice_edge_source_sec",
            "suggested_source_sec",
            "asr_prev_end_sec",
            "asr_next_start_sec",
        ):
            if d[key] is not None:
                d[key] = round(d[key], 3)
        for key in ("removed_ms", "kept_level_db", "removed_level_db", "asr_lag_ms"):
            if d[key] is not None:
                d[key] = round(d[key], 1)
        return d


def _voiced(frame: np.ndarray, sample_rate: int, config: JoinSpeechConfig) -> bool:
    if frame.size < sample_rate // 100:
        return False
    peak = autocorr_peak(frame, sample_rate, fmin=config.f0_min_hz, fmax=config.f0_max_hz)
    return peak is not None and peak[1] >= config.voiced_peak


def _run_is_voiced(
    samples: np.ndarray, sample_rate: int, start: int, end: int, config: JoinSpeechConfig
) -> bool:
    """Most of three evenly spaced probes inside ``[start, end)`` are periodic."""
    probe = max(1, round(sample_rate * _VOICING_PROBE_SEC))
    span = max(1, end - start)
    centers = [start + span * k // 4 for k in (1, 2, 3)]
    votes = [
        _voiced(
            samples[max(0, c - probe // 2) : max(0, c - probe // 2) + probe], sample_rate, config
        )
        for c in centers
    ]
    return sum(votes) >= 2


def speech_crossing_at_edge(
    samples: np.ndarray,
    sample_rate: int,
    *,
    edge_index: int,
    side: Side,
    config: JoinSpeechConfig | None = None,
) -> tuple[int, float, float] | None:
    """Voiced speech that continues past a clip edge into the audio the cut removed.

    ``samples`` is source audio around the edge; ``edge_index`` is the clip edge inside it.
    ``side`` is ``onset`` for a clip start (removed audio lies before the edge) or ``tail``
    for a clip end (removed audio lies after it). Returns ``(voice_edge_index, kept_db,
    removed_db)``: where the voice actually starts or ends and the mean level of the run
    on each side of the edge. ``None`` when the clip edge is not inside voiced speech or
    the removed part is shorter than ``min_removed_ms``.
    """
    cfg = config or JoinSpeechConfig()
    frame = max(1, round(sample_rate * cfg.frame_sec))
    hop = max(1, round(sample_rate * cfg.hop_sec))
    levels = frame_rms_db(samples, frame, hop)
    if levels.size < 3:
        return None
    loud = float(np.percentile(levels, 95.0))
    if loud < cfg.speech_min_db:
        return None
    floor = max(cfg.abs_floor_db, loud - cfg.speech_dynamic_db)
    active = bridge_short_dips(levels >= floor, max(1, round(cfg.bridge_sec / cfg.hop_sec)))
    # The frame whose centre is nearest the edge; onset checks the first kept frame,
    # tail the last one.
    k_edge = round((edge_index - frame / 2) / hop)
    k_kept = k_edge if side == "onset" else k_edge - 1
    if not (0 <= k_kept < active.size) or not active[k_kept]:
        return None
    run = next((r for r in bool_runs(active) if r[0] <= k_kept < r[1]), None)
    if run is None:
        return None
    if side == "onset":
        removed_frames, kept_frames = k_edge - run[0], run[1] - k_edge
        voice_edge = run[0] * hop
        removed_lo, removed_hi = run[0], k_edge
        kept_lo, kept_hi = k_edge, run[1]
    else:
        removed_frames, kept_frames = run[1] - k_edge, k_edge - run[0]
        voice_edge = min(samples.size, (run[1] - 1) * hop + frame)
        removed_lo, removed_hi = k_edge, run[1]
        kept_lo, kept_hi = run[0], k_edge
    if removed_frames * cfg.hop_sec * 1000.0 < cfg.min_removed_ms:
        return None
    if kept_frames * cfg.hop_sec * 1000.0 < cfg.min_kept_ms:
        return None
    removed_start = removed_lo * hop
    removed_end = min(samples.size, (removed_hi - 1) * hop + frame)
    if not _run_is_voiced(samples, sample_rate, removed_start, removed_end, cfg):
        return None
    kept_db = (
        float(np.mean(levels[kept_lo:kept_hi])) if kept_hi > kept_lo else float(levels[k_kept])
    )
    removed_db = float(np.mean(levels[removed_lo:removed_hi]))
    return int(voice_edge), kept_db, removed_db


def _words_for_track(project: EpisodeProject, track_id: str) -> list[TranscriptWord]:
    tr = project.transcript_for_track(track_id)
    return [w for w in tr.words if not w.suppressed] if tr and tr.words else []


def _asr_neighbours(
    words: Sequence[TranscriptWord], cut_sec: float, lookahead: float
) -> tuple[TranscriptWord | None, TranscriptWord | None]:
    """The transcript words ending before and starting after the cut, within ``lookahead``."""
    before = [w for w in words if cut_sec - lookahead <= w.end <= cut_sec]
    after = [w for w in words if cut_sec <= w.start <= cut_sec + lookahead]
    return (
        max(before, key=lambda w: w.end) if before else None,
        min(after, key=lambda w: w.start) if after else None,
    )


class _SourceReader:
    """Source windows for one track: slices of a whole-track decode, or seeked reads."""

    def __init__(
        self,
        project: EpisodeProject,
        track_id: str,
        *,
        sample_rate: int,
        samples: np.ndarray | None,
    ) -> None:
        self.sample_rate = sample_rate
        self._samples = samples
        self._path = None if samples is not None else track_audio_path(project, track_id)

    def window(self, start_sec: float, end_sec: float) -> tuple[np.ndarray, float]:
        """``(samples, t0)`` for ``[start_sec, end_sec)`` of source audio."""
        start_sec = max(0.0, start_sec)
        if self._samples is not None:
            i0 = int(start_sec * self.sample_rate)
            i1 = int(end_sec * self.sample_rate)
            return self._samples[i0:i1], start_sec
        assert self._path is not None
        return (
            load_mono_window(
                self._path,
                start_sec=start_sec,
                duration_sec=end_sec - start_sec,
                sample_rate=self.sample_rate,
            ),
            start_sec,
        )


def _crossing(
    reader: _SourceReader,
    *,
    track_id: str,
    clip: Clip,
    join_t: float,
    cut_sec: float,
    side: Side,
    words: Sequence[TranscriptWord],
    cfg: JoinSpeechConfig,
) -> SpeechCrossing | None:
    before = cfg.removed_window_sec if side == "onset" else cfg.kept_window_sec
    after = cfg.kept_window_sec if side == "onset" else cfg.removed_window_sec
    try:
        samples, t0 = reader.window(cut_sec - before, cut_sec + after)
    except (AudioWindowUnavailableError, CalledProcessError, ValueError, OSError):
        return None
    edge_index = round((cut_sec - t0) * reader.sample_rate)
    hit = speech_crossing_at_edge(
        samples, reader.sample_rate, edge_index=edge_index, side=side, config=cfg
    )
    if hit is None:
        return None
    voice_index, kept_db, removed_db = hit
    voice_edge = t0 + voice_index / reader.sample_rate
    removed_ms = abs(cut_sec - voice_edge) * 1000.0
    suggested = max(0.0, voice_edge - cfg.pad_sec) if side == "onset" else voice_edge + cfg.pad_sec
    prev_word, next_word = _asr_neighbours(words, cut_sec, cfg.asr_lookahead_sec)
    placed_against = next_word if side == "onset" else prev_word
    asr_lag_ms = None
    if placed_against is not None:
        asr_sec = placed_against.start if side == "onset" else placed_against.end
        asr_lag_ms = (asr_sec - voice_edge if side == "onset" else voice_edge - asr_sec) * 1000.0
    return SpeechCrossing(
        track_id=track_id,
        clip_id=clip.id,
        join_timeline_sec=join_t,
        direction="clipped_onset" if side == "onset" else "clipped_tail",
        cut_source_sec=cut_sec,
        voice_edge_source_sec=voice_edge,
        removed_ms=removed_ms,
        suggested_source_sec=suggested,
        kept_level_db=kept_db,
        removed_level_db=removed_db,
        asr_prev_word=None if prev_word is None else prev_word.text,
        asr_prev_end_sec=None if prev_word is None else float(prev_word.end),
        asr_next_word=None if next_word is None else next_word.text,
        asr_next_start_sec=None if next_word is None else float(next_word.start),
        asr_lag_ms=asr_lag_ms,
        asr_disagrees=not any(w.start <= cut_sec <= w.end for w in words),
    )


def find_speech_crossings(
    project: EpisodeProject,
    track_id: str,
    joins: Sequence[tuple[Clip, Clip]],
    *,
    config: JoinSpeechConfig | None = None,
    samples: np.ndarray | None = None,
    sample_rate: int | None = None,
) -> list[SpeechCrossing]:
    """Clipped onsets and tails at ``joins`` (``(left, right)`` clip pairs) on one track.

    Pass ``samples`` (the whole track decoded at ``sample_rate``) to reuse a decode the
    caller already holds, as the join sweep does; otherwise each edge reads one short
    source window. A track whose media cannot be read yields no crossings.
    """
    cfg = config or JoinSpeechConfig()
    rate = sample_rate or cfg.sample_rate
    try:
        reader = _SourceReader(project, track_id, sample_rate=rate, samples=samples)
    except ValueError:
        return []
    words = _words_for_track(project, track_id)
    out: list[SpeechCrossing] = []
    for prev, cur in joins:
        join_t = float(cur.timeline_start)
        for clip, cut_sec, side in (
            (prev, float(prev.source_end), "tail"),
            (cur, float(cur.source_start), "onset"),
        ):
            hit = _crossing(
                reader,
                track_id=track_id,
                clip=clip,
                join_t=join_t,
                cut_sec=cut_sec,
                side=side,  # type: ignore[arg-type]
                words=words,
                cfg=cfg,
            )
            if hit is not None:
                out.append(hit)
    return out


def speech_crossings_in_window(
    project: EpisodeProject,
    track_ids: Sequence[str],
    timeline_start: float,
    timeline_end: float,
    *,
    config: JoinSpeechConfig | None = None,
) -> list[SpeechCrossing]:
    """Crossings at every splice whose join instant lies inside a timeline window."""
    out: list[SpeechCrossing] = []
    for tid in track_ids:
        joins = [
            (prev, cur)
            for prev, cur in splice_joins(clips_for_track(project, tid))
            if timeline_start <= float(cur.timeline_start) <= timeline_end
        ]
        if joins:
            out.extend(find_speech_crossings(project, tid, joins, config=config))
    return out
