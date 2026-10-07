"""Word starts still missing from their own track after alignment (#1059).

Bleed is never used as audio for another speaker (#945, #1037). So where a speaker's own
track opens after their voice has already reached another mic, the start of that word is
missing from the mix: a call app's gate opened late, or the lane sits at an offset
``align_tracks`` could not solve or did not apply. This finds each such word from audio,
snaps its start to where its own track opens (as #979 trims a word onto its voice, the old
span stays in ``trimmed_from``), and leaves a timeline comment so the host can re-record,
keep or edit around it.

Everything is read on the timeline, after alignment, from level envelopes on the
bleed-latency grid. Every threshold is relative to what the episode measures about itself:

* **Copy path.** An ordered pair whose direct track follows its copy on the other mic at
  one lag (``bleed_latency.measure_pair``: consistent or drifting), re-measured where the
  lanes now sit, so an aligned lane reads about 0 and an unaligned one its offset. A pair
  with no lag (scattered or no bleed) cannot tell the lane's copy from the mic's own sound,
  so it never flags. The coupling is the median of mic minus direct level over the frames
  that measurement uses; the spread is their 95th percentile less the coupling.
* **Opening.** The lane's own track rises ``OPEN_MARGIN_DB`` over its floor (its 5th
  percentile level) after at least ``MIN_CLOSED_SEC`` below it, and stays up
  ``MIN_OPEN_SEC``.
* **Copy onset.** The mic reaches the copy's level less ``SPEECH_DROP_DB``. The copy's
  level is the lane's peak over the first ``PEAK_SEC`` plus the coupling. The walk starts
  at the copy of the lane's own speech onset (its peak less the same drop, at the path's
  lag) and runs back through the mic's sound, no further than the lane's closure or
  ``MAX_LAG_SEC``. Both onsets are read at the same depth under their own level, so a copy
  that only follows the direct sound never leads it.
* **Flag.** The copy onset leads the opening by more than the alignment tolerance
  (``align.bleed_lag_tolerance_sec``), and the mic's sound is the lane's copy, not the
  mic's own speaker: over the lane's first ``PEAK_SEC`` the lane out-levels the mic at the
  lag by ``DOMINANCE_DB`` (median, the frames ``measure_pair`` counts as copy), before the
  opening the mic is no louder than the copy can be (copy level plus spread), and no
  third lane is open over most of it.

The flagged word is the first word of the lane's transcript that starts inside the
closure and ends after the opening, reading word starts ``WORD_SLACK_SEC`` either side
because ASR places them that far off on gated tracks. A word that started well before the
closure already had its own audio. An opening with no such word (a laugh, a breath) is
not flagged.

Each flag is one comment by ``AUTHOR`` with an id from the lane, recording and source time
of the opening, so a re-run finds the same comment. A re-run withdraws its own comments
that no longer apply unless someone resolved, answered or ticked them.
"""

from __future__ import annotations

import itertools
import logging
import subprocess
import wave
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Any

import numpy as np

from podcast_mcp.edits.bleed_latency import (
    DOMINANCE_DB,
    FRAME_SEC,
    HOP_SEC,
    MAX_LAG_SEC,
    OPEN_DB,
    TOLERANCE_SEC,
    measure_pair,
)
from podcast_mcp.edits.comments import add_comment, delete_comment, update_comment
from podcast_mcp.edits.conversation_align import LATENCY_RATE
from podcast_mcp.engines.envelope_lag import LEVEL_FLOOR_DB, level_envelope_db
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.engines.timeline_render import resolve_clip_audio_path
from podcast_mcp.engines.transcribe import dialogue_transcribe_jobs
from podcast_mcp.engines.ungated_audio import raw_timeline_samples
from podcast_mcp.models import EpisodeProject, TimelineComment, TrackRole, TranscriptWord
from podcast_mcp.util.dsp import bool_runs, bridge_short_dips
from podcast_mcp.util.hashing import short_digest

log = logging.getLogger(__name__)

