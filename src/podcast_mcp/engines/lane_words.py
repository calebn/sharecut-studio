"""Transcript words of every recording placed on a dialogue lane (#1470).

A lane can hold several recordings (takes), each with its own transcript on its own
source clock. Reconcile, text-match and bleed suppression address a word by
``WordKey`` = ``(track_id, transcript source_id, word_index)``: a word index alone
names a word only within one transcript, so a second take's word ``i`` never reads
the first take's verdict ``i``.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EpisodeProject, Transcript, TranscriptKey
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.source_spans import source_span_timeline_bounds
from podcast_mcp.util.timebase import SourceSec

WordKey = tuple[str, str | None, int]


def word_key(row: dict[str, Any]) -> WordKey:
    """The word a reconcile row, pair side or suppression entry names."""
    return (str(row["track_id"]), row.get("source_id"), int(row["word_index"]))


def transcript_word_key(transcript: Transcript, index: int) -> WordKey:
    return (transcript.track_id, transcript.source_id, index)


@dataclass(frozen=True)
class _Placement:
    source_start: float
    source_end: float
    offset: float

    @property
    def length(self) -> float:
        return self.source_end - self.source_start


@dataclass(frozen=True)
class LaneTranscript:
    """One placed recording's transcript on a lane.

    ``placement_source_ids`` are the clips' ``source_id`` values that resolve to this
    transcript (implicit primary media and an explicit source of the same recording
    both do). ``session_span`` moves a word onto the session clock through the clip
    that plays it, so words of different recordings and tracks compare in one clock.
    """

    transcript: Transcript
    placement_source_ids: tuple[str | None, ...]
    placements: tuple[_Placement, ...]

    @property
    def track_id(self) -> str:
        return self.transcript.track_id

    @property
    def key(self) -> TranscriptKey:
        return self.transcript.key

    @property
    def placed(self) -> bool:
        return bool(self.placements)

    def session_span(self, start: float, end: float) -> tuple[float, float] | None:
        """A word on the session clock, both edges through the clip that plays it.

        One offset for the whole word: a word ending at a cut keeps its length instead
        of reading its end through the next clip. The clip is the longest one playing
        the word's start, else the longest one overlapping the word, and only the part
        of the word that clip plays counts. A word no clip
        plays has no session time (``None``); a lane with no clips reads the source
        clock as the session clock.
        """
        if not self.placements:
            return start, end
        playing = [p for p in self.placements if p.source_start <= start < p.source_end] or [
            p for p in self.placements if p.source_start < end and start < p.source_end
        ]
        if not playing:
            return None
        clip = max(playing, key=lambda p: p.length)
        return max(start, clip.source_start) + clip.offset, min(end, clip.source_end) + clip.offset


def lane_transcripts(project: EpisodeProject, track_id: str) -> list[LaneTranscript]:
    """Each transcribed recording placed on ``track_id``, once per transcript."""
    source_ids: dict[TranscriptKey, list[str | None]] = {}
    transcripts: dict[TranscriptKey, Transcript] = {}
    for source_id, transcript in project.selected_source_transcripts(track_id):
        transcripts.setdefault(transcript.key, transcript)
        ids = source_ids.setdefault(transcript.key, [])
        if source_id not in ids:
            ids.append(source_id)
    out: list[LaneTranscript] = []
    for key, transcript in transcripts.items():
        placed_ids = tuple(source_ids[key])
        placements = tuple(
            _Placement(src_a, src_b, tl_a - src_a)
            for c in project.clips
            if c.track_id == track_id and c.source_id in placed_ids
            for src_a, src_b, tl_a in c.virtual_pieces()
        )
        out.append(LaneTranscript(transcript, placed_ids, placements))
    return out


def lanes_transcripts(project: EpisodeProject, track_ids: Iterable[str]) -> list[LaneTranscript]:
    return [lt for tid in track_ids for lt in lane_transcripts(project, tid)]


def project_lane_transcripts(project: EpisodeProject) -> list[LaneTranscript]:
    """Every placed transcript, lanes in transcript order."""
    return lanes_transcripts(project, dict.fromkeys(tr.track_id for tr in project.transcripts))


def word_timeline_window(
    timeline: SessionTimeline, lane: LaneTranscript, src_start: float, src_end: float
) -> tuple[float, float] | None:
    """A source-clock word span's timeline window through its own recording's clips."""
    if lane.placed:
        spans: list[tuple[float, float]] = [
            span
            for source_id in lane.placement_source_ids
            for span in timeline.map_selected_source_span(
                lane.track_id, source_id, SourceSec(src_start), SourceSec(src_end)
            )
        ]
        return (min(float(a) for a, _ in spans), max(float(b) for _, b in spans)) if spans else None
    start, end = source_span_timeline_bounds(timeline, lane.track_id, src_start, src_end)
    return (start, end) if start is not None and end is not None else None


def lane_transcript(
    project: EpisodeProject, track_id: str, source_id: str | None = None
) -> Transcript | None:
    """The transcript a word command on ``track_id`` addresses (#1476).

    ``source_id`` names the recording. Left out, it addresses the lane's primary (source-less)
    transcript, or the only one. On a multi-take lane with no primary transcript a bare word
    index names no single word, so it is refused with ``word_source_required``. ``None``
    means the lane has no transcript.
    """
    if source_id is not None:
        return project.transcript_for_source(track_id, source_id)
    candidates = [tr for tr in project.transcripts if tr.track_id == track_id]
    primary = [tr for tr in candidates if tr.source_id is None]
    if len(candidates) > 1 and len(primary) == 1:
        return primary[0]
    if len(candidates) > 1:
        raise CodedValueError(
            f"track {track_id!r} has {len(candidates)} transcripts; give each word's source_id",
            code="word_source_required",
        )
    return candidates[0] if candidates else None


def requested_word_keys(
    project: EpisodeProject, items: Iterable[dict[str, Any]] | None
) -> set[WordKey]:
    """The words a caller's ``{track_id, source_id?, word_index}`` list names.

    ``source_id`` may be left out on a lane with one transcript. On a lane with several
    takes a bare ``word_index`` names no single word, so it is refused.
    """
    keys: set[WordKey] = set()
    for item in items or ():
        tid = str(item["track_id"])
        if "source_id" in item:
            named = project.transcript_for_source(tid, item["source_id"])
            if named is None:
                raise CodedValueError(
                    f"track {tid!r} has no transcript for source {item['source_id']!r}",
                    code="word_source_unknown",
                )
            source_id = named.source_id
        else:
            only = lane_transcript(project, tid)
            source_id = only.source_id if only else None
        keys.add((tid, source_id, int(item["word_index"])))
    return keys
