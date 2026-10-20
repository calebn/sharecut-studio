"""Tonal multi-track projects for the batch timeline evidence, and the oracle that checks it.

Every dialogue track is room noise with voiced bursts (a harmonic tone per speaker), the
speakers' words are the transcripts, and the guests' mics carry the host's voice a little.
The oracle compares what the evidence answers for each cut with what a fresh build of the
current timeline answers.
"""

from __future__ import annotations

import dataclasses
import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from pause_policy_public_helpers import RATE, write_wav
from podcast_mcp.edits import cut_proof
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)

F0 = {"host": 120.0, "guest": 210.0, "third": 165.0}


def _voice(audio: np.ndarray, start: float, end: float, f0: float, db: float) -> None:
    lo, hi = round(start * RATE), min(round(end * RATE), audio.size)
    t = np.arange(hi - lo) / RATE
    wave = sum(np.sin(2 * np.pi * f0 * k * t + k) / k for k in range(1, 9))
    wave *= 10 ** (db / 20) / np.sqrt(np.mean(wave**2))
    ramp = np.minimum(np.arange(hi - lo), np.arange(hi - lo)[::-1]) / (0.01 * RATE)
    audio[lo:hi] += wave * np.minimum(1, ramp)


@dataclasses.dataclass
class Scenario:
    seconds: int = 600
    speakers: tuple[str, ...] = ("host", "guest")
    guest_source_start: float = 2.0
    guest_timeline_start: float = 0.0
    bleed_db: float | None = -30.0
    chain_on: str | None = None
    filler_every_sec: float = 17.0
    extra_edits: tuple[EditDecision, ...] = ()
    long_pause: tuple[float, float] | None = (100.0, 140.0)
    overlap_at: float | None = None
    seed: int = 7
    notes: dict[str, Any] = dataclasses.field(default_factory=dict)


def build_project(root: Path, scenario: Scenario) -> EpisodeProject:
    rng = np.random.default_rng(scenario.seed)
    dur = scenario.seconds
    audio = {
        n: np.random.default_rng(scenario.seed * 10 + i).normal(0, 10 ** (-66 / 20), dur * RATE)
        for i, n in enumerate(scenario.speakers)
    }
    words: dict[str, list[TranscriptWord]] = {n: [] for n in scenario.speakers}
    fillers: list[tuple[str, TranscriptWord]] = []
    t, index, next_filler = 1.0, 0, scenario.filler_every_sec
    while t < dur - 4:
        spk = scenario.speakers[index % len(scenario.speakers)]
        index += 1
        turn_end = t + rng.uniform(3, 6)
        w = t
        while w < turn_end and w < dur - 3:
            if scenario.long_pause and scenario.long_pause[0] <= w < scenario.long_pause[1]:
                w = scenario.long_pause[1]
                continue
            length = rng.uniform(0.15, 0.4)
            level = rng.uniform(-26, -16)
            _voice(audio[spk], w, w + length, F0[spk], level)
            if scenario.bleed_db is not None:
                for other in scenario.speakers:
                    if other != spk:
                        _voice(
                            audio[other],
                            w + 0.02,
                            w + 0.02 + length,
                            F0[spk],
                            level + scenario.bleed_db,
                        )
            filler = w >= next_filler
            word = TranscriptWord(
                text="um" if filler else f"w{len(words[spk])}",
                start=round(w, 3),
                end=round(w + length, 3),
            )
            words[spk].append(word)
            if filler:
                fillers.append((spk, word))
                next_filler = w + scenario.filler_every_sec
            w += length + rng.uniform(0.05, 0.4)
        t = max(w, turn_end) + rng.uniform(0.3, 1.0)

    held_filler: TranscriptWord | None = None
    if scenario.overlap_at is not None:
        at = scenario.overlap_at
        _voice(audio["host"], at, at + 0.4, F0["host"], -20)
        _voice(audio["guest"], at, at + 0.6, F0["guest"], -18)
        held_filler = TranscriptWord(text="um", start=at, end=at + 0.4)
        words["host"].append(held_filler)
        words["guest"].append(TranscriptWord(text="yeah", start=at, end=at + 0.6))
        fillers.append(("host", held_filler))

    project = EpisodeProject.create("tonal", str(root))
    project.tracks, project.clips, project.transcripts = [], [], []
    for name in scenario.speakers:
        write_wav(root / "raw" / f"{name}.wav", audio[name])
        project.tracks.append(
            Track(
                id=name,
                label=name.title(),
                role=TrackRole.DIALOGUE,
                media=MediaAsset(
                    path=f"raw/{name}.wav", duration_sec=dur, sample_rate=RATE, channels=1
                ),
            )
        )
        project.clips.append(
            Clip(
                id=name,
                track_id=name,
                source_start=scenario.guest_source_start if name == "guest" else 0.0,
                source_end=dur,
                timeline_start=scenario.guest_timeline_start if name == "guest" else 0.0,
            )
        )
        project.transcripts.append(Transcript(track_id=name, words=words[name]))
    if scenario.chain_on:
        project.processing_chains = [
            ProcessingChain(
                track_id=scenario.chain_on,
                effects=[ProcessingEffect(effect="highpass", params={"frequency": 80})],
            )
        ]
    project.timeline.duration_sec = dur
    edits = [
        EditDecision(
            id=f"f{i:02d}",
            track_id=spk,
            type=EditDecisionType.REMOVE,
            start=word.start - 0.02,
            end=word.end + 0.02,
            reason="filler:um",
            applied=False,
            boundary_mode="vocal_transcript_guided",
            review_required=False,
        )
        for i, (spk, word) in enumerate(fillers)
    ]
    if scenario.long_pause:
        lo, hi = scenario.long_pause
        edits.append(
            EditDecision(
                id="pause",
                track_id="host",
                type=EditDecisionType.REMOVE,
                start=lo + 0.1,
                end=hi - 0.1,
                reason=f"pause:{hi - lo - 0.2:.2f}s",
                applied=False,
                scope="session",
                boundary_mode="exact",
                review_required=False,
                replace_gap_sec=0.25,
            )
        )
    project.edit_decisions = [*edits, *scenario.extra_edits]
    return project


