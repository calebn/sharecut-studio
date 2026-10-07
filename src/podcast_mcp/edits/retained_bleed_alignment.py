from __future__ import annotations

import hashlib
import json
import math
import wave
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from uuid import NAMESPACE_URL, uuid5

import numpy as np

from podcast_mcp.edits.clips_ops import (
    clips_for_track,
    punch_timeline_range_from_clips,
    set_track_clips,
    split_clip_at,
)
from podcast_mcp.edits.conversation_align import ingest_alignment_entry
from podcast_mcp.edits.timeline_ops import move_clips
from podcast_mcp.engines.bleed_delay import LongDelayConfig, measure_long_delay_regions
from podcast_mcp.engines.bleed_gate import bleed_gate_payload, build_bleed_gate_plan
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    clip_media_key,
    clip_timeline_overlap_to_source,
)
from podcast_mcp.engines.timeline_render import resolve_clip_audio_path
from podcast_mcp.engines.ungated_audio import (
    raw_evidence_layout_reason,
    raw_timeline_window,
)
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    RetainedBleedAlignmentDecision,
    TrackRole,
    TranscriptGateScope,
    TranscriptWord,
)
from podcast_mcp.models.project_format import snapshot_editable_state
from podcast_mcp.util.dsp import bool_runs
from podcast_mcp.util.intervals import HalfOpenIntervalIndex, merge_intervals
from podcast_mcp.util.process import CalledProcessError
from podcast_mcp.util.timebase import SourceSec
from podcast_mcp.util.wav import open_wav

EVIDENCE_REVISION = 5
_RATE = 8000
_FULL_RATE = 48_000
_QUIET_PEAK = 3 / 32768
_SEAM_PAD = 0.02
_MAX_RESIDUAL_MS = 2.0
_MAX_PHRASE_SEC = 30.0
_MAX_PHRASES = 64
_INTERNAL_FADE_MS = 5


@dataclass(frozen=True)
class PhraseAlignmentProposal:
    decision_id: str
    direct_track_id: str
    bleed_track_id: str
    clip_id: str
    source_id: str | None
    source_start: float
    source_end: float
    phrase_source_start: float
    phrase_source_end: float
    previous_timeline_start: float
    timeline_start: float
    offset_sec: float
    provenance: Literal["automatic", "requested_scoped_override"]
    validation_windows: int
    max_residual_ms: float
    reference_track_ids: tuple[str, ...] = ()
    media_key: str | None = None


@dataclass(frozen=True)
class AlignmentPlan:
    fingerprint: str
    proposals: tuple[PhraseAlignmentProposal, ...] = ()
    skipped: tuple[dict[str, str], ...] = ()


def _fingerprint(project: EpisodeProject) -> str:
    state = {
        "revision": EVIDENCE_REVISION,
        "editable": snapshot_editable_state(project),
        "sources": [bleed_gate_payload(project, track.id) for track in project.tracks],
    }
    return hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()


def _normalize_media_key(project: EpisodeProject, key: str) -> str:
    if key.startswith("sha256:") and len(key) == 71:
        return key
    root = Path(project.meta.workspace_dir).resolve()
    path = (root / key).resolve()
    normalized = path.relative_to(root).as_posix() if path.is_relative_to(root) else path.as_posix()
    return "sha256:" + hashlib.sha256(normalized.encode()).hexdigest()


def _recording_key(project: EpisodeProject, track_id: str, source_id: str | None) -> str:
    selection = Clip(
        id="recording-identity",
        track_id=track_id,
        source_id=source_id,
        source_start=0,
        source_end=0,
        timeline_start=0,
    )
    return _normalize_media_key(project, clip_media_key(project, selection))


@dataclass(frozen=True)
class _OwnPhrase:
    source_id: str | None
    start: float
    end: float


@dataclass(frozen=True)
class _PhraseCandidate:
    direct_track_id: str
    bleed_track_id: str
    phrase: _OwnPhrase


class _EvidenceBudgetExhausted(Exception):
    pass


@dataclass
class _EvidenceBudget:
    remaining: int = _MAX_PHRASES

    def require(self, units: int) -> None:
        if units > self.remaining:
            raise _EvidenceBudgetExhausted

    def spend(self, units: int = 1) -> None:
        self.require(units)
        self.remaining -= units


