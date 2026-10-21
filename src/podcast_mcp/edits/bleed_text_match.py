from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from statistics import median
from typing import Any

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.engines.asr_timing import word_duration_is_anomalous
from podcast_mcp.engines.audio_audit import AnalysisPolicy
from podcast_mcp.engines.bleed_echo import EchoPairProfile
from podcast_mcp.engines.lane_words import WordKey, lane_transcripts, transcript_word_key
from podcast_mcp.models import EpisodeProject, TranscriptWord
from podcast_mcp.util.progress import ProgressReporter
from podcast_mcp.util.wer import normalize_token

# Where the bleed mic's ASR copy of a source word can land relative to the source word.
# The lag is estimated from identical-text twins when there are enough of them; the
# tolerance covers ASR onset error plus the jitter of a network-delayed track
# (measured on the lab tape: twins at -150 ms with 30-40 ms spread, #774).
ECHO_TWIN_MAX_LAG_SEC = 0.5
ECHO_TWIN_TOLERANCE_SEC = 0.15
ECHO_TWIN_MIN_TWINS = 6
_TWIN_BIN_SEC = 0.05


@dataclass(frozen=True)
class EchoTwinPath:
    """One directed bleed path in the transcript's time: the bleed mic's copy of a
    source word starts ``lag_sec`` after the source word (negative when the source's
    own track is delayed, as a Zoom participant's stream is against the host's mic)."""

    source_track_id: str
    bleed_track_id: str
    lag_sec: float
    tolerance_sec: float = ECHO_TWIN_TOLERANCE_SEC
    twins: int = 0

    def is_twin(self, source_start: float, bleed_start: float) -> bool:
        return abs((bleed_start - source_start) - self.lag_sec) <= self.tolerance_sec


@dataclass(frozen=True)
class _LaneWord:
    """A lane's word with its start on the session clock."""

    key: WordKey
    word: TranscriptWord
    start: float


def _lane_words(project: EpisodeProject, track_id: str) -> list[_LaneWord]:
    """Every placed recording's words on a lane, each start on the session clock."""
    out: list[_LaneWord] = []
    for lane in lane_transcripts(project, track_id):
        for i, w in enumerate(lane.transcript.words):
            if (span := lane.session_span(w.start, w.end)) is not None:
                out.append(_LaneWord(transcript_word_key(lane.transcript, i), w, span[0]))
    return out


def _twin_deltas(source_words: list[_LaneWord], bleed_words: list[_LaneWord]) -> list[float]:
    """``bleed.start - source.start`` for every identical-text pair within the search lag."""
    by_token: dict[str, list[float]] = defaultdict(list)
    for lw in source_words:
        if tok := normalize_token(lw.word.text):
            by_token[tok].append(lw.start)
    deltas: list[float] = []
    for lw in bleed_words:
        for start in by_token.get(normalize_token(lw.word.text), ()):
            d = lw.start - start
            if abs(d) <= ECHO_TWIN_MAX_LAG_SEC:
                deltas.append(d)
    return deltas


def echo_twin_path(project: EpisodeProject, profile: EchoPairProfile) -> EchoTwinPath:
    """The transcript-side lag of a measured bleed path.

    With at least ``ECHO_TWIN_MIN_TWINS`` identical-text twins the lag is the median
    delta around their densest 50 ms bin; with fewer, the acoustic lag stands in.
    """
    deltas = _twin_deltas(
        _lane_words(project, profile.source_track_id),
        _lane_words(project, profile.bleed_track_id),
    )
    if len(deltas) < ECHO_TWIN_MIN_TWINS:
        lag = (profile.lag_ms or 0.0) / 1000.0
        return EchoTwinPath(profile.source_track_id, profile.bleed_track_id, lag, twins=0)
    bins = Counter(round(d / _TWIN_BIN_SEC) for d in deltas)
    center = bins.most_common(1)[0][0] * _TWIN_BIN_SEC
    near = [d for d in deltas if abs(d - center) <= ECHO_TWIN_TOLERANCE_SEC]
    return EchoTwinPath(
        profile.source_track_id, profile.bleed_track_id, median(near), twins=len(near)
    )


