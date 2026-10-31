"""Peer-speech indexes and acoustic (no-ASR-word) filler candidates."""

from __future__ import annotations

import math
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from itertools import pairwise
from typing import TYPE_CHECKING, Any

import numpy as np

from podcast_mcp.edits.acoustic_gap import (
    AcousticGapConfig,
    AcousticGapRun,
    find_voiced_gap_runs,
)
from podcast_mcp.edits.acoustic_phrase import phrase_hit_indexes, word_silence_ceiling
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.peer_copy_lag import PeerCopyLags
from podcast_mcp.edits.tighten_reasons import (
    ACOUSTIC_FILLER_REASON,
)
from podcast_mcp.edits.voiced_runs import (
    voiced_runs,
)
from podcast_mcp.engines.audio_audit import AnalysisPolicy
from podcast_mcp.models import (
    EpisodeProject,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.dsp import db_to_amplitude, rms_db
from podcast_mcp.util.intervals import HalfOpenIntervalIndex
from podcast_mcp.util.tracks import dialogue_track_ids

if TYPE_CHECKING:
    pass
from podcast_mcp.edits.tighten.candidate import (
    _candidate_order,
    _count_skip,
    _CutCandidate,
    _word_not_owner,
)

# A voiced run needs three voiced probes, so a window that clips a peer's run short can lose it.
_PEER_VOICE_CONTEXT_SEC = 0.1


@dataclass(frozen=True)
class _AcousticPeers:
    """The other dialogue tracks' decodes, and how far each pair's own track trails its copy."""

    caches: Mapping[str, TrackAudioCache]
    lags: PeerCopyLags


def _peer_voiced_at(
    track_id: str,
    own_cache: TrackAudioCache,
    peers: _AcousticPeers,
    start: float,
    end: float,
    defaults: dict[str, Any],
) -> bool:
    """True when a peer's own track carries voice of its own where ``[start, end)`` sounds here.

    Peer occupancy is measured from peer audio, never from its ASR word spans: a
    mistimed word can span seconds of digital silence on a gated track. The runs
    are the same voiced-run evidence the cut gate reads at cut edges.

    A peer's voice reaches this mic before the peer's own track carries it when that track
    trails its copy (``PeerCopyLags``), so the peer is read that much later than the span.
    A peer run that sits ``analysis.heuristics.bleed_dominance_db`` or more under the cut
    track's own level over the same sound is that track's voice bleeding onto the peer's mic,
    each level read as dB over its own track's voice (``LevelProfile.path_reference_db``), so a
    gain change on either file moves nothing (#1523); the audit's own bleed test seen from the other side (#994): the
    peer's copy of this track's voice is read against this track that much later too. A quiet or gated cut
    track never explains a peer run, so a peer carrying a voice the cut track lost still
    blocks (#945).
    """
    margin = _bleed_dominance_db(defaults)
    own_voice_db = own_cache.waveform.profile.path_reference_db
    for peer_id, cache in peers.caches.items():
        peer_voice_db = cache.waveform.profile.path_reference_db
        reach = peers.lags.sec(peer_id, track_id, defaults=defaults)
        copy = peers.lags.sec(track_id, peer_id, defaults=defaults)
        lo, hi = start + reach, end + reach
        for run in voiced_runs(
            cache.waveform,
            lo - _PEER_VOICE_CONTEXT_SEC,
            hi + _PEER_VOICE_CONTEXT_SEC,
            floor_db=cache.profile.voice_floor_db,
        ):
            if run[1] <= lo or run[0] >= hi:
                continue
            own_db = rms_db(
                own_cache.window(run[0] + copy, run[1] + copy),
                floor_db=own_cache.profile.voice_floor_db,
            )
            peer_db = rms_db(cache.window(*run), floor_db=cache.profile.voice_floor_db)
            if (own_db - own_voice_db) - (peer_db - peer_voice_db) < margin:
                return True
    return False


# Acoustic runs keep this much air next to each flanking ASR word, and waveform
# snapping / breath handling may move the cut at most ``_RUN_PAD`` past the run.
_ACOUSTIC_EDGE_MARGIN_SEC = 0.025


_ACOUSTIC_RUN_PAD_SEC = 0.05


_ACOUSTIC_MIN_CUT_SEC = 0.1


def _acoustic_scan_gaps(
    words: list[TranscriptWord], cfg: AcousticGapConfig
) -> Iterator[tuple[TranscriptWord, TranscriptWord]]:
    """Adjacent live word pairs whose gap is long enough to scan."""
    for word, nxt in pairwise(words):
        if word.suppressed or nxt.suppressed or word.end <= word.start or nxt.end <= nxt.start:
            continue
        if nxt.start - word.end >= cfg.min_gap_sec:
            yield word, nxt


def _flanking_speech_rms(
    audio_cache: TrackAudioCache,
    word: TranscriptWord,
    nxt: TranscriptWord,
) -> float | None:
    """Use the quieter of two short word windows as local speech context."""
    floor = db_to_amplitude(audio_cache.profile.voice_floor_db)
    windows = (
        audio_cache.window(max(word.start, word.end - 0.2), word.end),
        audio_cache.window(nxt.start, min(nxt.end, nxt.start + 0.2)),
    )
    levels: list[float] = []
    for samples in windows:
        if not samples.size or not np.all(np.isfinite(samples)):
            return None
        level = float(np.sqrt(np.mean(samples**2)))
        if not math.isfinite(level) or level <= floor:
            return None
        levels.append(level)
    return min(levels)


def _collect_acoustic_candidates(
    words: list[TranscriptWord],
    track_id: str,
    cfg: AcousticGapConfig,
    audio_cache: TrackAudioCache,
    occupied: HalfOpenIntervalIndex,
    *,
    defaults: dict[str, Any],
    peers: _AcousticPeers | None = None,
    skip_counts: dict[str, int] | None = None,
) -> list[_CutCandidate]:
    """Review-only ``filler:acoustic`` candidates for voiced runs in owner gaps.

    A peer voiced where a run sounds makes that run most likely bleed; a peer voiced
    elsewhere in the gap says nothing about it. Three or more runs in a row, each within
    the speaker's longest ordinary silence between words of the next, are a phrase the transcript
    dropped, so none is proposed.
    """
    candidates: list[_CutCandidate] = []
    silence_ceiling = word_silence_ceiling(words, cfg.min_gap_sec)
    for word, nxt in _acoustic_scan_gaps(words, cfg):
        gap_start, gap_end = word.end, nxt.start
        if _word_not_owner(word, track_id) or _word_not_owner(nxt, track_id):
            _count_skip(skip_counts, "acoustic:not_owner")
            continue
        reference = _flanking_speech_rms(audio_cache, word, nxt)

        def count_breath_rejection() -> None:
            _count_skip(skip_counts, "acoustic:breath")

        runs = find_voiced_gap_runs(
            audio_cache,
            gap_start,
            gap_end,
            min_gap_sec=cfg.min_gap_sec,
            max_run_sec=cfg.max_run_sec,
            max_frames=cfg.max_frames,
            vad_backend=cfg.vad_backend,
            defaults=defaults,
            speech_reference_rms=reference,
            on_breath_rejected=count_breath_rejection,
        )
        lo, hi = gap_start + _ACOUSTIC_EDGE_MARGIN_SEC, gap_end - _ACOUSTIC_EDGE_MARGIN_SEC
        own_runs: list[AcousticGapRun] = []
        for run in runs:
            if peers is not None and _peer_voiced_at(
                track_id, audio_cache, peers, run.start, run.end, defaults
            ):
                _count_skip(skip_counts, "acoustic:peer_speaking")
                continue
            own_runs.append(run)
        free = [run for run in own_runs if lo < run.start and run.end < hi]
        phrase = {free[i] for i in phrase_hit_indexes(free, silence_ceiling)}
        for run in own_runs:
            if run in phrase:
                _count_skip(skip_counts, "acoustic:phrase")
                continue
            start, end = max(lo, run.start), min(hi, run.end)
            if end - start < _ACOUSTIC_MIN_CUT_SEC:
                _count_skip(skip_counts, "acoustic:edge_margin")
                continue
            if occupied.overlaps(start, end):
                _count_skip(skip_counts, "acoustic:occupied")
                continue
            candidates.append(
                _CutCandidate(
                    track_id=track_id,
                    start=start,
                    end=end,
                    reason=ACOUSTIC_FILLER_REASON,
                    cut_kind="filler",
                    filler_confidence=run.confidence,
                    min_start=max(lo, start - _ACOUSTIC_RUN_PAD_SEC),
                    max_end=min(hi, end + _ACOUSTIC_RUN_PAD_SEC),
                    review_only=True,
                    likely_laugh=run.likely_laugh,
                )
            )
    return candidates


def _add_acoustic_candidates(
    candidates: list[_CutCandidate],
    transcript: Transcript,
    defaults: dict[str, Any],
    *,
    project: EpisodeProject | None = None,
    audio_cache: TrackAudioCache | None = None,
    audio_caches: Mapping[str, TrackAudioCache] | None = None,
    copy_lags: PeerCopyLags | None = None,
    skip_counts: dict[str, int] | None = None,
) -> list[_CutCandidate]:
    """``candidates`` plus acoustic gap candidates when enabled and audio decoded.

    ``audio_caches`` holds the dialogue tracks' decodes; the other tracks' voiced
    runs decide whether a run is peer bleed, read at the pair's ``copy_lags``.
    """
    cfg = AcousticGapConfig.from_tighten(defaults.get("tighten"))
    if transcript.source_id is not None or not cfg.enabled:
        return candidates
    if audio_cache is None:
        # Decode failures are only logged at debug level; surface the skipped
        # scan when there was something to scan.
        if next(_acoustic_scan_gaps(transcript.words, cfg), None) is not None:
            _count_skip(skip_counts, "acoustic:no_audio")
        return candidates
    occupied = HalfOpenIntervalIndex.build(
        (c.start, c.end) for c in candidates if c.cut_kind != "pause"
    )
    extra = _collect_acoustic_candidates(
        transcript.words,
        transcript.track_id,
        cfg,
        audio_cache,
        occupied,
        defaults=defaults,
        peers=(
            _AcousticPeers(
                _peer_cache_map(project, transcript.track_id, audio_caches),
                copy_lags if copy_lags is not None else PeerCopyLags(project),
            )
            if project is not None
            else None
        ),
        skip_counts=skip_counts,
    )
    if not extra:
        return candidates
    return sorted([*candidates, *extra], key=_candidate_order)


def _bleed_dominance_db(defaults: dict[str, Any]) -> float:
    heuristics = defaults.get("analysis", {}).get("heuristics", {})
    return float(heuristics.get("bleed_dominance_db", AnalysisPolicy.bleed_dominance_db))


def _peer_cache_map(
    project: EpisodeProject,
    track_id: str,
    audio_caches: Mapping[str, TrackAudioCache] | None,
) -> dict[str, TrackAudioCache]:
    """The other dialogue tracks' decodes, by track."""
    if not audio_caches:
        return {}
    return {
        tid: audio_caches[tid]
        for tid in dialogue_track_ids(project)
        if tid != track_id and tid in audio_caches
    }


def _peer_audio_caches(
    project: EpisodeProject,
    track_id: str,
    peer_scoped: bool,
    audio_caches: Mapping[str, TrackAudioCache] | None,
) -> list[TrackAudioCache]:
    """The other dialogue tracks' decodes, when a ripple removes their audio too."""
    if not peer_scoped:
        return []
    return list(_peer_cache_map(project, track_id, audio_caches).values())