AUTHOR = "Align tracks"
COMMENT_ID_PREFIX = "onset-"
FLOOR_PERCENTILE = 5
OPEN_MARGIN_DB = 12.0
SPEECH_DROP_DB = 20.0
MIN_CLOSED_SEC = 0.1
MIN_OPEN_SEC = 0.06
PEAK_SEC = 0.2
BRIDGE_SEC = 0.03
# Whisper and the aligner both put word starts on gated tracks a few hundred ms off.
WORD_SLACK_SEC = 0.25
_PUNCTUATION = ' .,;:!?"“”'


@dataclass(frozen=True)
class CopyPath:
    """``source``'s voice on ``mic``: its direct track trails the copy by ``lag_sec``."""

    source_track_id: str
    mic_track_id: str
    lag_sec: float
    coupling_db: float
    spread_db: float


@dataclass(frozen=True)
class ClippedOnset:
    """A lane's track opens at ``open_sec`` after its copy reached ``mic`` at ``copy_sec``.

    Timeline seconds; the lane's own track is closed from ``closed_sec`` to ``open_sec``.
    """

    track_id: str
    mic_track_id: str
    closed_sec: float
    copy_sec: float
    open_sec: float
    lag_sec: float

    @property
    def missing_sec(self) -> float:
        return self.open_sec - self.copy_sec


@dataclass(frozen=True)
class FlaggedWord:
    """The review comment for one word whose start ``onset`` found missing."""

    onset: ClippedOnset
    comment_id: str
    body: str


def _at_lag(env: np.ndarray, lag: int) -> np.ndarray:
    """``env[t - lag]`` for every ``t``, floor-padded."""
    out = np.full(env.size, LEVEL_FLOOR_DB)
    if lag >= 0:
        out[lag:] = env[: env.size - lag]
    else:
        out[:lag] = env[-lag:]
    return out


def copy_paths(levels: Mapping[str, np.ndarray]) -> list[CopyPath]:
    """Every ordered pair of timeline envelopes whose copy sits at one measured lag."""
    paths: list[CopyPath] = []
    for source, mic in itertools.permutations(levels, 2):
        count = min(levels[source].size, levels[mic].size)
        own, other = levels[source][:count], levels[mic][:count]
        pair = measure_pair(own, other, source_track_id=source, mic_track_id=mic)
        if pair.lag_sec is None:
            continue
        copy = _at_lag(other, round(pair.lag_sec / HOP_SEC))
        used = (own > OPEN_DB) & (own - copy >= DOMINANCE_DB)
        gap = copy[used] - own[used]
        if gap.size == 0:
            continue
        coupling = float(np.median(gap))
        paths.append(
            CopyPath(source, mic, pair.lag_sec, coupling, float(np.percentile(gap, 95)) - coupling)
        )
    return paths


def _path_onsets(
    path: CopyPath,
    levels: Mapping[str, np.ndarray],
    floors: Mapping[str, float],
    opened: Mapping[str, np.ndarray],
    tolerance_sec: float,
) -> Iterator[ClippedOnset]:
    own, mic = levels[path.source_track_id], levels[path.mic_track_id]
    count = min(own.size, mic.size)
    lag = round(path.lag_sec / HOP_SEC)
    copy = _at_lag(mic[:count], lag)
    bridge = round(BRIDGE_SEC / HOP_SEC)
    others = [opened[t] for t in levels if t not in (path.source_track_id, path.mic_track_id)]
    closed_since = 0
    for first, last in bool_runs(opened[path.source_track_id][:count]):
        # The mic is read after the lane closed and after the copy of what came before.
        lo = max(closed_since - min(lag, 0), first - round(MAX_LAG_SEC / HOP_SEC))
        closed, closed_since = closed_since, last
        closure = first - closed
        if closure * HOP_SEC < MIN_CLOSED_SEC or (last - first) * HOP_SEC < MIN_OPEN_SEC:
            continue
        head = own[first : min(last, first + round(PEAK_SEC / HOP_SEC))]
        threshold = float(head.max()) + path.coupling_db - SPEECH_DROP_DB
        loudest = float(head.max()) + path.coupling_db + path.spread_db
        if threshold <= floors[path.mic_track_id] + OPEN_MARGIN_DB:
            continue
        if np.median(head - copy[first : first + head.size]) < DOMINANCE_DB:
            continue
        speech = first + int(np.argmax(head >= head.max() - SPEECH_DROP_DB)) - lag
        start = max(lo, speech - bridge)
        hits = np.flatnonzero(mic[start : max(start, first + head.size - lag)] >= threshold)
        if hits.size == 0:
            continue
        k = start + int(hits[0])
        sounding = bridge_short_dips(mic[lo : k + 1] >= threshold, bridge)
        while k > lo and sounding[k - 1 - lo]:
            k -= 1
        if (
            k <= lo
            or (first - k) * HOP_SEC <= tolerance_sec
            or mic[k : max(k + 1, speech)].max() > loudest
            or any(other[k:first].mean() > 0.5 for other in others)
        ):
            continue
        yield ClippedOnset(
            path.source_track_id,
            path.mic_track_id,
            closed * HOP_SEC,
            k * HOP_SEC,
            first * HOP_SEC,
            path.lag_sec,
        )