def _word_has_foreign_attribution(word: TranscriptWord, track_id: str) -> bool:
    return (
        word.audibility_status == "bleed"
        or word.dominant_track not in (None, "", track_id)
        or word.speaker_match_track not in (None, "", track_id)
    )


def _own_phrases(project: EpisodeProject, track_id: str) -> list[_OwnPhrase]:
    timeline = SessionTimeline(project)
    phrases: list[_OwnPhrase] = []
    for source_id, transcript in project.selected_source_transcripts(track_id):
        words = [
            word
            for word in transcript.words
            if not word.suppressed
            and not word.ignored
            and not _word_has_foreign_attribution(word, track_id)
        ]
        mapped = timeline.map_selected_source_spans(
            track_id, source_id, [(SourceSec(word.start), SourceSec(word.end)) for word in words]
        )
        phrases.extend(
            _OwnPhrase(source_id, float(start), float(end))
            for start, end in merge_intervals(
                ((float(start), float(end)) for spans in mapped for start, end in spans), gap=0.3
            )
        )
    return sorted(phrases, key=lambda phrase: (phrase.start, phrase.end, phrase.source_id or ""))


def _complete_phrase(
    project: EpisodeProject, track_id: str, start: float, end: float, extent: float
) -> tuple[float, float] | None:
    if end - start > _MAX_PHRASE_SEC:
        return None
    lower, upper = max(0.0, start - 0.6), min(extent, end + 0.6)
    samples = raw_timeline_window(
        project, track_id, lower, upper, sample_rate=_FULL_RATE, preserve_channels=True
    )
    frame = round(0.01 * _FULL_RATE)
    complete_frames = samples.shape[0] // frame
    levels = np.max(
        np.abs(samples[: complete_frames * frame].reshape(complete_frames, frame, -1)), axis=(1, 2)
    )
    runs = [(lower + lo * 0.01, lower + hi * 0.01) for lo, hi in bool_runs(levels > _QUIET_PEAK)]
    touching = [(lo, hi) for lo, hi in runs if lo < end and hi > start]
    if not touching:
        return None
    lo, hi = touching[0][0], touching[-1][1]
    if lo <= lower + 0.01 or hi >= upper - 0.01:
        return None
    if hi - lo > _MAX_PHRASE_SEC:
        return None
    return round(lo, 9), round(hi, 9)


def _quiet(project: EpisodeProject, tid: str, start: float, end: float) -> bool:
    if start < 0 or end <= start:
        return False
    samples = raw_timeline_window(
        project, tid, start, end, sample_rate=_FULL_RATE, preserve_channels=True
    )
    return bool(np.all(np.abs(samples) <= _QUIET_PEAK))


def _quiet_fringe(start: float, end: float, offset: float) -> tuple[float, float]:
    return (start + offset, start) if offset < 0 else (end, end + offset)


def _retained_words_survive_trim(
    project: EpisodeProject, track_id: str, start: float, end: float
) -> bool:
    transcripts = project.selected_source_transcripts(track_id)
    if not transcripts or any(
        project.transcript_for_source(track_id, clip.source_id) is None
        for clip in clips_for_track(project, track_id)
        if clip_timeline_overlap_to_source(clip, start, end) is not None
    ):
        return False
    future = project.model_copy()
    future.timeline = project.timeline.model_copy(
        update={
            "clips": [clip for clip in project.clips if clip.track_id != track_id]
            + punch_timeline_range_from_clips(clips_for_track(project, track_id), start, end)
        }
    )
    before, after = SessionTimeline(project), SessionTimeline(future)
    for source_id, transcript in transcripts:
        words = [word for word in transcript.words if not word.suppressed and not word.ignored]
        bounds = [(SourceSec(word.start), SourceSec(word.end)) for word in words]
        old_spans = before.map_selected_source_spans(track_id, source_id, bounds)
        new_spans = after.map_selected_source_spans(track_id, source_id, bounds)
        for old_word, new_word in zip(old_spans, new_spans, strict=True):
            old = sum(hi - lo for lo, hi in old_word)
            new = sum(hi - lo for lo, hi in new_word)
            if new < old - 1e-9:
                return False
    return True


