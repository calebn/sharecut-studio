"""Word starts still missing from their own track after alignment (#1059).

Bleed is never used as audio for another speaker (#945, #1037). So where a call app's
gate opens partway into a word, the start of that word is missing from the mix. This
finds each such word from audio, moves its start to where its own track opens (the start
it had before stays in ``snapped_from``), and leaves a timeline comment so the host can
re-record, keep or edit around it.

A word that reached another mic before its own track opened is not always clipped. The
track may simply play it late: the word is whole on its own track, just behind its copy.
That is an alignment residual, so the pass reports it per lane and never moves the word.

Everything is read on the timeline, after alignment, from level envelopes: the
bleed-latency grid (``FRAME_SEC`` frames every ``HOP_SEC``) and a finer attack grid
(``ATTACK_FRAME_SEC`` frames every ``ATTACK_HOP_SEC``). Every level threshold is relative
to what the episode measures about itself:

* **Copy path.** An ordered pair whose direct track follows its copy on the other mic at
  one lag (``bleed_latency.measure_pair``: consistent or drifting), re-measured where the
  lanes now sit. A pair with no lag (scattered or no bleed) cannot tell the lane's copy
  from the mic's own sound, so it never reports. The coupling is the median of mic minus
  direct level over the frames that measurement uses.
* **Opening.** The lane's own track rises ``OPEN_MARGIN_DB`` over its floor (its
  ``FLOOR_PERCENTILE`` level) after at least ``MIN_CLOSED_SEC`` below it, and stays up
  ``MIN_OPEN_SEC``. Over its first ``PEAK_SEC`` the lane out-levels the mic by
  ``DOMINANCE_DB``, the margin ``measure_pair`` needs to count a frame as copy only.
* **Copy onset.** The mic reaches the copy's level less ``SPEECH_DROP_DB``. The walk
  starts at the copy of the lane's own speech onset and runs back through the mic's sound,
  no further than the lane's closure or ``MAX_LAG_SEC``. Both onsets are read at the same
  depth under their own level. A copy onset that leads the opening by more than the
  alignment tolerance (``align.bleed_lag_tolerance_sec``) is a *copy lead*.
* **Content shift.** The lane's first ``CONTENT_SEC`` after the opening is correlated with
  the mic at every shift from 0 to the lead. The best shift is how late the lane plays that
  sound (``late_sec``); it counts only at ``MIN_CORRELATION``, the match ``envelope_lag``
  needs to call a lag supported.
* **Attack.** The track's level over its first ``ATTACK_SEC`` after it opens, less the
  word's peak. The lane's *attack profile* is that entry over every opening its copy shows
  whole (the copy onset, at the path's lag, does not lead). An opening is *abrupt* when its
  entry is over the profile's ``PROFILE_PERCENTILE``: it jumps from the gate straight to
  the word's level, which none of the lane's whole word starts do. A lane with fewer than
  ``MIN_PROFILE_STARTS`` whole starts has no profile, so nothing on it is abrupt.

A copy lead is then:

- **Clipped** when the content matches with the lane not late past the tolerance, the
  opening is abrupt, and the lead less the late shift is still past the tolerance: the
  track opened mid-word. The word gets its own comment and its start moves to the opening.
- **Late** when the content matches with the lane late past the tolerance: the word is
  whole, just late. Each lane gets one comment listing its late starts, pointing at
  alignment, and the step summary reports them. No word moves.
- Neither otherwise: the early sound on the mic is not this word's start.

The word is the first word of the lane's transcript whose original start falls inside the
closure and that ends after the opening, reading starts ``WORD_SLACK_SEC`` either side. An
opening with no such word (a laugh, a breath) is not reported. A word a person re-timed
(``timing_edited``) is never flagged or moved, and its open comment is withdrawn.

The pass is idempotent. Each run first puts every moved start back on ``snapped_from``,
judges the words at those original times, and moves only the words it flags again, so the
transcript depends on where the lanes sit now, never on earlier runs. Comments follow the
same rule: a run keeps, moves or withdraws its own open comments and never touches one
someone resolved, answered or ticked. A word's comment id comes from the word itself (its
lane, recording and original start), so a re-run that finds the opening a few ms away
keeps the same comment; a lane's comment id comes from the lane.
"""

from __future__ import annotations

