"""Transcript words of every recording placed on a dialogue lane (#1470).

A lane can hold several recordings (takes), each with its own transcript on its own
source clock. Reconcile, text-match and bleed suppression address a word by
``WordKey`` = ``(track_id, transcript source_id, word_index)``: a word index alone
names a word only within one transcript, so a second take's word ``i`` never reads
the first take's verdict ``i``.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EpisodeProject, Transcript, TranscriptKey
from podcast_mcp.util.source_spans import source_span_timeline_bounds
from podcast_mcp.util.timebase import SourceSec

WordKey = tuple[str, str | None, int]


def word_key(row: dict[str, Any]) -> WordKey:
    """The word a reconcile row, pair side or suppression entry names."""
    return (str(row["track_id"]), row.get("source_id"), int(row["word_index"]))


def transcript_word_key(transcript: Transcript, index: int) -> WordKey:
    return (transcript.track_id, transcript.source_id, index)


@dataclass(frozen=True)
class LaneTranscript:
    """One placed recording's transcript on a lane.

    ``placement_source_id`` is the clips' ``source_id`` (the transcript of implicit
    primary media can stand for an explicit source of the same recording).
    ``session_offset`` moves this recording's source clock onto the session clock,
    read at its earliest placement, so words of different recordings and tracks
    compare in one clock.
    """

    transcript: Transcript
    placement_source_id: str | None
    placed: bool
    session_offset: float

    @property
    def track_id(self) -> str:
        return self.transcript.track_id

    @property
    def key(self) -> TranscriptKey:
        return self.transcript.key

    def session_time(self, source_sec: float) -> float:
        return source_sec + self.session_offset


def lane_transcripts(project: EpisodeProject, track_id: str) -> list[LaneTranscript]:
    """Each transcribed recording placed on ``track_id``, once per transcript."""
    seen: set[TranscriptKey] = set()
    out: list[LaneTranscript] = []
    for source_id, transcript in project.selected_source_transcripts(track_id):
        if transcript.key in seen:
            continue
        seen.add(transcript.key)
        clips = [c for c in project.clips if c.track_id == track_id and c.source_id == source_id]
        first = min(clips, key=lambda c: c.timeline_start, default=None)
        out.append(
            LaneTranscript(
                transcript=transcript,
                placement_source_id=source_id,
                placed=bool(clips),
                session_offset=first.timeline_start - first.source_start if first else 0.0,
            )
        )
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
        spans: Sequence[tuple[float, float]] = timeline.map_selected_source_span(
            lane.track_id, lane.placement_source_id, SourceSec(src_start), SourceSec(src_end)
        )
        return (float(spans[0][0]), float(spans[-1][1])) if spans else None
    start, end = source_span_timeline_bounds(timeline, lane.track_id, src_start, src_end)
    return (start, end) if start is not None and end is not None else None


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
        if "source_id" not in item:
            candidates = [tr for tr in project.transcripts if tr.track_id == tid]
            if len(candidates) > 1:
                raise ValueError(
                    f"track {tid!r} has {len(candidates)} transcripts; give each word's source_id"
                )
            source_id = candidates[0].source_id if candidates else None
        else:
            source_id = item["source_id"]
        keys.add((tid, source_id, int(item["word_index"])))
    return keys