def echo_twin_paths(
    project: EpisodeProject, profiles: Iterable[EchoPairProfile]
) -> list[EchoTwinPath]:
    """One path per mic pair whose bleed runs one way.

    A pair flagged in both directions has no single source, so it keeps the loudness
    rule and gets no path here.
    """
    directed = {(p.source_track_id, p.bleed_track_id): p for p in profiles}
    return [
        echo_twin_path(project, p)
        for (src, bld), p in directed.items()
        if (bld, src) not in directed
    ]


def _audibility_score(status: str | None) -> int:
    if status == "audible":
        return 3
    if status == "deferred":
        return 2
    if status == "bleed":
        return 1
    if status == "inaudible":
        return 0
    return 1


def _pair_has_anomalous_duration(
    project: EpisodeProject,
    pair: dict[str, Any],
    policy: AnalysisPolicy,
) -> bool:
    for side in ("a", "b"):
        w = pair_word(project, pair_word_key(pair, side))
        if w is not None and word_duration_is_anomalous(
            w.end - w.start, policy.max_word_audibility_sec
        ):
            return True
    return False


def pair_word_key(pair: dict[str, Any], side: str) -> WordKey:
    """The word on side ``"a"`` or ``"b"`` of an ``overlap_duplicate_report`` pair."""
    return (pair[f"track_{side}"], pair[f"source_{side}"], pair[f"word_index_{side}"])


def pair_word(project: EpisodeProject, key: WordKey) -> TranscriptWord | None:
    tid, source_id, i = key
    tr = project.transcript_by_key((tid, source_id))
    return tr.words[i] if tr is not None and i < len(tr.words) else None


def _word_confidence(project: EpisodeProject, key: WordKey) -> float:
    w = pair_word(project, key)
    return w.confidence if w is not None and w.confidence is not None else 1.0


def _pick_text_match_winner(
    pair: dict[str, Any],
    *,
    margin: float = 0.15,
) -> str:
    score_a = _audibility_score(pair.get("status_a"))
    score_b = _audibility_score(pair.get("status_b"))
    conf_a = pair.get("confidence_a", 1.0)
    conf_b = pair.get("confidence_b", 1.0)
    total_a = score_a + conf_a
    total_b = score_b + conf_b
    if abs(total_a - total_b) >= margin:
        return pair["track_a"] if total_a > total_b else pair["track_b"]

    rms_a = pair.get("rms_a_db")
    rms_b = pair.get("rms_b_db")
    if rms_a is not None and rms_b is not None and abs(rms_a - rms_b) >= 0.5:
        return pair["track_a"] if rms_a > rms_b else pair["track_b"]

    if conf_a != conf_b:
        return pair["track_a"] if conf_a > conf_b else pair["track_b"]

    return pair["track_a"]