import itertools
import logging
import subprocess
import wave
from collections import Counter
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
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
from podcast_mcp.engines.envelope_lag import (
    LEVEL_FLOOR_DB,
    MIN_CORRELATION,
    level_envelope_db,
    shift_correlations,
)
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.engines.ungated_audio import raw_timeline_samples
from podcast_mcp.models import EpisodeProject, TimelineComment, TrackRole, TranscriptWord
from podcast_mcp.util.dsp import bool_runs, bridge_short_dips
from podcast_mcp.util.hashing import short_digest
from podcast_mcp.util.text import count_noun
from podcast_mcp.util.timebase import clock_label

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
# Two syllables: enough shape after the opening that one shift of it wins, where a single
# syllable's rise and fall would match almost any shift.
CONTENT_SEC = 2 * PEAK_SEC
# Dips shorter than one level frame are the frame grid, not silence.
BRIDGE_SEC = FRAME_SEC
# Attack grid: 5 ms frames every 1 ms resolve a voice's own attack, which takes tens of
# ms to reach the word's level; a gate opening into a word gets there within one frame.
ATTACK_FRAME_SEC = 0.005
ATTACK_HOP_SEC = 0.001
# The entry is read over the first two attack frames after the track opens.
ATTACK_SEC = 2 * ATTACK_FRAME_SEC
# Abrupt is shallower than 95% of the lane's own whole word starts: the loudest-entering
# natural starts (a hard consonant) still set the bar, so only an entry none of them
# reaches counts.
PROFILE_PERCENTILE = 95
# A 95th percentile needs about 20 values before it sits below the single largest one.
MIN_PROFILE_STARTS = 20
# Whisper and the forced aligner put word starts on gated tracks up to about a syllable
# off (#979), so word starts are read that far either side of the closure.
WORD_SLACK_SEC = 0.25
_PUNCTUATION = ' .,;:!?"“”'


@dataclass(frozen=True)
class Levels:
    """Timeline level envelopes per lane: the bleed-latency grid and the attack grid."""

    grid: Mapping[str, np.ndarray]
    attack: Mapping[str, np.ndarray]


@dataclass(frozen=True)
class CopyPath:
    """``source``'s voice on ``mic``: its direct track trails the copy by ``lag_sec``."""

    source_track_id: str
    mic_track_id: str
    lag_sec: float
    coupling_db: float


@dataclass(frozen=True)
class CopyLead:
    """A lane's track opens at ``open_sec`` after its sound reached ``mic`` at ``copy_sec``.

    Timeline seconds; the lane's own track is closed from ``closed_sec`` to ``open_sec``.
    The lane's sound after the opening matches the mic's ``late_sec`` earlier (correlation
    ``match_r``); ``abrupt`` says the track opened at the word's level with no attack.
    """

    track_id: str
    mic_track_id: str
    closed_sec: float
    copy_sec: float
    open_sec: float
    late_sec: float
    match_r: float
    abrupt: bool

    @property
    def missing_sec(self) -> float:
        """How much of the word's start, in the lane's own time, its track never played."""
        return self.open_sec - self.copy_sec - self.late_sec

    def clipped(self, tolerance_sec: float) -> bool:
        return self.match_r >= MIN_CORRELATION and self.abrupt and self.missing_sec > tolerance_sec

    def late(self, tolerance_sec: float) -> bool:
        return self.match_r >= MIN_CORRELATION and self.late_sec > tolerance_sec


@dataclass(frozen=True)
class FlaggedWord:
    """One word whose start ``lead`` found missing from its own track.

    ``original_start`` and ``opens`` are source seconds on the word's recording.
    """

    lead: CopyLead
    source_id: str | None
    original_start: float
    opens: float
    text: str

    @property
    def comment_id(self) -> str:
        identity = f"{self.lead.track_id}|{self.source_id or ''}|{self.original_start:.3f}"
        return COMMENT_ID_PREFIX + short_digest(identity, 12)


@dataclass(frozen=True)
class LateStart:
    """One word whole on its own track but ``lead.late_sec`` behind its copy."""

    lead: CopyLead
    text: str


