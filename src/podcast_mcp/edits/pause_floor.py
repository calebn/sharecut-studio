"""Pause air a cut must keep, and the peer-speech index that tells a turn gap from a thinking pause.

Shared by tighten proposal, cut application and the safety assessment so none of them imports
another's private helper.
"""

from __future__ import annotations

from bisect import bisect_left
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from podcast_mcp.edits.session_air import SessionAir
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.timebase import SourceSec


@dataclass(frozen=True)
class PeerSpeechIndex:
    """One sorted speech sweep with the two longest distinct-track prefixes."""

    starts: tuple[float, ...]
    first: tuple[tuple[str | None, float], ...]
    second: tuple[tuple[str | None, float], ...]

    @classmethod
    def build(cls, spans: Iterable[tuple[float, float, str]]) -> PeerSpeechIndex:
        ordered = sorted((start, end, track_id) for start, end, track_id in spans)
        first_track: str | None = None
        second_track: str | None = None
        first_end = second_end = float("-inf")
        first: list[tuple[str | None, float]] = []
        second: list[tuple[str | None, float]] = []
        for _start, end, track_id in ordered:
            if track_id == first_track:
                first_end = max(first_end, end)
            elif track_id == second_track:
                second_end = max(second_end, end)
                if second_end > first_end:
                    first_track, second_track = second_track, first_track
                    first_end, second_end = second_end, first_end
            elif end > first_end:
                second_track, second_end = first_track, first_end
                first_track, first_end = track_id, end
            elif end > second_end:
                second_track, second_end = track_id, end
            first.append((first_track, first_end))
            second.append((second_track, second_end))
        return cls(tuple(start for start, _end, _track in ordered), tuple(first), tuple(second))

    def overlaps_except(self, track_id: str, start: float, end: float) -> bool:
        if end <= start:
            return False
        before = bisect_left(self.starts, end)
        if before == 0:
            return False
        first_track, first_end = self.first[before - 1]
        if first_track == track_id:
            return self.second[before - 1][1] > start
        return first_end > start


@dataclass(frozen=True)
class PeerTrackSpeechIndex:
    shared: PeerSpeechIndex
    track_id: str

    def overlaps(self, start: float, end: float) -> bool:
        return self.shared.overlaps_except(self.track_id, start, end)


def peer_speech_indexes(project: EpisodeProject) -> dict[str, PeerTrackSpeechIndex]:
    shared = PeerSpeechIndex.build(SessionAir(project).placed_word_spans())
    return {tr.track_id: PeerTrackSpeechIndex(shared, tr.track_id) for tr in project.transcripts}


def peer_speaking_in_gap(
    project: EpisodeProject,
    track_id: str,
    gap_start: float,
    gap_end: float,
    peer_indexes: dict[str, PeerTrackSpeechIndex] | None = None,
) -> bool:
    """True when another dialogue transcript has audible words in the gap.

    Transcript evidence only, which is enough for the pause floor (a turn gap
    versus a thinking pause). Whether a peer is audibly voiced in a gap is
    :func:`_peer_voiced_at`. A peer muted in the mix still counts: the mute
    is a listening choice, and a cut here ripples the muted track too.
    """
    indexes = peer_indexes if peer_indexes is not None else peer_speech_indexes(project)
    index = indexes.get(track_id)
    if index is None:
        shared = next(iter(indexes.values()), None)
        if shared is None:
            return False
        index = PeerTrackSpeechIndex(shared.shared, track_id)
    return any(
        index.overlaps(float(start), float(end))
        for start, end in SessionTimeline(project).map_source_span(
            track_id, SourceSec(gap_start), SourceSec(gap_end)
        )
    )


def retained_pause_floor_sec(
    project: EpisodeProject,
    track_id: str,
    gap_start: float,
    gap_end: float,
    defaults: dict[str, Any],
    peer_indexes: dict[str, PeerTrackSpeechIndex] | None = None,
) -> tuple[float, bool]:
    """How much pause air to keep; solo thinking pauses keep more than turn gaps.

    Returns (floor_sec, is_solo). Peer speech in the gap → turn/dead-air floor
    (``min_retained_pause_sec``). Quiet peers → same-speaker thinking floor
    (``min_retained_solo_pause_sec``, default 0.55s).
    """
    tighten = defaults.get("tighten", {})
    turn_floor = float(tighten.get("min_retained_pause_sec", 0.18))
    solo_floor = float(tighten.get("min_retained_solo_pause_sec", 0.55))
    if solo_floor < turn_floor:
        solo_floor = turn_floor
    if peer_speaking_in_gap(project, track_id, gap_start, gap_end, peer_indexes):
        return turn_floor, False
    return solo_floor, True
