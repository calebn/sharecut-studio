"""A cached verdict equals a cold check across random multi-track timelines and edits (#2365)."""

from __future__ import annotations

import dataclasses
import itertools
import random
import wave
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import verdict_cache
from podcast_mcp.edits.cut_application import approve_edits, precompute_verdicts
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)

SR, DUR = 16_000, 120
FADES = [0, 10, 50, 200, 500, 900, 1000]  # a clip fade over 1 s turns the cache off
# Seeds where the straddler perturbation fails against a key without the straddler terms.
SEEDS = [
    13,
    15,
    21,
    pytest.param(
        26,
        marks=pytest.mark.xfail(
            strict=True,
            reason="#2383 zero-fade split of a far clip on another track: warm cache adds a "
            "'voiced edge' flag",
        ),
    ),
    29,
]


_um = {"type": EditDecisionType.REMOVE, "reason": "filler:um", "applied": False}


def _build(seed: int, root: Path) -> EpisodeProject:
    rng = random.Random(seed)
    tids = ["host", "guest", "third"][: rng.choice([2, 3])]
    project = EpisodeProject.create("fuzz", str(root))
    project.timeline.duration_sec = DUR
    for ti, tid in enumerate(tids):
        words, t = [], rng.uniform(1, 5)
        while t < DUR - 4:
            words.append(
                TranscriptWord(text=f"w{len(words)}", start=round(t, 3), end=round(t + 0.35, 3))
            )
            t += 0.35 + rng.choice([0.2, 0.7, 1.5, 2.5, 6.0])
        for i in sorted(rng.sample(range(10, len(words) - 10), 3)):
            words[i].text = "um"
            project.edit_decisions.append(
                EditDecision(
                    id=f"e{tid}{i}",
                    track_id=tid,
                    start=words[i].start,
                    end=words[i].end,
                    **_um,
                    boundary_mode="vocal_transcript_guided",
                )
            )
        audio = np.random.default_rng(seed * 10 + ti).normal(0.0, 0.0003, DUR * SR)
        for w in words:
            if w.text != "um":
                a, n = round(w.start * SR), round(0.35 * SR)
                audio[a : a + n] += 0.2 * np.sin(2 * np.pi * 180 * np.arange(n) / SR)
        path = root / "raw" / f"{tid}.wav"
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as handle:
            handle.setparams((1, 2, SR, 0, "NONE", "NONE"))
            handle.writeframes((audio * 32767).astype("<i2").tobytes())
        media = MediaAsset(path=f"raw/{tid}.wav", duration_sec=DUR, sample_rate=SR, channels=1)
        project.tracks.append(Track(id=tid, label=tid, role=TrackRole.DIALOGUE, media=media))
        project.transcripts.append(Transcript(track_id=tid, words=words))
        joins = sorted(round(rng.uniform(3, DUR - 3), 2) for _ in range(rng.randint(2, 6)))
        edges = [0.0, *joins, float(DUR)]
        fades = [rng.choice(FADES) for _ in edges]
        project.clips += [
            Clip(
                id=f"{tid}{i}",
                track_id=tid,
                source_start=a,
                source_end=b,
                timeline_start=a,
                fade_in_ms=fades[i],
                fade_out_ms=fades[i + 1],
            )
            for i, (a, b) in enumerate(itertools.pairwise(edges))
        ]
    return project


def _perturbed(project: EpisodeProject, rng: random.Random, kind: str) -> EpisodeProject:
    copy = project.model_copy(deep=True)
    edit = rng.choice(copy.edit_decisions)
    at = round(min(max(edit.start + rng.uniform(-16.0, 16.0), 1.0), DUR - 1.0), 3)
    tid = edit.track_id
    clips = [c for c in copy.clips if c.track_id == tid]
    if kind == "straddler":  # the clip around the cut, so a ramp at its far end moves
        clip = next(c for c in clips if c.source_start <= edit.start < c.source_end)
        clip.fade_in_ms, clip.fade_out_ms = rng.choice(FADES[3:]), rng.choice(FADES[3:])
    elif kind == "split":  # a cut applied far away writes a fade pair
        clip = next(c for c in clips if c.source_start < at < c.source_end)
        fade = rng.choice(FADES)
        left = clip.model_copy(update={"source_end": at, "fade_out_ms": fade})
        right = clip.model_copy(
            update={"id": "x", "source_start": at, "timeline_start": at, "fade_in_ms": fade}
        )
        copy.clips = [c for c in copy.clips if c is not clip] + [left, right]
    else:
        transcript = copy.transcript_for_source(tid, None)
        assert transcript is not None
        transcript.words.append(TranscriptWord(text="zz", start=at, end=at + 0.3))
        transcript.words.sort(key=lambda w: w.start)
    return copy


def _outcome(project: EpisodeProject) -> tuple[Any, ...]:
    copy = project.model_copy(deep=True)
    held: list = []
    asked: list = []
    ids = [e.id for e in copy.edit_decisions]
    applied = approve_edits(copy, ids, defaults=load_defaults(), held_out=held, asked_out=asked)
    clips = sorted(
        (c.track_id, c.timeline_start, c.source_start, c.source_end, c.fade_in_ms, c.fade_out_ms)
        for c in copy.clips
    )
    return applied, [dataclasses.asdict(r) for r in held + asked], clips


@pytest.mark.parametrize("seed", SEEDS)
def test_a_cached_verdict_equals_a_cold_check_across_random_timelines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seed: int
) -> None:
    monkeypatch.delenv(verdict_cache.VERIFY_ENV, raising=False)
    project = _build(seed, tmp_path)
    variants = {"base": project}
    for kind in ("straddler", "split", "word"):
        variants[kind] = _perturbed(project, random.Random(seed * 100 + ord(kind[0])), kind)
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "0")
    cold = {name: _outcome(p) for name, p in variants.items()}
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    verdict_cache._STORE.clear()
    precompute_verdicts(project, [e.id for e in project.edit_decisions], defaults=load_defaults())
    warm = {name: _outcome(p) for name, p in variants.items()}
    assert [name for name in cold if warm[name] != cold[name]] == []
