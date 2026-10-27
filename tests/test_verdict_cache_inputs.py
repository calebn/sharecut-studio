"""A cached verdict equals a cold check for the inputs #2392 asked about.

Pause words (real gap): a pause reads the transcript with no source id. Contributor edits and
words in clip gaps (not real): the cache serves one edit at a time, and edges sit on clip ends.
"""

from __future__ import annotations

import wave
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from pause_policy_public_helpers import room, voice, write_wav
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import verdict_cache
from podcast_mcp.edits.cut_application import approve_edits
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)

SR, DUR = 16_000, 120
PAUSE = (41.6, 41.79)


def _project(
    root: Path, *, sourced: bool, mutate: Callable[[EpisodeProject], None]
) -> EpisodeProject:
    audio = room(DUR)
    words = []
    for i, t in enumerate(np.arange(5.0, DUR - 5, 2.0)):
        t = round(float(t), 3)
        words.append(TranscriptWord(text=f"w{i}", start=t, end=round(t + 0.2, 3)))
        voice(audio, t, t + 0.2)
    path = root / "raw" / "host.wav"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as handle:
            handle.setparams((1, 2, SR, 0, "NONE", "NONE"))
            handle.writeframes((audio * 32767).astype("<i2").tobytes())
    project = EpisodeProject.create("inputs", str(root))
    project.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=DUR, sample_rate=SR, channels=1),
        )
    ]
    sid = "s1" if sourced else None
    if sourced:
        project.sources = [SourceRecording(id="s1", path="raw/host.wav", duration_sec=DUR)]
    project.clips = [
        Clip(
            id="c0",
            track_id="host",
            source_id=sid,
            source_start=0,
            source_end=DUR,
            timeline_start=0,
        )
    ]
    project.transcripts = [Transcript(track_id="host", words=words)]
    if sourced:
        project.transcripts.append(
            Transcript(track_id="host", source_id="s1", words=[w.model_copy() for w in words])
        )
    project.timeline.duration_sec = DUR
    project.edit_decisions = [
        EditDecision(
            id="e",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=PAUSE[0],
            end=PAUSE[1],
            reason="pause:0.19s",
            applied=False,
            boundary_mode="exact",
        )
    ]
    mutate(project)
    return project


def _outcome(project: EpisodeProject) -> Any:
    held: list = []
    applied = approve_edits(project, ["e"], defaults=load_defaults(), held_out=held, asked_out=[])
    clips = sorted(
        (c.timeline_start, c.source_start, c.source_end, c.fade_in_ms, c.fade_out_ms)
        for c in project.clips
    )
    return applied, [h.reason for h in held], clips


def _compare(tmp_path, monkeypatch, sourced, warm, change):
    hits: list[bool] = []
    lookup = verdict_cache.lookup

    def spy(key):
        found = lookup(key)
        hits.extend([True] if found else [])
        return found

    monkeypatch.setattr(verdict_cache, "lookup", spy)
    monkeypatch.delenv(verdict_cache.VERIFY_ENV, raising=False)
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "0")
    cold_warm = _outcome(_project(tmp_path, sourced=sourced, mutate=warm))
    cold = _outcome(_project(tmp_path, sourced=sourced, mutate=change))
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    verdict_cache._STORE.clear()
    _outcome(_project(tmp_path, sourced=sourced, mutate=warm))
    _outcome(_project(tmp_path, sourced=sourced, mutate=warm))
    assert hits, "the unchanged project must hit the cache"
    cached = _outcome(_project(tmp_path, sourced=sourced, mutate=change))
    return cold_warm, cold, cached


def _no_source(p: EpisodeProject) -> Transcript:
    return next(t for t in p.transcripts if t.source_id is None)


def _drop_after(p: EpisodeProject) -> None:
    _no_source(p).words = [w for w in _no_source(p).words if w.start < PAUSE[1]]


def _drop_before(p: EpisodeProject) -> None:
    _no_source(p).words = [w for w in _no_source(p).words if w.start >= PAUSE[1]]


def _suppress_after(p: EpisodeProject) -> None:
    for w in _no_source(p).words:
        if w.start >= PAUSE[1]:
            w.suppressed = True


def _only_after(p: EpisodeProject) -> None:
    _no_source(p).words = [w for w in _no_source(p).words if w.start >= 90.0]


def _word_after(p: EpisodeProject) -> None:
    _no_source(p).words.append(TranscriptWord(text="zz", start=90.0, end=90.2))
    _no_source(p).words.sort(key=lambda w: w.start)


def _nothing(p: EpisodeProject) -> None:
    return None


@pytest.mark.parametrize(
    ("warm", "change"),
    [
        pytest.param(_nothing, _drop_after, id="drop_every_word_after"),
        pytest.param(_nothing, _drop_before, id="drop_every_word_before"),
        pytest.param(_nothing, _suppress_after, id="suppress_every_word_after"),
        pytest.param(_drop_after, _word_after, id="a_word_appears_on_an_empty_side"),
        pytest.param(_nothing, _only_after, id="every_word_near_gone"),
    ],
)
def test_a_cached_pause_verdict_equals_a_cold_check_when_the_no_source_transcript_changes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    warm: Callable[[EpisodeProject], None],
    change: Callable[[EpisodeProject], None],
) -> None:
    before, cold, cached = _compare(tmp_path, monkeypatch, True, warm, change)
    assert before != cold, "the change must move the cold verdict"
    assert cached == cold


def _far_word(p: EpisodeProject) -> None:
    for w in _no_source(p).words:
        if 101.0 <= w.start <= 101.01:
            w.text = "changed"
            w.suppressed = True