def same(a: object, b: object, tolerance: float) -> bool:
    """Two observations agree: every decision exactly, every measured level within ``tolerance``."""
    if isinstance(a, float) and isinstance(b, float):
        return a == b or math.isclose(a, b, abs_tol=tolerance) or (math.isnan(a) and math.isnan(b))
    if isinstance(a, np.ndarray) and isinstance(b, np.ndarray):
        return a.shape == b.shape and bool(np.allclose(a, b, atol=tolerance, equal_nan=True))
    if dataclasses.is_dataclass(a) and not isinstance(a, type) and type(a) is type(b):
        return all(
            same(getattr(a, f.name), getattr(b, f.name), tolerance) for f in dataclasses.fields(a)
        )
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k], tolerance) for k in a)
    if isinstance(a, tuple | list) and type(a) is type(b):
        return len(a) == len(b) and all(same(x, y, tolerance) for x, y in zip(a, b, strict=True))
    return a == b


class Oracle:
    """Checks every answer of the batch evidence against a fresh build of the same project."""

    def __init__(self) -> None:
        self.observations = 0
        self.rebuilds = 0
        self.mismatches: list[str] = []
        self.profile_error_db = 0.0
        self.outside_spread: list[str] = []

    def install(self, monkeypatch: pytest.MonkeyPatch, tolerance: float) -> None:
        real_observe = cut_proof.BatchTimelineEvidence.observe
        real_rebuild = cut_proof.BatchTimelineEvidence._rebuild
        oracle = self

        def rebuild(evidence, project):  # type: ignore[no-untyped-def]
            oracle.rebuilds += 1
            return real_rebuild(evidence, project)

        def observe(evidence, project, read):  # type: ignore[no-untyped-def]
            result = real_observe(evidence, project, read)
            fresh = cut_proof._build_timeline_rms_caches(project, evidence._defaults)
            expected = read(fresh)
            oracle.observations += 1
            assert evidence._caches is not None
            for tid, cache in evidence._caches.caches.items():
                want, got = fresh.caches[tid].profile, cache.profile
                spread = (
                    evidence._guesses[tid].spread_db(evidence._levels[tid])
                    if tid in evidence._guesses and tid in evidence._levels
                    else 0.0
                )
                for field in ("room_db", "speech_db", "loud_db"):
                    error = abs(getattr(want, field) - getattr(got, field))
                    oracle.profile_error_db = max(oracle.profile_error_db, error)
                    if error > spread + 1e-6:
                        oracle.outside_spread.append(f"{tid}.{field}: {error:.4f} > {spread:.4f}")
            if not same(result, expected, tolerance):
                oracle.mismatches.append(f"#{oracle.observations}: {result!r} != {expected!r}")
            return result

        monkeypatch.setattr(cut_proof.BatchTimelineEvidence, "observe", observe)
        monkeypatch.setattr(cut_proof.BatchTimelineEvidence, "_rebuild", rebuild)


