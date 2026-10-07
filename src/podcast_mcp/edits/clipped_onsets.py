"""Word starts still missing from their own track after alignment (#1059).

Bleed is never used as audio for another speaker (#945, #1037). So where a speaker's own
track opens after their voice has already reached another mic, the start of that word is
missing from the mix: a call app's gate opened late, or the lane sits at an offset
``align_tracks`` could not solve or did not apply. This finds each such word from audio,
moves its start to where its own track opens (the start it had before stays in
``snapped_from``), and leaves a timeline comment so the host can re-record, keep or edit
around it.

Everything is read on the timeline, after alignment, from level envelopes on the
bleed-latency grid (``FRAME_SEC`` frames every ``HOP_SEC``). Every level threshold is
relative to what the episode measures about itself:

* **Copy path.** An ordered pair whose direct track follows its copy on the other mic at
  one lag (``bleed_latency.measure_pair``: consistent or drifting), re-measured where the
  lanes now sit, so an aligned lane reads about 0 and an unaligned one its offset. A pair
  with no lag (scattered or no bleed) cannot tell the lane's copy from the mic's own sound,
  so it never flags. The coupling is the median of mic minus direct level over the frames
  that measurement uses; the spread is their 95th percentile less the coupling.
* **Opening.** The lane's own track rises ``OPEN_MARGIN_DB`` over its floor (its
  ``FLOOR_PERCENTILE`` level) after at least ``MIN_CLOSED_SEC`` below it, and stays up
  ``MIN_OPEN_SEC``.
* **Copy onset.** The mic reaches the copy's level less ``SPEECH_DROP_DB``. The copy's
  level is the lane's peak over its first ``PEAK_SEC`` plus the coupling. The walk starts
  at the copy of the lane's own speech onset (its peak less the same drop, at the path's
  lag) and runs back through the mic's sound, no further than the lane's closure or
  ``MAX_LAG_SEC``. Both onsets are read at the same depth under their own level, so a copy
  that only follows the direct sound never leads it.
* **Flag.** The copy onset leads the opening by more than the alignment tolerance
  (``align.bleed_lag_tolerance_sec``): a lead align itself would call aligned is not a
  missing start, and the tolerance is more than one level frame, the grid both onsets
  are read on. The mic's sound must also be the lane's copy, not the mic's own speaker:

  - over the lane's first ``PEAK_SEC`` the lane out-levels the mic at the lag by
    ``DOMINANCE_DB``, the margin ``measure_pair`` needs to count a frame as copy only;
  - before the opening the mic is no louder than the copy can be (copy level plus
    spread);
  - no third lane is open over most of the lead (``THIRD_LANE_SHARE``);
  - the mic's own transcript has no word over the lead other than this word's copy.

The flagged word is the first word of the lane's transcript whose original start falls
inside the closure and that ends after the opening, reading starts ``WORD_SLACK_SEC``
either side. A word that started well before the closure already had its own audio. An
opening with no such word (a laugh, a breath) is not flagged.

A word a person re-timed (``timing_edited``) is never flagged or moved, and its open comment is withdrawn.

The pass is idempotent. Each run first puts every moved start back on ``snapped_from``,
judges the words at those original times, and moves only the words it flags again, so the
transcript depends on where the lanes sit now, never on earlier runs. Comments follow the
same rule: a run keeps, moves or withdraws its own open comments and never touches one
someone resolved, answered or ticked. A word's comment id comes from the word itself (its
lane, recording and original start), so a re-run that finds the opening a few ms away
keeps the same comment. A lane that sits late against the mic (the path's lag over the
tolerance) is the cause of every start it misses, so it gets one comment listing them.
"""

from __future__ import annotations

import itertools
import logging
import statistics
import subprocess
import wave
from collections import Counter
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
from podcast_mcp.engines.ungated_audio import raw_timeline_samples
from podcast_mcp.models import EpisodeProject, TimelineComment, TrackRole, TranscriptWord
from podcast_mcp.util.dsp import bool_runs, bridge_short_dips
from podcast_mcp.util.hashing import short_digest
from podcast_mcp.util.text import count_noun, lexicon_form
from podcast_mcp.util.timebase import SourceSec, clock_label

log = logging.getLogger(__name__)