@dataclass(frozen=True)
class OnsetReport:
    """What one run found: clipped words (flagged and moved) and late ones (reported)."""

    flagged: list[FlaggedWord] = field(default_factory=list)
    late: list[LateStart] = field(default_factory=list)

    def note(self) -> str:
        """The step-summary clauses, or ``""`` when nothing was found."""
        parts = []
        if len(self.flagged) == 1:
            parts.append("1 word start missing from its own track (see comments)")
        elif self.flagged:
            parts.append(
                f"{len(self.flagged)} word starts missing from their own track (see comments)"
            )
        for track_id, lates in _by_track(self.late).items():
            shortest, longest = (_ms(f(s.lead.late_sec for s in lates)) for f in (min, max))
            spread = f"{shortest}" if shortest == longest else f"{shortest}-{longest}"
            parts.append(
                f"{track_id}: {count_noun(len(lates), 'word start')} late on its own track "
                f"({spread} ms; alignment residual, see comments)"
            )
        return "; ".join(parts)


@dataclass(frozen=True)
class _Copied:
    """An opening (grid frames) whose copy on the mic starts at ``copy``."""

    closed: int
    first: int
    copy: int
    peak_db: float


@dataclass(frozen=True)
class _Note:
    """A comment this run wants to exist."""

    id: str
    track_id: str
    start: float
    end: float
    body: str


