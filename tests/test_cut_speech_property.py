"""The owner rule for ripples (#1137), over random multi-track timelines.

A ripple that removes another speaker's unsuppressed word asks first
(``needs_confirmation``) and changes nothing. A ripple that removes none applies with
no warning. "Another speaker's word" is any word outside what the edit selected on
its own track: a deleted clip's own extent, a range cut's named tracks, the trimmed
span of the trimmed clip, or a suggestion's span on its track. The oracle reads the
outcome off the timeline (which words stop mapping to it), not off the guard.

Every boundary sits on a whole second and every word inside one, so a word is either
wholly kept or wholly cut. The audio is silent, so only words count as speech.
"""

from __future__ import annotations

import random
import wave
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path

import pytest

from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    Clip,
    EditMode,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document.boundary import TrimBoundaryTarget, boundary_context
from podcast_mcp.util.timebase import SourceSec

SR = 8_000
TIMELINE_SEC = 12
MEDIA_SEC = 20
SEEDS = range(40)
OPS = ("delete", "cut", "trim", "approve")


@dataclass(frozen=True)
class Extent:
    track_id: str
    start: float
    end: float


def _silent_wav(path: Path) -> None:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SR)
        out.writeframes(b"\x00\x00" * SR * MEDIA_SEC)


def _random_track_clips(rng: random.Random, track_id: str) -> list[Clip]:
    """Whole-second clips over the timeline, some gaps, source offsets that only grow."""
    cuts = sorted(rng.sample(range(1, TIMELINE_SEC), rng.randint(1, 4)))
    edges = [0, *cuts, TIMELINE_SEC]
    clips: list[Clip] = []
    offset = 0
    for index, (start, end) in enumerate(pairwise(edges)):
        offset += rng.choice((0, 0, 1, 2))
        if clips and rng.random() < 0.15:
            continue
        clips.append(
            Clip(
                id=f"{track_id}-{index}",
                track_id=track_id,
                source_start=float(start + offset),
                source_end=float(end + offset),
                timeline_start=float(start),
            )
        )
    return clips


def _random_words(rng: random.Random) -> list[TranscriptWord]:
    return [
        TranscriptWord(
            text=f"w{second}",
            start=second + 0.2,
            end=second + 0.7,
            suppressed=rng.random() < 0.15,
        )
        for second in range(MEDIA_SEC - 1)
        if rng.random() < 0.5
    ]


def _build(path: Path, rng: random.Random) -> list[str]:
    project = load_project(path)
    track_ids = [f"t{i}" for i in range(rng.randint(2, 3))]
    for tid in track_ids:
        _silent_wav(project.raw_dir() / f"{tid}.wav")
    project.timeline.tracks = [
        Track(
            id=tid,
            label=tid,
            speaker=f"Speaker {tid}",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=MEDIA_SEC, sample_rate=SR),
        )
        for tid in track_ids
    ]
    project.timeline.clips = [c for tid in track_ids for c in _random_track_clips(rng, tid)]
    project.timeline.duration_sec = float(TIMELINE_SEC)
    project.transcripts = [Transcript(track_id=tid, words=_random_words(rng)) for tid in track_ids]
    save_project(project)
    return track_ids


def _word_positions(project: EpisodeProject) -> dict[tuple[str, float], float]:
    """Timeline position of each unsuppressed word's middle, keyed by track and source."""
    timeline = SessionTimeline(project)
    out: dict[tuple[str, float], float] = {}
    for transcript in project.transcripts:
        for word in transcript.words:
            if word.suppressed:
                continue
            mid = (word.start + word.end) / 2
            at = timeline.source_to_timeline(transcript.track_id, SourceSec(mid))
            if at is not None:
                out[(transcript.track_id, mid)] = float(at)
    return out


def _others_cut(
    before: dict[tuple[str, float], float], after: EpisodeProject, selected: list[Extent]
) -> list[tuple[str, float]]:
    """Words that left the timeline although the edit did not select them on their track.

    A track left with no clips has lost every word (``SessionTimeline`` would map its
    raw media one to one).
    """
    timeline = SessionTimeline(after)
    placed = {c.track_id for c in after.clips}
    return sorted(
        (tid, at)
        for (tid, mid), at in before.items()
        if (tid not in placed or timeline.source_to_timeline(tid, SourceSec(mid)) is None)
        and not any(e.track_id == tid and e.start <= at <= e.end for e in selected)
    )


def _timeline_span(clip: Clip, source_start: float, source_end: float) -> tuple[float, float]:
    shift = clip.timeline_start - clip.source_start
    return source_start + shift, source_end + shift