def overlap_text_match_losers(
    project: EpisodeProject,
    *,
    policy: AnalysisPolicy,
    progress: ProgressReporter | None = None,
    audibility: list[dict[str, Any]] | None = None,
    is_suppressed: Callable[[WordKey], bool] | None = None,
    echo_pairs: Iterable[EchoPairProfile] = (),
    defaults: EffectiveConfig,
) -> list[dict[str, Any]]:
    """The loser of each identical-text overlap across tracks, as a ``bleed`` verdict.

    Pure: nothing is written; reconcile folds each entry into that word's target. Always
    project-wide: a pass's track or window scope bounds what it writes, never which
    partners a word is judged against (#805). ``audibility`` and ``is_suppressed`` are
    those of ``overlap_duplicate_report``; ``is_suppressed`` also rules a word out as a
    loser, so with reconcile's acoustic verdict a stored-suppressed word it is about to
    unsuppress can still lose here.

    ``echo_pairs`` are the mic pairs with a measured bleed path (``echo_risk_pairs``),
    and only those pairs can hold a duplicate: identical words on a pair with no path
    are two people saying the same thing, and both stay (#774). On a pair whose path
    runs one way, loudness says nothing about who spoke, so its identical-text pairs
    are judged by :class:`EchoTwinPath` instead: the bleed mic's word loses when it
    starts at the path's lag from the source mic's word, and identical words at any
    other spacing are two people talking. A pair flagged both ways has no single
    source and keeps the loudness rule.
    """
    if not policy.bleed_text_match_enabled:
        return []

    from podcast_mcp.edits.transcript_reconcile import overlap_duplicate_report

    echo_pairs = list(echo_pairs)
    if not echo_pairs:
        return []
    report = overlap_duplicate_report(
        project,
        policy=policy,
        progress=progress,
        audibility=audibility,
        is_suppressed=is_suppressed,
        defaults=defaults,
    )
    min_overlap = policy.bleed_text_match_min_overlap_sec
    min_dom = policy.bleed_text_match_min_dominance_db
    losers: list[dict[str, Any]] = []
    seen: set[WordKey] = set()
    paths = echo_twin_paths(project, echo_pairs)
    one_way = {frozenset((p.source_track_id, p.bleed_track_id)) for p in paths}
    flagged = {frozenset((p.source_track_id, p.bleed_track_id)) for p in echo_pairs}

    for pair in report.get("pairs", []):
        if not pair.get("text_match"):
            continue
        tracks = frozenset((pair["track_a"], pair["track_b"]))
        if tracks not in flagged or tracks in one_way:
            continue
        if float(pair.get("overlap_sec", 0)) < min_overlap:
            continue
        if _pair_has_anomalous_duration(project, pair, policy):
            continue

        rms_a = pair.get("rms_a_db")
        rms_b = pair.get("rms_b_db")
        if (
            min_dom is not None
            and rms_a is not None
            and rms_b is not None
            and abs(rms_a - rms_b) < min_dom
        ):
            continue

        enriched = {
            **pair,
            "confidence_a": _word_confidence(project, pair_word_key(pair, "a")),
            "confidence_b": _word_confidence(project, pair_word_key(pair, "b")),
        }
        winner = _pick_text_match_winner(enriched)
        if winner == pair["track_a"]:
            loser = pair_word_key(pair, "b")
            dominant = pair["track_a"]
        else:
            loser = pair_word_key(pair, "a")
            dominant = pair["track_b"]

        w = pair_word(project, loser)
        if w is None:
            continue
        suppressed = w.suppressed if is_suppressed is None else is_suppressed(loser)
        if suppressed or w.audibility_locked or loser in seen:
            continue

        seen.add(loser)
        losers.append(
            {
                "track_id": loser[0],
                "source_id": loser[1],
                "word_index": loser[2],
                "text": w.text,
                "start": w.start,
                "end": w.end,
                "audibility_status": "bleed",
                "dominant_track": dominant,
                "reason": "text_match_overlap",
            }
        )

    for path in paths:
        losers.extend(
            _echo_twin_losers(
                project,
                path,
                policy=policy,
                is_suppressed=is_suppressed,
                seen=seen,
            )
        )

    return losers


def _echo_twin_losers(
    project: EpisodeProject,
    path: EchoTwinPath,
    *,
    policy: AnalysisPolicy,
    is_suppressed: Callable[[WordKey], bool] | None,
    seen: set[WordKey],
) -> list[dict[str, Any]]:
    """Bleed-mic words that are the path's copy of a source-mic word with the same text.

    The pair need not overlap in time: on a network-delayed source track the copy
    starts before the source word. Stretched ASR tokens on either side are not
    reliable duplicates and are left alone, as in the overlap rule. A source word
    the caller's verdict already suppresses anchors nothing: its copy is then the
    only place the utterance survives in the transcript.
    """
    src = _lane_words(project, path.source_track_id)
    bld = _lane_words(project, path.bleed_track_id)
    if not src or not bld:
        return []
    max_dur = policy.max_word_audibility_sec

    def suppressed(lw: _LaneWord) -> bool:
        return lw.word.suppressed if is_suppressed is None else is_suppressed(lw.key)

    by_token: dict[str, list[float]] = defaultdict(list)
    for lw in src:
        w = lw.word
        if (
            (tok := normalize_token(w.text))
            and not word_duration_is_anomalous(w.end - w.start, max_dur)
            and not suppressed(lw)
        ):
            by_token[tok].append(lw.start)
    losers: list[dict[str, Any]] = []
    for lw in bld:
        w = lw.word
        if suppressed(lw) or w.audibility_locked or lw.key in seen:
            continue
        if word_duration_is_anomalous(w.end - w.start, max_dur):
            continue
        if not any(path.is_twin(s, lw.start) for s in by_token.get(normalize_token(w.text), ())):
            continue
        seen.add(lw.key)
        losers.append(
            {
                "track_id": path.bleed_track_id,
                "source_id": lw.key[1],
                "word_index": lw.key[2],
                "text": w.text,
                "start": w.start,
                "end": w.end,
                "audibility_status": "bleed",
                "dominant_track": path.source_track_id,
                "reason": "echo_twin",
            }
        )
    return losers