def _by_track(late: list[LateStart]) -> dict[str, list[LateStart]]:
    out: dict[str, list[LateStart]] = {}
    for item in late:
        out.setdefault(item.lead.track_id, []).append(item)
    return out


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
        if used.any():
            paths.append(
                CopyPath(source, mic, pair.lag_sec, float(np.median(copy[used] - own[used])))
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


def _copied_openings(
    path: CopyPath,
    grid: Mapping[str, np.ndarray],
    floors: Mapping[str, float],
    opened: Mapping[str, np.ndarray],
) -> Iterator[_Copied]:
    """Each opening of the path's lane whose copy on the mic shows where it starts."""
    own, mic = grid[path.source_track_id], grid[path.mic_track_id]
    count = min(own.size, mic.size)
    lag = round(path.lag_sec / HOP_SEC)
    copy = _at_lag(mic[:count], lag)
    bridge = round(BRIDGE_SEC / HOP_SEC)
    for closed, first, head in _openings(opened[path.source_track_id][:count], own):
        lo = max(closed - min(lag, 0), first - round(MAX_LAG_SEC / HOP_SEC))
        peak = float(head.max())
        threshold = peak + path.coupling_db - SPEECH_DROP_DB
        if threshold <= floors[path.mic_track_id] + OPEN_MARGIN_DB:
            continue
        if np.median(head - copy[first : first + head.size]) < DOMINANCE_DB:
            continue
        speech = first + int(np.argmax(head >= peak - SPEECH_DROP_DB)) - lag
        start = max(lo, speech - bridge)
        hits = np.flatnonzero(mic[start : max(start, first + head.size - lag)] >= threshold)
        if hits.size == 0:
            continue
        k = start + int(hits[0])
        sounding = bridge_short_dips(mic[lo : k + 1] >= threshold, bridge)
        while k > lo and sounding[k - 1 - lo]:
            k -= 1
        if k > lo:
            yield _Copied(closed, first, k, peak)


def _entry_db(attack: np.ndarray, floor: float, first: int, peak_db: float) -> float | None:
    """The track's level over its first ``ATTACK_SEC`` open, less the word's peak.

    The opening is found on the attack grid within one grid frame of grid frame ``first``.
    """
    at = first * HOP_SEC
    lo = max(0, round((at - FRAME_SEC) / ATTACK_HOP_SEC))
    above = np.flatnonzero(
        attack[lo : round((at + FRAME_SEC) / ATTACK_HOP_SEC)] >= floor + OPEN_MARGIN_DB
    )
    if above.size == 0:
        return None
    k = lo + int(above[0])
    return float(attack[k : k + round(ATTACK_SEC / ATTACK_HOP_SEC)].max()) - peak_db


def _late_frames(own: np.ndarray, mic: np.ndarray, first: int, reach: int) -> tuple[int, float]:
    """Frames by which the lane's sound after ``first`` trails the mic's, and its match.

    Shifts run from 0 to ``reach``; equal matches resolve to the smaller shift.
    """
    width = round(CONTENT_SEC / HOP_SEC)
    frames = np.arange(first, min(first + width, own.size, mic.size))
    scores = shift_correlations(own, mic, frames, -np.arange(reach + 1), frames.size)
    if np.isnan(scores).all():
        return 0, 0.0
    best = int(np.nanargmax(scores))
    return best, float(scores[best])


def copy_leads(levels: Levels, paths: list[CopyPath], *, tolerance_sec: float) -> list[CopyLead]:
    """Openings whose copy on another mic leads them, one per opening (its earliest copy)."""
    grid = levels.grid
    floors = {t: float(np.percentile(env, FLOOR_PERCENTILE)) for t, env in grid.items()}
    attack_floors = {
        t: float(np.percentile(env, FLOOR_PERCENTILE)) for t, env in levels.attack.items()
    }
    bridge = round(BRIDGE_SEC / HOP_SEC)
    opened = {
        t: bridge_short_dips(env >= floors[t] + OPEN_MARGIN_DB, bridge) for t, env in grid.items()
    }
    tolerance = round(tolerance_sec / HOP_SEC)

    def entry(track_id: str, copied: _Copied) -> float | None:
        attack = levels.attack[track_id]
        return _entry_db(attack, attack_floors[track_id], copied.first, copied.peak_db)

    whole: dict[str, dict[int, float]] = {t: {} for t in grid}
    leads: dict[tuple[str, int], tuple[CopyPath, _Copied]] = {}
    for path in paths:
        lane, lag = path.source_track_id, round(path.lag_sec / HOP_SEC)
        for copied in _copied_openings(path, grid, floors, opened):
            if copied.first - copied.copy - lag <= tolerance:
                value = entry(lane, copied)
                if value is not None:
                    whole[lane][copied.first] = value
            key = (lane, copied.first)
            if copied.first - copied.copy > tolerance and (
                key not in leads or copied.copy < leads[key][1].copy
            ):
                leads[key] = (path, copied)
    bars = {
        lane: float(np.percentile(list(entries.values()), PROFILE_PERCENTILE))
        for lane, entries in whole.items()
        if len(entries) >= MIN_PROFILE_STARTS
    }
    out = []
    for (lane, first), (path, copied) in leads.items():
        value = entry(lane, copied)
        late, match = _late_frames(
            grid[lane], grid[path.mic_track_id], first, first - copied.copy + tolerance
        )
        out.append(
            CopyLead(
                lane,
                path.mic_track_id,
                copied.closed * HOP_SEC,
                copied.copy * HOP_SEC,
                first * HOP_SEC,
                late * HOP_SEC,
                match,
                value is not None and lane in bars and value > bars[lane],
            )
        )
    return sorted(out, key=lambda o: (o.open_sec, o.track_id))


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
    """The selected transcripts of each dialogue lane."""

    def __init__(self, project: EpisodeProject, lanes: list[str]) -> None:
        self.timeline = SessionTimeline(project)
        self.transcripts = {lane: project.selected_source_transcripts(lane) for lane in lanes}

    def words(self) -> Iterator[TranscriptWord]:
        for transcripts in self.transcripts.values():
            for _source_id, transcript in transcripts:
                yield from transcript.words

    def word_at(self, lead: CopyLead) -> tuple[str | None, TranscriptWord, float] | None:
        """``(recording, word, opening in source seconds)`` for the word ``lead`` opens on."""
        span = next(
            (
                s
                for s in self.timeline.lane_clip_spans(lead.track_id)
                if s.timeline_start <= lead.open_sec < s.timeline_end
            ),
            None,
        )
        if span is None:
            return None
        transcript = dict(self.transcripts.get(lead.track_id, [])).get(span.clip.source_id)
        if transcript is None:
            return None
        opens = float(span.source_start) + lead.open_sec - float(span.timeline_start)
        word = _word_at(transcript.words, opens - (lead.open_sec - lead.closed_sec), opens)
        return None if word is None else (span.clip.source_id, word, opens)


def _speaker(project: EpisodeProject, track_id: str) -> str:
    track = project.track_by_id(track_id)
    return (track and (track.speaker or track.label)) or track_id


def _ms(sec: float) -> int:
    """Milliseconds to the nearest 10, as the comments say them."""
    return round(sec * 100) * 10


def _word_note(project: EpisodeProject, flagged: FlaggedWord) -> _Note:
    lead = flagged.lead
    who, mic = _speaker(project, lead.track_id), _speaker(project, lead.mic_track_id)
    body = (
        f"{who}'s “{flagged.text}” starts {_ms(lead.missing_sec)} ms before {who}'s track "
        f"opens. That start is only on {mic}'s mic, and another mic is never used as {who}'s "
        "audio, so the word may sound clipped. Listen, then re-record it, keep it, or edit "
        "around it."
    )
    start = lead.copy_sec + lead.late_sec
    return _Note(flagged.comment_id, lead.track_id, start, lead.open_sec, body)


def _lane_note(project: EpisodeProject, track_id: str, late: list[LateStart]) -> _Note:
    """One comment for every start a lane plays late: alignment is the cause."""
    first = late[0].lead
    mic_id = Counter(s.lead.mic_track_id for s in late).most_common(1)[0][0]
    who, mic = _speaker(project, track_id), _speaker(project, mic_id)
    count = len(late)
    starts = ", ".join(
        f"{clock_label(s.lead.copy_sec)} “{s.text}” ({_ms(s.lead.late_sec)} ms)" for s in late
    )
    each, it = ("The word is", "it") if count == 1 else ("Each word is", "them")
    body = (
        f"{who}'s track runs late against {mic}'s mic at {count_noun(count, 'word start')}: "
        f"{starts}. {each} whole on {who}'s track but plays that late in the mix, so this "
        f"is left over from alignment, not a clipped start. Aligning {who}'s track there "
        f"would fix {it}; re-running Align tracks then withdraws this comment."
    )
    note_id = LANE_COMMENT_ID_PREFIX + short_digest(track_id, 12)
    return _Note(note_id, track_id, first.copy_sec, first.open_sec, body)


def _notes(project: EpisodeProject, report: OnsetReport) -> list[_Note]:
    notes = [_word_note(project, f) for f in report.flagged]
    notes.extend(_lane_note(project, t, late) for t, late in _by_track(report.late).items())
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


def timeline_levels(project: EpisodeProject, lanes: list[str]) -> Levels:
    """Both envelopes of each lane where it now sits, from one read of its audio."""
    sources: dict = {}
    grid: dict[str, np.ndarray] = {}
    attack: dict[str, np.ndarray] = {}
    for lane in lanes:
        samples = raw_timeline_samples(project, lane, sources=sources, sample_rate=LATENCY_RATE)
        grid[lane] = level_envelope_db(
            samples, sample_rate=LATENCY_RATE, frame_sec=FRAME_SEC, hop_sec=HOP_SEC
        )
        attack[lane] = level_envelope_db(
            samples, sample_rate=LATENCY_RATE, frame_sec=ATTACK_FRAME_SEC, hop_sec=ATTACK_HOP_SEC
        )
    return Levels(grid, attack)


def flag_clipped_word_starts(
    project: EpisodeProject, defaults: dict[str, Any] | None = None
) -> OnsetReport:
    """Flag, snap and comment every clipped word start; report every late one per lane.

    Everything is judged before anything changes. Undecodable audio reports nothing and
    leaves existing comments and moved starts alone. With fewer than two dialogue lanes
    no start can be missing, so open comments are withdrawn and moved starts restored.
    """
    tolerance = float(
        (defaults or {}).get("align", {}).get("bleed_lag_tolerance_sec", TOLERANCE_SEC)
    )
    lane_ids = [t.id for t in project.tracks if t.role == TrackRole.DIALOGUE]
    lanes = _Lanes(project, lane_ids)
    leads: list[CopyLead] = []
    if len(lane_ids) >= 2:
        try:
            levels = timeline_levels(project, lane_ids)
        except (OSError, ValueError, wave.Error, subprocess.CalledProcessError) as exc:
            log.debug("clipped word starts skipped: %s", exc)
            return OnsetReport()
        leads = copy_leads(levels, copy_paths(levels.grid), tolerance_sec=tolerance)
    report = OnsetReport()
    moved: dict[int, float] = {}
    reported: set[int] = set()
    for lead in leads:
        found = lanes.word_at(lead)
        if found is None:
            continue
        source_id, word, opens = found
        if lead.late(tolerance) and id(word) not in reported:
            reported.add(id(word))
            report.late.append(LateStart(lead, _display(word)))
        if lead.clipped(tolerance) and not word.timing_edited and id(word) not in moved:
            moved[id(word)] = opens
            report.flagged.append(
                FlaggedWord(lead, source_id, _original_start(word), opens, _display(word))
            )
    notes = _notes(project, report)
    _snap(lanes, moved)
    _sync_comments(project, notes)
    return report