class _Op:
    """One random ripple, run through ``EditService`` as the GUI, CLI and MCP run it."""

    def __init__(self, path: Path, rng: random.Random, kind: str, track_ids: list[str]) -> None:
        self.path = path
        self.kind = kind
        project = load_project(path)
        clips = sorted(project.clips, key=lambda c: (c.track_id, c.timeline_start))
        if kind == "delete":
            self.clips = rng.sample(clips, rng.randint(1, min(3, len(clips))))
        elif kind == "cut":
            self.start, self.end = sorted(rng.sample(range(TIMELINE_SEC + 1), 2))
            self.track_ids = [t for t in track_ids if rng.random() < 0.5]
        elif kind == "trim":
            self.clip = rng.choice(clips)
            self.edge = rng.choice(("in", "out"))
            self.source_sec = float(
                rng.randint(int(self.clip.source_start) - 2, int(self.clip.source_end) + 2)
            )
        else:
            self.clip = rng.choice(clips)
            lo, hi = int(self.clip.source_start), int(self.clip.source_end)
            self.source_start = float(rng.randint(lo, hi - 1))
            self.source_end = float(rng.randint(int(self.source_start) + 1, hi))
            self.edit_id = self._suggest_without_other_words()

    def _suggest_without_other_words(self) -> str:
        """Suggest while no other track has words, so approval must judge the transcript then."""
        project = load_project(self.path)
        kept = {t.track_id: list(t.words) for t in project.transcripts}
        for transcript in project.transcripts:
            if transcript.track_id != self.clip.track_id:
                transcript.words = []
        save_project(project)
        service = EditService(ProjectWorkspace.open(self.path))
        edit = service.suggest_pending_edit(
            self.clip.track_id, self.source_start, self.source_end, author="commenter"
        )
        project = load_project(self.path)
        for transcript in project.transcripts:
            transcript.words = kept[transcript.track_id]
        save_project(project)
        return str(edit["id"])

    def run(self, *, confirm: bool) -> bool:
        """Run the ripple; ``True`` when it asked to confirm instead."""
        service = EditService(ProjectWorkspace.open(self.path))
        if self.kind == "delete":
            out = service.delete_clips(
                [c.id for c in self.clips], mode=EditMode.RIPPLE, confirm_cut_speech=confirm
            )
        elif self.kind == "cut":
            if self.end <= self.start:
                return False
            out = service.cut_range(
                float(self.start),
                float(self.end),
                mode=EditMode.RIPPLE,
                track_ids=self.track_ids,
                use_inaudible_opt=False,
                confirm_cut_speech=confirm,
            )
        elif self.kind == "trim":
            token = boundary_context(
                load_project(self.path),
                TrimBoundaryTarget(clip_id=self.clip.id, edge=self.edge, mode=EditMode.RIPPLE),
            ).token
            out = service.trim_clip_edge(
                self.clip.id,
                self.edge,
                self.source_sec,
                mode=EditMode.RIPPLE,
                expected_token=token,
                confirm_cut_speech=confirm,
            )
        else:
            approved = service.approve([self.edit_id], confirm_cut_speech=confirm)
            return not isinstance(approved, int)
        return out.get("needs_confirmation") is not None

    def selected(self, after: EpisodeProject) -> list[Extent]:
        """What the person chose to cut, each on its own track."""
        if self.kind == "delete":
            return [Extent(c.track_id, c.timeline_start, c.timeline_end) for c in self.clips]
        if self.kind == "cut":
            return [Extent(t, float(self.start), float(self.end)) for t in self.track_ids]
        if self.kind == "trim":
            trimmed = next(c for c in after.clips if c.id == self.clip.id)
            if self.edge == "out":
                lost = self.clip.source_end - trimmed.source_end
                end = self.clip.timeline_end
                return [Extent(self.clip.track_id, end - lost, end)]
            lost = trimmed.source_start - self.clip.source_start
            start = self.clip.timeline_start
            return [Extent(self.clip.track_id, start, start + lost)]
        start, end = _timeline_span(self.clip, self.source_start, self.source_end)
        return [Extent(self.clip.track_id, start, end)]


@pytest.mark.parametrize("op", OPS)
@pytest.mark.parametrize("seed", SEEDS)
def test_a_ripple_asks_exactly_when_it_cuts_another_speakers_word(minimal_project, seed, op):
    rng = random.Random(seed * 31 + OPS.index(op))
    track_ids = _build(minimal_project, rng)
    edit = _Op(minimal_project, rng, op, track_ids)
    project = load_project(minimal_project)
    before_words = _word_positions(project)
    before_clips = [c.model_dump() for c in project.clips]

    asked = edit.run(confirm=False)

    if asked:
        assert [c.model_dump() for c in load_project(minimal_project).clips] == before_clips
        assert edit.run(confirm=True) is False
    after = load_project(minimal_project)
    cut = _others_cut(before_words, after, edit.selected(after))
    assert asked is bool(cut), f"asked={asked}, other words cut={cut}"