def test_a_pause_verdict_stays_cached_when_a_no_source_word_beyond_its_neighbours_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    keys: list[str | None] = []
    real = verdict_cache.verdict_key

    def spy(*args: Any, **kwargs: Any) -> str | None:
        keys.append(real(*args, **kwargs))
        return keys[-1]

    monkeypatch.setattr(verdict_cache, "verdict_key", spy)
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    monkeypatch.delenv(verdict_cache.VERIFY_ENV, raising=False)
    verdict_cache._STORE.clear()
    _outcome(_project(tmp_path, sourced=True, mutate=_nothing))
    _outcome(_project(tmp_path, sourced=True, mutate=_far_word))
    assert keys[0] is not None
    assert keys[0] == keys[1]


# A filler cut on a host track; ``gap`` removes source [40, 44) from the clips.
CUT = 38.3


def _filler_project(
    root: Path, *, gap: bool, mutate: Callable[[EpisodeProject], None]
) -> EpisodeProject:
    audio = room(DUR)
    words = []
    for i, t in enumerate(np.arange(5.0, DUR - 5, 0.9)):
        t = round(float(t), 3)
        if abs(t - CUT) < 0.5:
            t = CUT
        words.append(
            TranscriptWord(text="um" if t == CUT else f"w{i}", start=t, end=round(t + 0.35, 3))
        )
        voice(audio, t, t + 0.35)
    path = root / "raw" / "host.wav"
    if not path.exists():
        write_wav(path, audio)
    project = EpisodeProject.create("inputs", str(root))
    project.tracks = [
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=DUR, sample_rate=SR, channels=1),
        )
    ]
    if gap:  # a previous cut removed source [40, 44)
        project.clips = [
            Clip(
                id="c0",
                track_id="host",
                source_start=0,
                source_end=40,
                timeline_start=0,
                fade_out_ms=50,
            ),
            Clip(
                id="c1",
                track_id="host",
                source_start=44,
                source_end=DUR,
                timeline_start=40,
                fade_in_ms=50,
            ),
        ]
        project.timeline.duration_sec = DUR - 4
    else:
        project.clips = [
            Clip(id="c0", track_id="host", source_start=0, source_end=DUR, timeline_start=0)
        ]
        project.timeline.duration_sec = DUR
    project.transcripts = [Transcript(track_id="host", words=words)]
    project.edit_decisions = [
        EditDecision(
            id="e",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=CUT,
            end=round(CUT + 0.35, 3),
            reason="filler:um",
            applied=False,
            boundary_mode="vocal_transcript_guided",
        )
    ]
    mutate(project)
    return project


def _cmp(tmp_path, monkeypatch, make, warm, change):
    hits: list[bool] = []
    lookup = verdict_cache.lookup

    def spy(key):
        found = lookup(key)
        hits.extend([True] if found else [])
        return found

    monkeypatch.setattr(verdict_cache, "lookup", spy)
    monkeypatch.delenv(verdict_cache.VERIFY_ENV, raising=False)
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "0")
    cold_warm = _outcome(make(tmp_path, warm))
    cold = _outcome(make(tmp_path, change))
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    verdict_cache._STORE.clear()
    _outcome(make(tmp_path, warm))
    _outcome(make(tmp_path, warm))
    assert hits
    return cold_warm, cold, _outcome(make(tmp_path, change))


def _mk(gap):
    return lambda root, mutate: _filler_project(root, gap=gap, mutate=mutate)


def _words(p):
    return p.transcripts[0].words


def test_a_contributor_edit_never_reaches_the_cut_check(tmp_path, monkeypatch):
    from podcast_mcp.edits import cut_safety

    seen = []
    orig = cut_safety._contributor_ends_in_valley

    def spy(project, ids, effect, cache):
        seen.append(set(ids))
        return orig(project, ids, effect, cache)

    monkeypatch.setattr(cut_safety, "_contributor_ends_in_valley", spy)

    def add(reason, end):
        def mutate(p):
            p.edit_decisions.append(
                EditDecision(
                    id="f",
                    track_id="host",
                    type=EditDecisionType.REMOVE,
                    start=CUT + 0.35,
                    end=end,
                    reason=reason,
                    applied=False,
                    boundary_mode="vocal_transcript_guided",
                )
            )

        return mutate

    _cw, cold, cached = _cmp(
        tmp_path,
        monkeypatch,
        _mk(False),
        add("filler:um", CUT + 0.5),
        add("filler:acoustic", CUT + 0.9),
    )
    assert seen
    assert cached == cold
    assert all(s == {"e"} for s in seen)


def _interior(fn):
    def mutate(p):
        fn(p.transcripts[0].words)

    return mutate


def _drop_interior(words):
    words[:] = [w for w in words if not (41.2 <= w.start < 42.9)]


def _suppress_interior(words):
    for w in words:
        if 41.2 <= w.start < 42.9:
            w.suppressed = True


def _ignore_interior(words):
    for w in words:
        if 41.2 <= w.start < 42.9:
            w.ignored = True


def _long_interior(words):
    words[:] = [w for w in words if not (41.2 <= w.start < 42.9)]
    words.append(TranscriptWord(text="long", start=41.3, end=42.7))
    words.sort(key=lambda w: w.start)


@pytest.mark.parametrize("cut", [36.0, 38.3, 39.2])
@pytest.mark.parametrize(
    "fn", [_drop_interior, _suppress_interior, _ignore_interior, _long_interior]
)
def test_a_cached_verdict_equals_a_cold_check_when_words_inside_a_clip_gap_change(
    tmp_path, monkeypatch, fn, cut
):
    import sys

    monkeypatch.setattr(sys.modules[__name__], "CUT", cut)
    _cw, cold, cached = _cmp(tmp_path, monkeypatch, _mk(True), lambda p: None, _interior(fn))
    assert cached == cold