def clipped_onsets(
    levels: Mapping[str, np.ndarray], paths: list[CopyPath], *, tolerance_sec: float
) -> list[ClippedOnset]:
    """Openings whose copy on another mic leads them, one per opening (its earliest copy)."""
    floors = {t: float(np.percentile(env, FLOOR_PERCENTILE)) for t, env in levels.items()}
    bridge = round(BRIDGE_SEC / HOP_SEC)
    opened = {
        t: bridge_short_dips(env >= floors[t] + OPEN_MARGIN_DB, bridge) for t, env in levels.items()
    }
    found: dict[tuple[str, float], ClippedOnset] = {}
    for path in paths:
        for onset in _path_onsets(path, levels, floors, opened, tolerance_sec):
            key = (onset.track_id, onset.open_sec)
            if key not in found or onset.copy_sec < found[key].copy_sec:
                found[key] = onset
    return sorted(found.values(), key=lambda o: (o.open_sec, o.track_id))


def _speaker(project: EpisodeProject, track_id: str) -> str:
    track = project.track_by_id(track_id)
    return (track and (track.speaker or track.label)) or track_id


def _body(project: EpisodeProject, onset: ClippedOnset, text: str, tolerance_sec: float) -> str:
    who, mic = _speaker(project, onset.track_id), _speaker(project, onset.mic_track_id)
    missing = round(onset.missing_sec * 100) * 10
    body = (
        f"{who}'s “{text}” starts {missing} ms before {who}'s track opens. That start is only "
        f"on {mic}'s mic, and another mic is never used as {who}'s audio, so the word may "
        "sound clipped."
    )
    if onset.lag_sec > tolerance_sec:
        lag = round(onset.lag_sec * 100) * 10
        body += (
            f" {who}'s track runs about {lag} ms behind {mic}'s mic here; "
            "aligning it would fix this."
        )
    return f"{body} Listen, then re-record it, keep it, or edit around it."


def _flag_word(
    project: EpisodeProject, timeline: SessionTimeline, onset: ClippedOnset, tolerance_sec: float
) -> FlaggedWord | None:
    """The word holding ``onset``'s opening, its start snapped onto the opening."""
    track = project.track_by_id(onset.track_id)
    span = next(
        (
            s
            for s in timeline.lane_clip_spans(onset.track_id)
            if s.timeline_start <= onset.open_sec < s.timeline_end
        ),
        None,
    )
    if track is None or span is None:
        return None
    opens = float(span.source_start) + onset.open_sec - float(span.timeline_start)
    closed = opens - (onset.open_sec - onset.closed_sec)
    audio = resolve_clip_audio_path(project, track, span.clip).resolve()
    key = next(
        (
            j.key
            for j in dialogue_transcribe_jobs(project)
            if j.track_id == track.id and j.audio.resolve() == audio
        ),
        None,
    )
    transcript = next((t for t in project.transcripts if t.key == key), None)
    if transcript is None:
        return None
    word = _word_at(transcript.words, closed, opens)
    if word is None:
        return None
    if word.start < opens:
        if word.trimmed_from is None:
            word.trimmed_from = (word.start, word.end)
        word.start = opens
    text = word.text.strip(_PUNCTUATION) or word.text
    comment_id = COMMENT_ID_PREFIX + short_digest(
        f"{track.id}|{span.clip.source_id or ''}|{opens:.1f}", 12
    )
    return FlaggedWord(onset, comment_id, _body(project, onset, text, tolerance_sec))


