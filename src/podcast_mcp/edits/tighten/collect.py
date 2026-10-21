"""Candidate collection: lexicon fillers, repeats, pauses and acoustic runs."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from podcast_mcp.config.defaults import bounded_float
from podcast_mcp.edits.tighten_reasons import (
    PAUSE_REASON_PREFIX,
)
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    EpisodeProject,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.timebase import SourceSec

if TYPE_CHECKING:
    pass
from podcast_mcp.edits.pause_floor import PeerTrackSpeechIndex, retained_pause_floor_sec
from podcast_mcp.edits.tighten.candidate import (
    _candidate_order,
    _count_skip,
    _CutCandidate,
    _edit_mode,
)
from podcast_mcp.edits.tighten.lexicon import (
    _DISCOURSE_PAUSE_SEC_MAX,
    DEFAULT_DISCOURSE_CONFIDENCE_MAX,
    DEFAULT_DISCOURSE_PAUSE_SEC,
    _adjacent_repeat,
    _adjacent_true_disfluency,
    _backchannel_set,
    _cluster_lexicon_hits,
    _content_use,
    _discourse_marker_set,
    _lexicon,
    _lexicon_phrase_hits,
    _LexiconHit,
    _low_discourse_confidence_span,
    _pause_bounded_span,
    _span_confidence,
)
from podcast_mcp.edits.tighten.repeats import (
    _collect_repetition_candidates,
)


def _pause_trim_end_for_timeline_floor(
    project: EpisodeProject,
    track_id: str,
    gap_start: float,
    gap_end: float,
    floor_sec: float,
) -> float | None:
    timeline = SessionTimeline(project)
    first = timeline.source_to_timeline(track_id, SourceSec(gap_start))
    last = timeline.source_to_timeline(track_id, SourceSec(gap_end))
    if first is None or last is None:
        return None
    pieces = sorted(
        timeline.map_timeline_spans(track_id, first, last), key=lambda p: p.source_start
    )
    remaining = floor_sec
    target = gap_end
    for piece in reversed(pieces):
        lo, hi = max(gap_start, float(piece.source_start)), min(gap_end, float(piece.source_end))
        available = max(0.0, hi - lo)
        if available >= remaining:
            target = hi - remaining
            break
        remaining -= available
        target = lo
    if remaining > 1e-6 and target == gap_start:
        return None
    ends = sorted(
        {
            min(target, float(piece.source_end))
            for piece in pieces
            if piece.source_start <= gap_start + 1e-6
        }
    )
    for end in reversed(ends):
        if (
            end > gap_start + 0.02
            and timeline.exact_source_span(track_id, SourceSec(gap_start), SourceSec(end))
            is not None
        ):
            return end
    return None


def _timeline_pause_gap_sec(
    project: EpisodeProject, track_id: str, gap_start: float, gap_end: float
) -> float:
    """Audible timeline duration remaining in a source word gap.

    ``TranscriptWord`` timestamps stay in source-media seconds even after a
    ripple delete removes the material between them (see
    ``docs/architecture.md`` Timebase), so two words that are adjacent in the
    surviving transcript can still be far apart on the source clock. Map the
    gap through :class:`SessionTimeline` and sum only the spans that still
    have a clip -- material a ripple already deleted contributes nothing.
    """
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.util.timebase import SourceSec

    spans = SessionTimeline(project).map_source_span(
        track_id, SourceSec(gap_start), SourceSec(gap_end)
    )
    return sum(float(end) - float(start) for start, end in spans)


def _collect_filler_candidates(
    words: list[TranscriptWord],
    track_id: str,
    tighten: dict[str, Any],
    *,
    skip_counts: dict[str, int] | None = None,
) -> list[_CutCandidate]:
    """Lexicon filler hits that pass cluster + discourse-safe gates (read-only).

    A hard filler (a ``filler_words`` entry that is not a discourse marker) is a
    candidate on its own unless ``isolated_filler_candidates`` is off; then it
    needs ``min_filler_cluster`` like a discourse marker always does. Backchannel
    phrases are matched in the same pass, win over a filler entry with the same
    text, and are only counted as ``backchannel:{phrase}`` skips.
    """
    fillers = _lexicon(tighten.get("filler_words", []))
    backchannels = _backchannel_set(tighten)
    min_cluster = int(tighten.get("min_filler_cluster", 2))
    isolated_hard = bool(tighten.get("isolated_filler_candidates", True))
    cluster_gap_sec = bounded_float(tighten.get("filler_cluster_gap_sec", 2.0), 2.0, 0.0, 60.0)
    discourse = _discourse_marker_set(tighten)
    pause_sec = bounded_float(
        tighten.get("discourse_pause_sec", DEFAULT_DISCOURSE_PAUSE_SEC),
        DEFAULT_DISCOURSE_PAUSE_SEC,
        0.0,
        _DISCOURSE_PAUSE_SEC_MAX,
    )
    confidence_max = bounded_float(
        tighten.get("discourse_confidence_max", DEFAULT_DISCOURSE_CONFIDENCE_MAX),
        DEFAULT_DISCOURSE_CONFIDENCE_MAX,
        0.0,
        1.0,
    )
    candidates: list[_CutCandidate] = []
    hits: list[_LexiconHit] = []
    # The audibility pass suppresses a half it cannot measure (Whisper's zero-length
    # "-huh."), but the half left is still part of a backchannel, never a filler.
    backchannel_at = {
        i: token
        for start_i, end_i, token in _lexicon_phrase_hits(
            words, backchannels, include_suppressed=True
        )
        for i in range(start_i, end_i + 1)
    }
    for hit in _lexicon_phrase_hits(words, fillers | backchannels):
        start_i, end_i, token = hit
        partial = next(
            (backchannel_at[i] for i in range(start_i, end_i + 1) if i in backchannel_at), None
        )
        if token in backchannels or partial is not None:
            _count_skip(skip_counts, f"backchannel:{partial or token}")
        elif words[end_i].end > words[start_i].start:
            hits.append(hit)
    for group in _cluster_lexicon_hits(words, hits, cluster_gap_sec=cluster_gap_sec):
        clustered = min_cluster <= 1 or len(group) >= min_cluster
        for gi, (start_i, end_i, token) in enumerate(group):
            if token not in discourse:
                keep = clustered or isolated_hard
            elif _content_use(words, end_i, token):
                keep = False
            else:
                keep = clustered and (
                    _adjacent_true_disfluency(words, group, gi, discourse)
                    or _adjacent_repeat(words, group, gi)
                    or _pause_bounded_span(words, start_i, end_i, pause_sec)
                    or _low_discourse_confidence_span(words, start_i, end_i, confidence_max)
                )
            if keep:
                candidates.append(
                    _CutCandidate(
                        track_id=track_id,
                        start=words[start_i].start,
                        end=words[end_i].end,
                        reason=f"filler:{token}",
                        cut_kind="filler",
                        filler_confidence=_span_confidence(words, start_i, end_i),
                    )
                )
            elif token in discourse:
                _count_skip(skip_counts, f"discourse:{token}")
    return candidates


def _collect_candidates(
    transcript: Transcript,
    defaults: dict[str, Any],
    *,
    project: EpisodeProject | None = None,
    skip_counts: dict[str, int] | None = None,
    peer_indexes: dict[str, PeerTrackSpeechIndex] | None = None,
) -> list[_CutCandidate]:
    """Find filler-cluster, repetition, and long-pause candidates (read-only).

    Acoustic gap candidates need decoded audio; add them with
    :func:`_add_acoustic_candidates`.
    """
    if transcript.source_id is not None:
        return []
    tighten = defaults.get("tighten", {})
    max_pause = float(tighten.get("max_pause_sec", 1.2))
    track_id = transcript.track_id
    skip_pauses = _edit_mode(tighten) == "mute"

    words = transcript.words
    candidates = _collect_filler_candidates(words, track_id, tighten, skip_counts=skip_counts)
    if bool(tighten.get("repetition_candidates", True)):
        candidates.extend(_collect_repetition_candidates(words, track_id, tighten))
    for i, word in enumerate(words):
        if word.suppressed:
            continue
        if i + 1 < len(words) and not words[i + 1].suppressed and not skip_pauses:
            gap = words[i + 1].start - word.end
            if gap >= max_pause and gap > 0:
                gap_start, gap_end = word.end, words[i + 1].start
                if project is not None:
                    # A ripple delete leaves no clip over the deleted source range,
                    # so a source-clock gap can span material the listener never
                    # hears any more. Measure what actually remains on the timeline
                    # before proposing a cut sized off the (possibly much larger)
                    # source gap.
                    gap = _timeline_pause_gap_sec(project, track_id, gap_start, gap_end)
                    if gap < max_pause:
                        continue
                    retain, solo = retained_pause_floor_sec(
                        project, track_id, gap_start, gap_end, defaults, peer_indexes
                    )
                    trim_end = _pause_trim_end_for_timeline_floor(
                        project, track_id, gap_start, gap_end, retain
                    )
                else:
                    retain = float(tighten.get("min_retained_pause_sec", 0.18))
                    solo = False
                    trim_end = words[i + 1].start - retain
                if trim_end is not None and trim_end > word.end + 0.02:
                    tag = f"{PAUSE_REASON_PREFIX}{gap:.2f}s"
                    if solo:
                        tag = f"{tag}:solo"
                    candidates.append(
                        _CutCandidate(
                            track_id=track_id,
                            start=word.end,
                            end=trim_end,
                            reason=tag,
                            cut_kind="pause",
                            max_end=trim_end,
                            gap_end=gap_end,
                            pause_sec=gap,
                        )
                    )
    return sorted(candidates, key=_candidate_order)