def _placement_locked(project: EpisodeProject, track_id: str, clip_id: str) -> bool:
    track = project.track_by_id(track_id)
    if track is None:
        return True
    clip = next((clip for clip in project.clips if clip.id == clip_id), None)
    if clip is None:
        return True
    entry = ingest_alignment_entry(project, track, clip)
    return entry is not None and entry.align_method == "manual"


def _decision(
    proposal: PhraseAlignmentProposal, *, applied: bool
) -> RetainedBleedAlignmentDecision:
    return RetainedBleedAlignmentDecision(
        id=proposal.decision_id,
        direct_track_id=proposal.direct_track_id,
        bleed_track_id=proposal.bleed_track_id,
        source_id=proposal.source_id,
        media_key=proposal.media_key,
        start_s=proposal.phrase_source_start,
        end_s=proposal.phrase_source_end,
        offset_sec=proposal.offset_sec if applied else 0.0,
        previous_timeline_start=proposal.previous_timeline_start,
        timeline_start=proposal.timeline_start if applied else proposal.previous_timeline_start,
        provenance=proposal.provenance,
        evidence_revision=EVIDENCE_REVISION,
    )


@dataclass(frozen=True)
class _RegionDelay:
    offset_sec: float = 0
    validation_windows: int = 0
    max_residual_ms: float = 0
    reason: str | None = None


def _local_delay(
    project: EpisodeProject,
    direct_id: str,
    peer_id: str,
    start: float,
    end: float,
    *,
    phrase_start: float,
    phrase_end: float,
) -> _RegionDelay:
    config = LongDelayConfig(
        min_ncc=0.25,
        max_windows=10,
        null_shifts_sec=(-13.1, -7.3, -3.1, -1.3, 1.3, 3.1, 7.3, 13.1),
        min_null_windows=1,
    )
    context = config.max_lag_sec + max(abs(shift) for shift in config.null_shifts_sec)
    lower = max(0.0, start - context)
    upper = min(max(clip.timeline_end for clip in project.clips), end + context)
    audio: dict[str, np.ndarray] = {}
    for tid in (direct_id, peer_id):
        layout_reason = raw_evidence_layout_reason(project, tid)
        if layout_reason is not None:
            return _RegionDelay(reason=layout_reason)
        audio[tid] = raw_timeline_window(project, tid, lower, upper, sample_rate=_RATE)
    rows = measure_long_delay_regions(
        audio[direct_id],
        audio[peer_id],
        sample_rate=_RATE,
        t0=lower,
        source_track_id=direct_id,
        bleed_track_id=peer_id,
        start_sec=start,
        end_sec=end,
        config=config,
    )
    audio.clear()
    delays = [row.lag_ms for row in rows if row.supported and row.lag_ms is not None]
    if len(delays) < 3:
        return _RegionDelay(reason="insufficient_local_evidence")
    median = float(np.median(delays[:-1]))
    residual = max(abs(value - median) for value in delays)
    if residual > _MAX_RESIDUAL_MS:
        return _RegionDelay(reason="inconsistent_local_delay")
    offset = round(median / 1000, 9)
    supported = [row for row in rows if row.supported]
    if not all(
        any(row.start <= endpoint <= row.end for row in supported)
        for endpoint in (phrase_start + offset, phrase_end + offset)
    ):
        return _RegionDelay(reason="insufficient_endpoint_evidence")
    if any(
        not row.supported and row.start < phrase_end + offset and row.end > phrase_start + offset
        for row in rows
    ):
        return _RegionDelay(reason="unsupported_phrase_interior")
    return _RegionDelay(offset, len(delays), residual)


def _retained_peers(
    project: EpisodeProject,
    direct_id: str,
    start: float,
    end: float,
    hard_plans: dict[str, tuple[tuple[float, float], ...]] | None,
) -> set[str]:
    timeline = SessionTimeline(project)
    peers: set[str] = set()
    for peer_track in project.tracks:
        if peer_track.muted:
            continue
        for source_id, transcript in project.selected_source_transcripts(peer_track.id):
            for word in transcript.words:
                if (
                    not word.suppressed
                    or word.audibility_status != "bleed"
                    or word.dominant_track != direct_id
                    or word.ignored
                ):
                    continue
                for lo, hi in timeline.map_selected_source_span(
                    peer_track.id, source_id, SourceSec(word.start), SourceSec(word.end)
                ):
                    if lo >= end + 0.5 or hi <= start - 0.5:
                        continue
                    if hard_plans is None:
                        peers.add(peer_track.id)
                        continue
                    if peer_track.id not in hard_plans:
                        hard_plans[peer_track.id] = build_bleed_gate_plan(
                            project, peer_track.id
                        ).attenuation_spans
                    if not any(a <= lo and b >= hi for a, b in hard_plans[peer_track.id]):
                        peers.add(peer_track.id)
    return peers