AUTHOR = "Align tracks"
COMMENT_ID_PREFIX = "onset-"
LANE_COMMENT_ID_PREFIX = "onset-lane-"
# A lane's floor is the level its quietest 5% of frames stay under. A gated call track
# sits there most of the episode, and even a lane that talks nine tenths of the time
# leaves more than 5% silent, so the floor is the lane's silence, never its speech.
FLOOR_PERCENTILE = 5
# Open is twice the margin measure_pair needs to call one level clearly over another, so
# a room mic's floor wandering by that margin never reads as its track opening.
OPEN_MARGIN_DB = 2 * DOMINANCE_DB
# A word's consonants and soft syllables run up to 20 dB under its loudest vowel, so
# sound within 20 dB of the copy's level is still that word. Onsets are read there too.
SPEECH_DROP_DB = 20.0
# Gaps shorter than 100 ms are the pauses between syllables inside a word; a start can
# only be missing after the track has been shut for longer than that.
MIN_CLOSED_SEC = 0.1
# An opening holds for two level frames, so a single frame's click is not a word.
MIN_OPEN_SEC = 2 * FRAME_SEC
# The head of a word: one syllable, about 200 ms.
PEAK_SEC = 0.2
# Dips shorter than one level frame are the frame grid, not silence.
BRIDGE_SEC = FRAME_SEC
# Whisper and the forced aligner put word starts on gated tracks up to about a syllable
# off (#979), so word starts are read that far either side of the closure.
WORD_SLACK_SEC = 0.25
# A third lane open over most of the lead may be what the mic hears there.
THIRD_LANE_SHARE = 0.5
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
    """One word whose start ``onset`` found missing from its own track.

    ``original_start`` and ``opens`` are source seconds on the word's recording.
    """

    onset: ClippedOnset
    source_id: str | None
    original_start: float
    opens: float
    text: str

    @property
    def comment_id(self) -> str:
        identity = f"{self.onset.track_id}|{self.source_id or ''}|{self.original_start:.3f}"
        return COMMENT_ID_PREFIX + short_digest(identity, 12)


@dataclass(frozen=True)
class _Note:
    """A comment this run wants to exist."""

    id: str
    track_id: str
    start: float
    end: float
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


def _openings(opened: np.ndarray, own: np.ndarray) -> list[tuple[int, int, np.ndarray]]:
    """``(closed since, first open frame, head levels)`` of each opening after a closure."""
    out = []
    closed_since = 0
    for first, last in bool_runs(opened):
        closed, closed_since = closed_since, last
        if (first - closed) * HOP_SEC < MIN_CLOSED_SEC or (last - first) * HOP_SEC < MIN_OPEN_SEC:
            continue
        out.append((closed, first, own[first : min(last, first + round(PEAK_SEC / HOP_SEC))]))
    return out


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
    for closed, first, head in _openings(opened[path.source_track_id][:count], own):
        lo = max(closed - min(lag, 0), first - round(MAX_LAG_SEC / HOP_SEC))
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
            or any(other[k:first].mean() > THIRD_LANE_SHARE for other in others)
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


def _original_start(word: TranscriptWord) -> float:
    return word.start if word.snapped_from is None else word.snapped_from


def _display(word: TranscriptWord) -> str:
    return word.text.strip(_PUNCTUATION) or word.text


def _word_at(words: list[TranscriptWord], closed: float, opens: float) -> TranscriptWord | None:
    """The first word whose original start is in the lane's closure and that runs past it.

    Word starts are read with ``WORD_SLACK_SEC`` either side. A word that starts well
    before the closure already had its own audio, so it is not clipped.
    """
    held = [
        w
        for w in words
        if not (w.suppressed or w.ignored)
        and closed - WORD_SLACK_SEC <= _original_start(w) < opens + WORD_SLACK_SEC
        and w.end > opens
    ]
    return min(held, key=_original_start, default=None)


