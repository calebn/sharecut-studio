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
TRACKS = ["host", "guest", "third"]
FADES = [0, 10, 50, 200, 500, 1000, 1500, 2000, 3000]
SEEDS = [13, 15, 28, 39]


def _write_wav(path: Path, seed: int, words: list[tuple[float, float]]) -> None:
    rng = np.random.default_rng(seed)
    audio = rng.normal(0.0, 0.0003, DUR * SR)
    for start, end in words:
        t = np.arange(round((end - start) * SR)) / SR
        audio[round(start * SR) : round(end * SR)] += (
            0.2 * np.sin(2 * np.pi * 180 * t) * rng.uniform(0.5, 1.0, t.size)
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes((audio * 32767).astype("<i2").tobytes())


def _build(seed: int, root: Path) -> EpisodeProject:
    rng = random.Random(seed)
    tids = TRACKS[: rng.choice([2, 3])]
    max_fade = rng.choice([0, 100, 1000, 2000, 3000])
    words: dict[str, list[TranscriptWord]] = {}
    for tid in tids:
        t = rng.uniform(1, 5)
        track_words = []
        while t < DUR - 4:
            track_words.append(
                TranscriptWord(
                    text=f"w{len(track_words)}", start=round(t, 3), end=round(t + 0.35, 3)
                )
            )
            gaps = (
                [0.2, 0.4, 0.7, 1.0, 1.5, 2.5, 4.0, 6.0] if tid == "host" else [0.5, 1.0, 3.0, 8.0]
            )
            t += 0.35 + rng.choice(gaps)
        words[tid] = track_words
    project = EpisodeProject.create("fuzz", str(root))
    project.tracks = [
        Track(
            id=tid,
            label=tid,
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=DUR, sample_rate=SR, channels=1),
        )
        for tid in tids
    ]
    for tid in tids:
        joins = sorted(round(rng.uniform(3, DUR - 3), 2) for _ in range(rng.randint(2, 8)))
        edges = [0.0, *joins, float(DUR)]
        fades = [rng.choice([f for f in FADES if f <= max_fade]) for _ in edges]
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
    project.timeline.duration_sec = DUR
    edits = []
    pos = rng.uniform(5, 15)
    while pos < DUR - 8 and len(edits) < 8:
        tid = "host" if rng.random() < 0.7 else rng.choice(tids)
        track_words = words[tid]
        kind = rng.choice(["pause", "pause", "filler", "nl"])
        ahead = [i for i, w in enumerate(track_words) if w.start >= pos][:1]
        if not ahead:
            break
        i = ahead[0]
        extra: dict[str, Any] = {}
        if kind == "pause":
            gaps = [
                j
                for j in range(i, len(track_words) - 1)
                if track_words[j + 1].start - track_words[j].end >= 1.4
            ]
            if not gaps:
                pos += 3
                continue
            margin = rng.choice([0.1, 0.3, 0.5])
            start = round(track_words[gaps[0]].end + margin, 3)
            end = round(track_words[gaps[0] + 1].start - margin, 3)
            if end - start < 0.2:
                pos += 3
                continue
            reason = rng.choice(["pause:long", "pause:tighten"])
            extra = {"replace_gap_sec": rng.choice([None, 0.35])}
        elif kind == "filler":
            track_words[i].text = "um"
            start, end = track_words[i].start, track_words[i].end
            reason = "filler:um"
        else:
            start = track_words[i].start
            end = round(start + rng.uniform(0.3, 1.5), 3)
            if (
                i + 1 < len(track_words)
                and rng.random() < 0.6
                and track_words[i + 1].start - track_words[i].end > 0.5
            ):
                start, end = (
                    round(track_words[i].end + 0.05, 3),
                    round(track_words[i + 1].start - 0.05, 3),
                )
            reason = "nl:range"
        pos = end
        if rng.random() < 0.75:
            for other in tids:
                if other != tid:
                    words[other] = [
                        w for w in words[other] if w.end < start - 2.5 or w.start > end + 2.5
                    ]
        edits.append(
            EditDecision(
                id=f"e{len(edits)}",
                track_id=tid,
                type=EditDecisionType.REMOVE,
                start=start,
                end=end,
                reason=reason,
                applied=False,
                boundary_mode="vocal_transcript_guided",
                **extra,
            )
        )
        pos += rng.uniform(2, 20)
    project.edit_decisions = edits
    for ti, tid in enumerate(tids):
        _write_wav(
            root / "raw" / f"{tid}.wav", seed * 10 + ti, [(w.start, w.end) for w in words[tid]]
        )
    project.transcripts = [Transcript(track_id=tid, words=words[tid]) for tid in tids]
    return project


def _perturbed(project: EpisodeProject, rng: random.Random, kind: str) -> EpisodeProject:
    copy = project.model_copy(deep=True)
    if not copy.edit_decisions:
        return copy
    edit = rng.choice(copy.edit_decisions)
    at = round(
        min(max(edit.start + rng.uniform(0.5, 16.0) * rng.choice([-1, 1]), 1.0), DUR - 1.0), 3
    )
    tid = (
        rng.choice([t.id for t in copy.tracks if t.id != edit.track_id])
        if kind == "other_fade"
        else edit.track_id
    )
    if kind in ("split", "other_fade"):
        for clip in list(copy.clips):
            if clip.track_id == tid and clip.source_start < at < clip.source_end:
                fade = rng.choice(FADES)
                left = clip.model_copy(update={"source_end": at, "fade_out_ms": fade})
                right = clip.model_copy(
                    update={
                        "id": clip.id + "x",
                        "source_start": at,
                        "timeline_start": at,
                        "fade_in_ms": fade,
                    }
                )
                copy.clips = [c for c in copy.clips if c is not clip] + [left, right]
                break
    elif kind == "fade":
        clip = min(
            (c for c in copy.clips if c.track_id == tid), key=lambda c: abs(c.source_start - at)
        )
        clip.fade_in_ms = rng.choice(FADES)
        clip.fade_out_ms = rng.choice(FADES)
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
    applied = approve_edits(
        copy,
        [e.id for e in copy.edit_decisions],
        defaults=load_defaults(),
        held_out=held,
        asked_out=asked,
    )
    return (
        applied,
        [dataclasses.asdict(h) for h in held],
        [dataclasses.asdict(a) for a in asked],
        sorted(
            (
                c.track_id,
                c.timeline_start,
                c.source_start,
                c.source_end,
                c.fade_in_ms,
                c.fade_out_ms,
            )
            for c in copy.clips
        ),
    )


@pytest.mark.parametrize("seed", SEEDS)
def test_a_cached_verdict_equals_a_cold_check_across_random_timelines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seed: int
) -> None:
    monkeypatch.delenv(verdict_cache.VERIFY_ENV, raising=False)
    project = _build(seed, tmp_path)
    variants = {"base": project}
    for kind in ("split", "fade", "word", "other_fade"):
        variants[kind] = _perturbed(project, random.Random(seed * 100 + ord(kind[0])), kind)
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "0")
    cold = {name: _outcome(p) for name, p in variants.items()}
    monkeypatch.setenv(verdict_cache.ENABLE_ENV, "1")
    verdict_cache._STORE.clear()
    precompute_verdicts(project, [e.id for e in project.edit_decisions], defaults=load_defaults())
    warm = {name: _outcome(p) for name, p in variants.items()}
    assert [name for name in cold if warm[name] != cold[name]] == []