def plan_retained_bleed_alignment(
    project: EpisodeProject,
    *,
    start_sec: float | None = None,
    end_sec: float | None = None,
    track_id: str | None = None,
    override_placement_lock: bool = False,
) -> AlignmentPlan:
    """Propose only complete direct phrases with quiet slack and independently stable lag.

    ``track_id`` selects the retained-bleed lane. Explicit finite start/end and lane
    also discover retained direct owner phrases without copy-word seeds. This path
    budgets all local evidence and requires active peers to validate or veto.
    Scoped override may bypass legacy recorder locks; saved fine choices still win.
    """
    if override_placement_lock and (start_sec is None or end_sec is None):
        raise ValueError("placement override requires an explicit scoped window")
    lower = 0.0 if start_sec is None else start_sec
    upper = (
        max(
            (clip.timeline_end for clip in project.clips),
            default=max(
                (track.media.duration_sec or 0 for track in project.tracks if track.media),
                default=0.0,
            ),
        )
        if end_sec is None
        else end_sec
    )
    if not math.isfinite(lower) or not math.isfinite(upper):
        raise ValueError("alignment window bounds must be finite")
    if lower < 0 or (upper <= lower and (end_sec is not None or project.clips)):
        raise ValueError("alignment window must have nonnegative start and increasing end")
    if not project.clips:
        return AlignmentPlan(
            _fingerprint(project),
            skipped=tuple(
                {"track_id": track.id, "reason": "unsupported_implicit_timeline_alignment"}
                for track in project.tracks
                if track_id is None or track.id == track_id
            ),
        )
    bounded = track_id is not None and start_sec is not None and end_sec is not None
    extent = max(clip.timeline_end for clip in project.clips)
    timeline = SessionTimeline(project)
    proposals: list[PhraseAlignmentProposal] = []
    skipped: list[dict[str, str]] = []
    seen: set[tuple[str, str | None, float, float]] = set()
    completed: set[tuple[str, str, float, float, float]] = set()
    hard_plans: dict[str, tuple[tuple[float, float], ...]] = {}
    phrase_indexes: dict[str, tuple[list[_OwnPhrase], HalfOpenIntervalIndex]] = {}
    budget = _EvidenceBudget(_MAX_PHRASES)

    def skip(tid: str, reason: str) -> None:
        row = {"track_id": tid, "reason": reason}
        if row not in skipped:
            skipped.append(row)

    def finish() -> AlignmentPlan:
        safe, conflicts = _safe_batch_proposals(tuple(proposals))
        for tid, reason in conflicts:
            skip(tid, reason)
        return AlignmentPlan(_fingerprint(project), safe, tuple(skipped))

    def phrases_for(direct_id: str) -> tuple[list[_OwnPhrase], HalfOpenIntervalIndex]:
        if direct_id not in phrase_indexes:
            phrases = _own_phrases(project, direct_id)
            phrase_indexes[direct_id] = (
                phrases,
                HalfOpenIntervalIndex.build((phrase.start, phrase.end) for phrase in phrases),
            )
        return phrase_indexes[direct_id]

    def candidates_for(bleed_id: str) -> Iterator[_PhraseCandidate]:
        transcripts = project.selected_source_transcripts(bleed_id)
        if not bounded:
            hard_plans[bleed_id] = build_bleed_gate_plan(project, bleed_id).attenuation_spans
        has_candidate = False
        for source_id, transcript in transcripts:
            for word in transcript.words:
                if (
                    not word.suppressed
                    or word.audibility_status != "bleed"
                    or not word.dominant_track
                    or word.dominant_track == bleed_id
                    or word.ignored
                    or word.audibility_locked
                ):
                    continue
                if budget.remaining == 0:
                    skip(word.dominant_track, "alignment_evidence_budget_exhausted")
                    return
                for start, end in timeline.map_selected_source_span(
                    bleed_id, source_id, SourceSec(word.start), SourceSec(word.end)
                ):
                    lo, hi = max(lower, float(start)), min(upper, float(end))
                    if hi <= lo:
                        continue
                    has_candidate = True
                    if not bounded and any(a <= lo and b >= hi for a, b in hard_plans[bleed_id]):
                        continue
                    phrases, index = phrases_for(word.dominant_track)
                    matches = index.overlapping_ordinals(lo - 0.5, hi + 0.5)
                    if not matches:
                        skip(
                            word.dominant_track,
                            "unmatched_direct_retained_phrase"
                            if phrases
                            else "missing_direct_retained_phrase",
                        )
                    for ordinal in matches:
                        yield _PhraseCandidate(word.dominant_track, bleed_id, phrases[ordinal])
        if bounded:
            for direct in sorted(project.tracks, key=lambda track: track.id):
                if direct.id == bleed_id or direct.muted or direct.role != TrackRole.DIALOGUE:
                    continue
                if not any(
                    clip.track_id == direct.id
                    and clip.timeline_start < upper
                    and clip.timeline_end > lower
                    for clip in project.clips
                ):
                    continue
                phrases, _index = phrases_for(direct.id)
                if not phrases:
                    skip(direct.id, "missing_direct_retained_phrase")
                for phrase in phrases:
                    if phrase.start >= lower and phrase.end <= upper:
                        has_candidate = True
                        yield _PhraseCandidate(direct.id, bleed_id, phrase)
        if not has_candidate:
            skip(bleed_id, "no_retained_bleed_candidate")

    def validate(candidate: _PhraseCandidate) -> PhraseAlignmentProposal | None:
        direct_id = candidate.direct_track_id
        bleed_track = project.track_by_id(candidate.bleed_track_id)
        assert bleed_track is not None
        seed_start, seed_end = candidate.phrase.start, candidate.phrase.end
        clips = [
            clip
            for clip in project.clips
            if clip.track_id == direct_id
            and clip.timeline_start <= seed_start
            and clip.timeline_end >= seed_end
        ]
        if len(clips) != 1:
            skip(direct_id, "unsafe_phrase_boundaries")
            return None
        clip = clips[0]
        if clip.source_id != candidate.phrase.source_id:
            skip(direct_id, "unsafe_phrase_boundaries")
            return None
        direct_track = project.track_by_id(direct_id)
        if direct_track is None:
            return None
        if direct_track.muted:
            skip(direct_id, "saved_mix_mute")
            return None
        layout_reason = raw_evidence_layout_reason(
            project, direct_id
        ) or raw_evidence_layout_reason(project, bleed_track.id)
        if layout_reason is not None:
            skip(direct_id, layout_reason)
            return None
        mapped_seed = clip_timeline_overlap_to_source(clip, seed_start, seed_end)
        if mapped_seed is None:
            return None
        media_key = _recording_key(project, direct_id, clip.source_id)
        decisions = [
            d
            for d in project.editorial.retained_bleed_alignments
            if d.direct_track_id == direct_id
            and (
                _normalize_media_key(project, d.media_key)
                if d.media_key is not None
                else _recording_key(project, d.direct_track_id, d.source_id)
            )
            == media_key
            and d.start_s < float(mapped_seed[1])
            and d.end_s > float(mapped_seed[0])
        ]
        locked = next((d for d in decisions if d.mode != "auto"), None)
        if locked is not None:
            skip(direct_id, f"saved_{locked.mode}_decision")
            return None
        if _placement_locked(project, direct_id, clip.id) and not override_placement_lock:
            skip(direct_id, "manual_recorder_placement")
            return None
        try:
            with open_wav(resolve_clip_audio_path(project, direct_track, clip)) as media:
                if (
                    media.getnchannels() not in (1, 2)
                    or media.getsampwidth() != 2
                    or media.getframerate() > _FULL_RATE
                ):
                    skip(direct_id, "unsupported_source_evidence_format")
                    return None
            complete = _complete_phrase(project, direct_id, seed_start, seed_end, clip.timeline_end)
            if complete is None:
                skip(direct_id, "unsafe_phrase_boundaries")
                return None
            phrase_start, phrase_end = complete
            phrase_source = clip_timeline_overlap_to_source(clip, phrase_start, phrase_end)
            if phrase_source is None:
                return None
            transcript = project.transcript_for_source(direct_id, clip.source_id)
            if transcript is None:
                skip(direct_id, "missing_direct_retained_phrase")
                return None
            if any(
                _word_has_foreign_attribution(word, direct_id)
                and word.start < float(phrase_source[1])
                and word.end > float(phrase_source[0])
                for word in transcript.words
            ):
                skip(direct_id, "foreign_attribution_in_direct_phrase")
                return None
            geometry = (
                direct_id,
                media_key,
                float(phrase_source[0]),
                float(phrase_source[1]),
                phrase_start,
            )
            if geometry in completed:
                return None
            if bounded:
                completed.add(geometry)
                budget.spend()
            delay = _local_delay(
                project,
                direct_id,
                bleed_track.id,
                max(lower, phrase_start - 0.5),
                min(upper, phrase_end + 0.5),
                phrase_start=phrase_start,
                phrase_end=phrase_end,
            )
            if delay.reason is not None:
                skip(direct_id, delay.reason)
                return None
            offset = delay.offset_sec
            peer_conflict = False
            reference_peers = _retained_peers(
                project, direct_id, phrase_start, phrase_end, None if bounded else hard_plans
            ) | {bleed_track.id}
            unknown_peers: set[str] = set()
            if bounded:
                peer_start = max(0.0, phrase_start - 0.5)
                peer_end = min(extent, phrase_end + 0.5)
                unknown_peers = {
                    track.id
                    for track in project.tracks
                    if not track.muted
                    and track.id not in {direct_id, bleed_track.id}
                    and any(
                        clip.track_id == track.id
                        and clip.timeline_start < peer_end
                        and clip.timeline_end > peer_start
                        for clip in project.clips
                    )
                } - reference_peers
                budget.require(2 * len(unknown_peers) + len(reference_peers - {bleed_track.id}) + 2)
            for peer in sorted((reference_peers - {bleed_track.id}) | unknown_peers):
                if bounded and peer in unknown_peers:
                    layout_reason = raw_evidence_layout_reason(project, peer)
                    if layout_reason is not None:
                        skip(direct_id, layout_reason)
                        return None
                    budget.spend()
                    if _quiet(project, peer, peer_start, peer_end):
                        continue
                if bounded:
                    budget.spend()
                peer_delay = _local_delay(
                    project,
                    direct_id,
                    peer,
                    max(lower, phrase_start - 0.5),
                    min(upper, phrase_end + 0.5),
                    phrase_start=phrase_start,
                    phrase_end=phrase_end,
                )
                if peer_delay.reason is not None:
                    skip(
                        direct_id,
                        peer_delay.reason
                        if peer_delay.reason == "unsupported_crossfade_evidence_clock"
                        else "unverified_retained_bleed_peer",
                    )
                    peer_conflict = True
                    break
                reference_peers.add(peer)
                if abs(peer_delay.offset_sec - offset) * 1000 > _MAX_RESIDUAL_MS:
                    skip(direct_id, "conflicting_retained_bleed_delays")
                    peer_conflict = True
                    break
            if peer_conflict:
                return None
            if abs(offset) <= 0.002:
                return None
            slack = abs(offset) + _SEAM_PAD
            if bounded:
                budget.spend(2)
            if not _quiet(project, direct_id, phrase_start - slack, phrase_start) or not _quiet(
                project, direct_id, phrase_end, phrase_end + slack
            ):
                skip(direct_id, "unsafe_phrase_boundaries")
                return None
        except (OSError, ValueError, wave.Error, CalledProcessError):
            skip(direct_id, "unavailable_source_evidence")
            return None
        old_start, old_end = phrase_start - _SEAM_PAD, phrase_end + _SEAM_PAD
        new_start = old_start + offset
        if (
            min(old_start, new_start) - _INTERNAL_FADE_MS / 1000 < lower
            or max(old_end, old_end + offset) + _INTERNAL_FADE_MS / 1000 > upper
            or old_start < clip.timeline_start
            or old_end > clip.timeline_end
        ):
            skip(direct_id, "correction_outside_scope")
            return None
        fringe_start, fringe_end = _quiet_fringe(old_start, old_end, offset)
        if not _retained_words_survive_trim(project, direct_id, fringe_start, fringe_end):
            skip(direct_id, "quiet_trim_would_remove_retained_word")
            return None
        source = clip_timeline_overlap_to_source(clip, old_start, old_end)
        if source is None or phrase_source is None:
            return None
        identity = f"{direct_id}:{bleed_track.id}:{media_key}:{float(phrase_source[0]):.9f}:{float(phrase_source[1]):.9f}"
        proposal = PhraseAlignmentProposal(
            str(uuid5(NAMESPACE_URL, identity)),
            direct_id,
            bleed_track.id,
            clip.id,
            clip.source_id,
            float(source[0]),
            float(source[1]),
            float(phrase_source[0]),
            float(phrase_source[1]),
            old_start,
            new_start,
            offset,
            "requested_scoped_override" if override_placement_lock else "automatic",
            delay.validation_windows,
            delay.max_residual_ms,
            tuple(sorted(reference_peers)),
            media_key,
        )
        completed.add(geometry)
        return proposal

    for bleed_track in project.tracks:
        if track_id is not None and bleed_track.id != track_id:
            continue
        if bleed_track.muted:
            skip(bleed_track.id, "saved_mix_mute")
            continue
        if not any(
            clip.track_id == bleed_track.id
            and clip.timeline_start < upper
            and clip.timeline_end > lower
            for clip in project.clips
        ):
            continue
        for candidate in candidates_for(bleed_track.id):
            phrase = candidate.phrase
            key = (candidate.direct_track_id, phrase.source_id, phrase.start, phrase.end)
            if key in seen:
                continue
            try:
                budget.spend()
                seen.add(key)
                proposal = validate(candidate)
            except _EvidenceBudgetExhausted:
                skip(candidate.direct_track_id, "alignment_evidence_budget_exhausted")
                return finish()
            if proposal is not None:
                proposals.append(proposal)
    return finish()