class _Lanes:
    """The selected transcripts of each dialogue lane and where their words sit."""

    def __init__(self, project: EpisodeProject, lanes: list[str]) -> None:
        self.timeline = SessionTimeline(project)
        self.transcripts = {lane: project.selected_source_transcripts(lane) for lane in lanes}
        self._timeline_words: dict[str, list[tuple[float, float, TranscriptWord]]] = {}

    def words(self) -> Iterator[TranscriptWord]:
        for transcripts in self.transcripts.values():
            for _source_id, transcript in transcripts:
                yield from transcript.words

    def timeline_words(self, lane: str) -> list[tuple[float, float, TranscriptWord]]:
        """The lane's words at their original times, mapped onto the timeline."""
        if lane not in self._timeline_words:
            rows: list[tuple[float, float, TranscriptWord]] = []
            for source_id, transcript in self.transcripts.get(lane, []):
                bounds = [
                    (SourceSec(_original_start(w)), SourceSec(w.end)) for w in transcript.words
                ]
                mapped = self.timeline.map_selected_source_spans(lane, source_id, bounds)
                rows.extend(
                    (float(spans[0][0]), float(spans[-1][1]), w)
                    for w, spans in zip(transcript.words, mapped, strict=True)
                    if spans
                )
            self._timeline_words[lane] = rows
        return self._timeline_words[lane]

    def flag(
        self, onset: ClippedOnset, tolerance_sec: float
    ) -> tuple[FlaggedWord, TranscriptWord] | None:
        """The word holding ``onset``'s opening, unless the mic's own speaker made the lead."""
        span = next(
            (
                s
                for s in self.timeline.lane_clip_spans(onset.track_id)
                if s.timeline_start <= onset.open_sec < s.timeline_end
            ),
            None,
        )
        if span is None:
            return None
        transcript = dict(self.transcripts.get(onset.track_id, [])).get(span.clip.source_id)
        if transcript is None:
            return None
        opens = float(span.source_start) + onset.open_sec - float(span.timeline_start)
        closed = opens - (onset.open_sec - onset.closed_sec)
        word = _word_at(transcript.words, closed, opens)
        if word is None or word.timing_edited or self._mic_speaks(onset, word, tolerance_sec):
            return None
        source_id = span.clip.source_id
        return FlaggedWord(onset, source_id, _original_start(word), opens, _display(word)), word

    def _mic_speaks(self, onset: ClippedOnset, word: TranscriptWord, tolerance_sec: float) -> bool:
        """Whether the mic's transcript has its own speaker's word over the lead.

        A word there is the mic's copy of this word when it reads the same, or when
        reconciliation already gave it to this lane's speaker; any other word is the mic's
        own speaker, so the lead may be theirs. Overlaps within the alignment tolerance
        are timing noise.
        """
        text = lexicon_form(word.text)
        for start, end, other in self.timeline_words(onset.mic_track_id):
            overlap = min(end, onset.open_sec) - max(start, onset.copy_sec)
            if (
                overlap > tolerance_sec
                and not other.ignored
                and other.dominant_track != onset.track_id
                and lexicon_form(other.text) != text
            ):
                return True
        return False


def _speaker(project: EpisodeProject, track_id: str) -> str:
    track = project.track_by_id(track_id)
    return (track and (track.speaker or track.label)) or track_id


def _ms(sec: float) -> int:
    """Milliseconds to the nearest 10, as the comments say them."""
    return round(sec * 100) * 10


def _word_note(project: EpisodeProject, flagged: FlaggedWord) -> _Note:
    onset = flagged.onset
    who, mic = _speaker(project, onset.track_id), _speaker(project, onset.mic_track_id)
    body = (
        f"{who}'s “{flagged.text}” starts {_ms(onset.missing_sec)} ms before {who}'s track "
        f"opens. That start is only on {mic}'s mic, and another mic is never used as {who}'s "
        "audio, so the word may sound clipped. Listen, then re-record it, keep it, or edit "
        "around it."
    )
    return _Note(flagged.comment_id, onset.track_id, onset.copy_sec, onset.open_sec, body)


def _lane_note(project: EpisodeProject, track_id: str, flagged: list[FlaggedWord]) -> _Note:
    """One comment for every start a late lane misses: the lane is the cause."""
    first = flagged[0].onset
    mic_id = Counter(f.onset.mic_track_id for f in flagged).most_common(1)[0][0]
    who, mic = _speaker(project, track_id), _speaker(project, mic_id)
    lag = _ms(statistics.median(f.onset.lag_sec for f in flagged))
    count = len(flagged)
    starts = ", ".join(f"{clock_label(f.onset.copy_sec)} “{f.text}”" for f in flagged)
    verb, these, them = ("is", "this word", "it") if count == 1 else ("are", "these words", "them")
    body = (
        f"{who}'s track runs about {lag} ms behind {mic}'s mic, so "
        f"{count_noun(count, 'word start')} {verb} only on {mic}'s mic: {starts}. Another "
        f"mic is never used as {who}'s audio, so {these} may sound clipped. Aligning "
        f"{who}'s track would fix {them}; re-running Align tracks then withdraws this "
        "comment. Otherwise listen, then re-record, keep, or edit around each word."
    )
    note_id = LANE_COMMENT_ID_PREFIX + short_digest(track_id, 12)
    return _Note(note_id, track_id, first.copy_sec, first.open_sec, body)


def _notes(
    project: EpisodeProject, flagged: list[FlaggedWord], tolerance_sec: float
) -> list[_Note]:
    late: dict[str, list[FlaggedWord]] = {}
    notes = []
    for f in flagged:
        if f.onset.lag_sec > tolerance_sec:
            late.setdefault(f.onset.track_id, []).append(f)
        else:
            notes.append(_word_note(project, f))
    notes.extend(_lane_note(project, track, words) for track, words in late.items())
    return notes