def random_project(root: Path, seed: int) -> EpisodeProject:
    """A short multi-track project drawn from ``seed``: turns, bleed, offsets, a chain, many cuts.

    Seeds 23 and 209 are ones whose whole-track levels, measured once for the batch, led to
    a different decision than a build of the cut timeline.
    """
    rng = np.random.default_rng(seed)
    dur = int(rng.integers(50, 100))
    names = ["host", "guest", "third"][: int(rng.integers(2, 4))]
    audio = {
        n: np.random.default_rng(seed * 10 + i).normal(
            0, 10 ** (rng.uniform(-72, -60) / 20), dur * RATE
        )
        for i, n in enumerate(names)
    }
    offsets = {
        n: (float(rng.choice([0.0, 0.0, 1.5, 4.0])) if i else 0.0) for i, n in enumerate(names)
    }
    words: dict[str, list[TranscriptWord]] = {n: [] for n in names}
    options = np.random.default_rng(seed + 999)
    bleed, chain, ncuts = (
        bool(options.random() < 0.6),
        bool(options.random() < 0.5),
        int(options.integers(6, 28)),
    )
    bleed_db, bleed_lag = float(rng.uniform(-38, -24)), float(rng.uniform(0.0, 0.08))
    t, index = 1.0, 0
    while t < dur - 4:
        spk = names[int(rng.integers(len(names)))]
        turn_end, w = t + rng.uniform(3, 8), t
        while w < turn_end and w < dur - 3:
            length, level = rng.uniform(0.15, 0.45), rng.uniform(-26, -16)
            _voice(audio[spk], w, w + length, F0[spk], level)
            for other in names:
                if other != spk and bleed:
                    _voice(
                        audio[other],
                        w + bleed_lag,
                        w + length + bleed_lag,
                        F0[spk],
                        level + bleed_db,
                    )
            filler = rng.random() < 0.25
            words[spk].append(
                TranscriptWord(
                    text="um" if filler else f"w{index}",
                    start=round(w, 3),
                    end=round(w + length, 3),
                )
            )
            index += 1
            w += length + rng.uniform(0.05, 0.5 if rng.random() < 0.8 else 2.0)
        if rng.random() < 0.12 and len(names) > 1:
            other = next(n for n in names if n != spk)
            at = t + rng.uniform(0.5, 2)
            _voice(audio[other], at, at + 0.3, F0[other], -20)
            text = "uh" if rng.random() < 0.5 else "yeah"
            words[other].append(
                TranscriptWord(text=text, start=round(at, 3), end=round(at + 0.3, 3))
            )
        t = max(w, turn_end) + rng.uniform(0.2, 1.5)
    project = EpisodeProject.create("random", str(root))
    project.tracks, project.clips, project.transcripts = [], [], []
    for name in names:
        write_wav(root / "raw" / f"{name}.wav", audio[name])
        project.tracks.append(
            Track(
                id=name,
                label=name.title(),
                role=TrackRole.DIALOGUE,
                media=MediaAsset(
                    path=f"raw/{name}.wav", duration_sec=dur, sample_rate=RATE, channels=1
                ),
            )
        )
        project.clips.append(
            Clip(
                id=name, track_id=name, source_start=0, source_end=dur, timeline_start=offsets[name]
            )
        )
        project.transcripts.append(
            Transcript(track_id=name, words=sorted(words[name], key=lambda x: x.start))
        )
    if chain:
        project.processing_chains = [
            ProcessingChain(
                track_id=names[-1],
                effects=[ProcessingEffect(effect="highpass", params={"frequency": 80})],
            )
        ]
    project.timeline.duration_sec = dur + max(offsets.values())
    spoken = [(n, w) for n in names for w in words[n]]

    def clear(name: str, word: TranscriptWord) -> bool:
        return all(
            not (x.start < word.end + 0.4 and x.end > word.start - 0.4)
            for other in names
            if other != name
            for x in words[other]
        )

    candidates = [c for c in spoken if clear(*c) or rng.random() < 0.08]
    picked = rng.choice(len(candidates), size=min(len(candidates), ncuts), replace=False)
    edits: list[EditDecision] = []
    for i, k in enumerate(sorted(picked)):
        name, word = candidates[k]
        kind = rng.random()
        if kind > 0.8:
            start = round(word.end + 0.03, 3)
            edits.append(
                EditDecision(
                    id=f"e{i:03d}",
                    track_id=name,
                    type=EditDecisionType.REMOVE,
                    start=start,
                    end=round(start + rng.uniform(0.4, 1.4), 3),
                    reason="pause:2.10s",
                    applied=False,
                    scope="session",
                    boundary_mode="exact",
                    review_required=False,
                    replace_gap_sec=0.25,
                )
            )
            continue
        edits.append(
            EditDecision(
                id=f"e{i:03d}",
                track_id=name,
                type=EditDecisionType.MUTE if kind < 0.15 else EditDecisionType.REMOVE,
                start=word.start - 0.02,
                end=word.end + 0.02,
                reason="filler:um",
                applied=False,
                boundary_mode="vocal_transcript_guided",
                review_required=False,
                **({"scope": "track"} if kind < 0.15 else {}),
            )
        )
    project.edit_decisions = edits
    return project