def _safe_batch_proposals(
    proposals: tuple[PhraseAlignmentProposal, ...],
) -> tuple[tuple[PhraseAlignmentProposal, ...], tuple[tuple[str, str], ...]]:
    conflicts: set[int] = set()
    reasons: set[tuple[str, str]] = set()
    margin = _INTERNAL_FADE_MS / 1000
    footprints = [
        (
            min(proposal.previous_timeline_start, proposal.timeline_start) - margin,
            max(proposal.previous_timeline_start, proposal.timeline_start)
            + proposal.source_end
            - proposal.source_start
            + margin,
        )
        for proposal in proposals
    ]
    index = HalfOpenIntervalIndex.build(footprints)
    for ordinal, proposal in enumerate(proposals):
        for other in index.overlapping_ordinals(*footprints[ordinal]):
            if other != ordinal and proposals[other].direct_track_id == proposal.direct_track_id:
                conflicts.update((ordinal, other))
                reasons.add((proposal.direct_track_id, "conflicting_phrase_corrections"))
        reference_start = proposal.timeline_start - margin
        reference_end = (
            proposal.timeline_start + proposal.source_end - proposal.source_start + margin
        )
        references = set(proposal.reference_track_ids) | {proposal.bleed_track_id}
        for other in index.overlapping_ordinals(reference_start, reference_end):
            if other != ordinal and proposals[other].direct_track_id in references:
                conflicts.update((ordinal, other))
                for affected in (proposal, proposals[other]):
                    reasons.add((affected.direct_track_id, "conflicting_phrase_dependencies"))
    return (
        tuple(proposal for ordinal, proposal in enumerate(proposals) if ordinal not in conflicts),
        tuple(sorted(reasons)),
    )