def _ours(comment: TimelineComment) -> bool:
    return comment.author == AUTHOR and comment.id.startswith(COMMENT_ID_PREFIX)


def _withdrawable(comment: TimelineComment) -> bool:
    """An open flag nobody has answered or ticked; a re-run may move or drop it."""
    return (
        _ours(comment)
        and not comment.resolved
        and not comment.replies
        and not any(item.done for item in comment.action_items)
    )


def _answered_nearby(project: EpisodeProject, note: _Note) -> bool:
    """Whether someone already answered a word comment on this lane over this span."""
    return any(
        _ours(c)
        and not _withdrawable(c)
        and not c.id.startswith(LANE_COMMENT_ID_PREFIX)
        and note.track_id in c.track_ids
        and c.timeline_start < note.end
        and (c.timeline_start if c.timeline_end is None else c.timeline_end) > note.start
        for c in project.comments
    )


def _sync_comments(project: EpisodeProject, notes: list[_Note]) -> None:
    wanted = {n.id for n in notes}
    for comment in list(project.comments):
        if comment.id not in wanted and _withdrawable(comment):
            delete_comment(project, comment.id)
    existing = {c.id: c for c in project.comments}
    for note in notes:
        start, end = round(note.start, 3), round(note.end, 3)
        current = existing.get(note.id)
        if current is None:
            if note.id.startswith(LANE_COMMENT_ID_PREFIX) or not _answered_nearby(project, note):
                add_comment(
                    project,
                    body=note.body,
                    author=AUTHOR,
                    timeline_start=start,
                    timeline_end=end,
                    track_ids=[note.track_id],
                    comment_id=note.id,
                )
        elif _withdrawable(current) and (
            current.body,
            current.timeline_start,
            current.timeline_end,
        ) != (note.body, start, end):
            update_comment(
                project, current.id, body=note.body, timeline_start=start, timeline_end=end
            )


def _snap(lanes: _Lanes, moved: Mapping[int, float]) -> None:
    """Put every start back on its original, then move each flagged word onto its opening."""
    for word in lanes.words():
        original = _original_start(word)
        opens = moved.get(id(word))
        if opens is not None and opens > original:
            word.start, word.snapped_from = opens, original
        elif word.snapped_from is not None:
            word.start, word.snapped_from = original, None


def _timeline_levels(project: EpisodeProject, lanes: list[str]) -> dict[str, np.ndarray]:
    sources: dict = {}
    return {
        lane: level_envelope_db(
            raw_timeline_samples(project, lane, sources=sources, sample_rate=LATENCY_RATE),
            sample_rate=LATENCY_RATE,
            frame_sec=FRAME_SEC,
            hop_sec=HOP_SEC,
        )
        for lane in lanes
    }


def flag_clipped_word_starts(
    project: EpisodeProject, defaults: dict[str, Any] | None = None
) -> list[FlaggedWord]:
    """Flag, snap and comment every word whose start is missing from its own track.

    Everything is judged before anything changes. Undecodable audio flags nothing and
    leaves existing comments and moved starts alone. With fewer than two dialogue lanes
    no start can be missing, so open flags are withdrawn and moved starts restored.
    """
    tolerance = float(
        (defaults or {}).get("align", {}).get("bleed_lag_tolerance_sec", TOLERANCE_SEC)
    )
    lane_ids = [t.id for t in project.tracks if t.role == TrackRole.DIALOGUE]
    lanes = _Lanes(project, lane_ids)
    onsets: list[ClippedOnset] = []
    if len(lane_ids) >= 2:
        try:
            levels = _timeline_levels(project, lane_ids)
        except (OSError, ValueError, wave.Error, subprocess.CalledProcessError) as exc:
            log.debug("clipped word starts skipped: %s", exc)
            return []
        onsets = clipped_onsets(levels, copy_paths(levels), tolerance_sec=tolerance)
    flagged: list[FlaggedWord] = []
    moved: dict[int, float] = {}
    for onset in onsets:
        found = lanes.flag(onset, tolerance)
        if found is None or id(found[1]) in moved:
            continue
        flagged.append(found[0])
        moved[id(found[1])] = found[0].opens
    notes = _notes(project, flagged, tolerance)
    _snap(lanes, moved)
    _sync_comments(project, notes)
    return flagged


def flagged_note(flagged: list[FlaggedWord]) -> str:
    """The step-summary clause for ``flagged`` words."""
    if len(flagged) == 1:
        return "1 word start missing from its own track (see comments)"
    return f"{len(flagged)} word starts missing from their own track (see comments)"