def _word_at(words: list[TranscriptWord], closed: float, opens: float) -> TranscriptWord | None:
    """The first word starting in the lane's closure that runs past the opening.

    Word starts are read with ``WORD_SLACK_SEC`` either side. A word that starts well
    before the closure already had its own audio, so it is not clipped.
    """
    held = [
        w
        for w in words
        if not (w.suppressed or w.ignored)
        and closed - WORD_SLACK_SEC <= w.start < opens + WORD_SLACK_SEC
        and w.end > opens
    ]
    return min(held, key=lambda w: w.start, default=None)


def _withdrawable(comment: TimelineComment) -> bool:
    """An open flag nobody has answered or ticked; a re-run may move or drop it."""
    return (
        comment.author == AUTHOR
        and comment.id.startswith(COMMENT_ID_PREFIX)
        and not comment.resolved
        and not comment.replies
        and not any(item.done for item in comment.action_items)
    )


def _sync_comments(project: EpisodeProject, flagged: list[FlaggedWord]) -> None:
    wanted = {f.comment_id: f for f in flagged}
    for comment in list(project.comments):
        if comment.id not in wanted and _withdrawable(comment):
            delete_comment(project, comment.id)
    existing = {c.id: c for c in project.comments}
    for f in flagged:
        anchor = (round(f.onset.copy_sec, 3), round(f.onset.open_sec, 3))
        current = existing.get(f.comment_id)
        if current is None:
            add_comment(
                project,
                body=f.body,
                author=AUTHOR,
                timeline_start=anchor[0],
                timeline_end=anchor[1],
                track_ids=[f.onset.track_id],
                comment_id=f.comment_id,
            )
        elif _withdrawable(current) and (
            current.body,
            current.timeline_start,
            current.timeline_end,
        ) != (f.body, *anchor):
            update_comment(
                project,
                current.id,
                body=f.body,
                timeline_start=anchor[0],
                timeline_end=anchor[1],
            )


def flag_clipped_word_starts(
    project: EpisodeProject, defaults: dict[str, Any] | None = None
) -> list[FlaggedWord]:
    """Flag, snap and comment every word whose start is missing from its own track.

    Undecodable audio flags nothing and leaves existing comments alone.
    """
    tolerance = float(
        (defaults or {}).get("align", {}).get("bleed_lag_tolerance_sec", TOLERANCE_SEC)
    )
    lanes = [t.id for t in project.tracks if t.role == TrackRole.DIALOGUE]
    if len(lanes) < 2:
        return []
    sources: dict = {}
    try:
        levels = {
            lane: level_envelope_db(
                raw_timeline_samples(project, lane, sources=sources, sample_rate=LATENCY_RATE),
                sample_rate=LATENCY_RATE,
                frame_sec=FRAME_SEC,
                hop_sec=HOP_SEC,
            )
            for lane in lanes
        }
    except (OSError, ValueError, wave.Error, subprocess.CalledProcessError) as exc:
        log.debug("clipped word starts skipped: %s", exc)
        return []
    onsets = clipped_onsets(levels, copy_paths(levels), tolerance_sec=tolerance)
    timeline = SessionTimeline(project)
    flagged = [f for o in onsets if (f := _flag_word(project, timeline, o, tolerance)) is not None]
    _sync_comments(project, flagged)
    return flagged


def flagged_note(flagged: list[FlaggedWord]) -> str:
    """The step-summary clause for ``flagged`` words."""
    if len(flagged) == 1:
        return "1 word start missing from its own track (see comments)"
    return f"{len(flagged)} word starts missing from their own track (see comments)"