def apply_retained_bleed_alignment(project: EpisodeProject, plan: AlignmentPlan) -> dict[str, Any]:
    """Apply a checked plan atomically in memory; caller owns workspace history/publication."""
    if _fingerprint(project) != plan.fingerprint:
        raise ValueError("retained-bleed alignment plan is stale")
    proposals, conflicts = _safe_batch_proposals(plan.proposals)
    skipped = list(plan.skipped)
    for tid, reason in conflicts:
        row = {"track_id": tid, "reason": reason}
        if row not in skipped:
            skipped.append(row)
    if not proposals:
        return {"applied_count": 0, "alignments": [], "skipped": skipped}
    working = project.model_copy(deep=True)
    results: list[dict[str, Any]] = []
    for proposal in proposals:
        lo = proposal.previous_timeline_start
        hi = lo + proposal.source_end - proposal.source_start
        for boundary in (lo, hi):
            for clip in working.clips:
                if (
                    clip.track_id == proposal.direct_track_id
                    and clip.timeline_start < boundary < clip.timeline_end
                ):
                    before, after = split_clip_at(clip, boundary)
                    before.fade_out_ms = after.fade_in_ms = _INTERNAL_FADE_MS
                    lane = [
                        part
                        for existing in clips_for_track(working, proposal.direct_track_id)
                        for part in ((before, after) if existing.id == clip.id else (existing,))
                    ]
                    set_track_clips(working, proposal.direct_track_id, lane)
                    break
        fringe_start, fringe_end = _quiet_fringe(lo, hi, proposal.offset_sec)
        lane = clips_for_track(working, proposal.direct_track_id)
        quiet_sources = [
            TranscriptGateScope(
                source_id=clip.source_id, start_s=float(span[0]), end_s=float(span[1])
            )
            for clip in lane
            if (span := clip_timeline_overlap_to_source(clip, fringe_start, fringe_end)) is not None
        ]
        trimmed = punch_timeline_range_from_clips(lane, fringe_start, fringe_end)
        for clip in trimmed:
            if abs(clip.timeline_end - fringe_start) < 1e-9:
                clip.fade_out_ms = _INTERNAL_FADE_MS
            if abs(clip.timeline_start - fringe_end) < 1e-9:
                clip.fade_in_ms = _INTERNAL_FADE_MS
        set_track_clips(working, proposal.direct_track_id, trimmed)
        middle = next(
            clip
            for clip in working.clips
            if clip.track_id == proposal.direct_track_id
            and abs(clip.source_start - proposal.source_start) < 1e-8
            and abs(clip.source_end - proposal.source_end) < 1e-8
            and clip.source_id == proposal.source_id
            and abs(clip.timeline_start - proposal.previous_timeline_start) < 1e-8
        )
        move_clips(
            working,
            [
                {
                    "clip_id": middle.id,
                    "track_id": middle.track_id,
                    "timeline_start": proposal.timeline_start,
                }
            ],
        )
        working.editorial.edit_log[-1].params["quiet_trim"] = {
            "reason": "verified_quiet_destination_overlap",
            "source_ranges": [span.model_dump(mode="json") for span in quiet_sources],
        }
        decision = _decision(proposal, applied=True)
        working.editorial.retained_bleed_alignments = [
            d for d in working.editorial.retained_bleed_alignments if d.id != decision.id
        ] + [decision]
        results.append(
            {
                "decision_id": decision.id,
                "direct_track_id": decision.direct_track_id,
                "bleed_track_id": decision.bleed_track_id,
                "source_id": decision.source_id,
                "source_start": proposal.source_start,
                "source_end": proposal.source_end,
                "previous_timeline_start": proposal.previous_timeline_start,
                "timeline_start": proposal.timeline_start,
                "offset_sec": proposal.offset_sec,
            }
        )
    project.timeline = working.timeline
    project.editorial = working.editorial
    project.transcript_data = working.transcript_data
    project.meta.ingest_alignment = working.meta.ingest_alignment
    return {"applied_count": len(results), "alignments": results, "skipped": skipped}


def set_retained_bleed_alignment_mode(
    project: EpisodeProject,
    decision_id: str,
    mode: Literal["auto", "manual", "declined"],
    *,
    proposal: PhraseAlignmentProposal | None = None,
) -> dict[str, Any]:
    if mode not in ("auto", "manual", "declined"):
        raise ValueError("alignment mode must be auto, manual, or declined")
    decision = next(
        (d for d in project.editorial.retained_bleed_alignments if d.id == decision_id), None
    )
    if decision is None:
        if proposal is None or proposal.decision_id != decision_id:
            raise ValueError(f"unknown retained-bleed alignment decision {decision_id!r}")
        decision = _decision(proposal, applied=False)
        project.editorial.retained_bleed_alignments.append(decision)
    decision.mode = mode
    return decision.model_dump(mode="json")
