"""A changed track's evidence reuses the unchanged start of the previous one and equals a full rebuild bit for bit (#1958)."""

from __future__ import annotations

import os
import random
import wave
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import resample_splice, track_evidence, ungated_audio
from podcast_mcp.engines.audio import (
    At,
    Audio,
    CrossfadeAudio,
    MixAudio,
    MuteEnvelope,
    OffSpeakerAudio,
    SequenceAudio,
    SilenceAudio,
    SourceAudio,
    SourceMuteEnvelope,
)
from podcast_mcp.engines.track_evidence import Declined, EvidenceKey, _Entry
from podcast_mcp.util.batch_scope import batch_scope
from podcast_mcp.util.process import CalledProcessError
from podcast_mcp.util.project_state import file_revision
from test_audio_eval import _ffmpeg_or_skip

RATE = 48000
RATES = (8000, 16000)
SECONDS = 5
MIN_SLICE = 9600


def _write(path: Path, kind: str, seed: int, seconds: int = SECONDS) -> Path:
    rng = np.random.default_rng(seed)
    count = seconds * RATE
    t = np.arange(count) / RATE
    if kind == "noise":
        signal = rng.standard_normal(count) * 0.1
    elif kind == "silence":
        signal = np.zeros(count)
    else:
        envelope = np.clip(np.sin(2 * np.pi * 4 * t) * np.sin(2 * np.pi * 0.7 * t), 0, None)
        signal = np.clip(rng.standard_normal(count) * envelope * 3.0, -1.0, 1.0)
    pcm = (signal * 32767).astype("<i2")
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(pcm.tobytes())
    return path


@dataclass(frozen=True)
class Slice:
    """Source samples ``[start, end)`` and how the track plays them."""

    start: int
    end: int
    fade_in: float
    fade_out: float
    mutes: tuple[MuteEnvelope, ...]
    filled: bool
    join: str  # how it follows the previous slice: "cut", "silence" or "crossfade"
    gap: float  # the silence or crossfade length in seconds


def _random_slices(rng: random.Random) -> list[Slice]:
    slices, at = [], rng.randrange(0, 20000)
    while len(slices) < rng.randint(3, 8) and at + 2 * MIN_SLICE < SECONDS * RATE - 20000:
        end = min(at + rng.randint(MIN_SLICE, 80000), SECONDS * RATE - 1)
        slices.append(_decorated(rng, at, end))
        at = end + rng.randint(1000, 30000)
    return slices


def _decorated(rng: random.Random, start: int, end: int) -> Slice:
    mutes = ()
    if rng.random() < 0.3:
        begin = rng.uniform(0.02, 0.1)
        mutes = (MuteEnvelope(begin, begin + rng.uniform(0.02, 0.1), 0.01, 0.01, 0.0),)
    join = rng.choice(["cut", "silence", "crossfade"])
    return Slice(
        start,
        end,
        rng.choice([0.0, 0.015, 0.025]),
        rng.choice([0.0, 0.015, 0.025]),
        mutes,
        rng.random() < 0.3,
        join,
        rng.choice([0.01, 0.02]) if join == "crossfade" else rng.uniform(0.05, 0.3),
    )


def _remove(slices: list[Slice], first: int, last: int) -> list[Slice]:
    """Ripple delete source samples ``[first, last)``: slices that held them shrink or split."""
    out: list[Slice] = []
    for piece in slices:
        if last <= piece.start or first >= piece.end:
            out.append(piece)
            continue
        if first - piece.start >= MIN_SLICE:
            out.append(replace(piece, end=first))
        if piece.end - last >= MIN_SLICE:
            out.append(replace(piece, start=last, join="cut" if out else piece.join))
    return out or slices


def _tree(slices: Sequence[Slice], sources: dict[str, Path]) -> Audio:
    def leaf(piece: Slice) -> SourceAudio:
        return SourceAudio(
            sources["main"],
            piece.start / RATE,
            piece.end / RATE,
            piece.fade_in,
            piece.fade_out,
            piece.mutes,
            sources["fill"] if piece.filled else None,
        )

    tree: Audio = leaf(slices[0])
    for piece in slices[1:]:
        if piece.join == "crossfade":
            tree = CrossfadeAudio(tree, leaf(piece), piece.gap)
        elif piece.join == "silence":
            tree = SequenceAudio(tree, (SilenceAudio(piece.gap), leaf(piece)))
        else:
            tree = SequenceAudio(tree, (leaf(piece),))
    return tree


def _decorate(tree: Audio, sources: dict[str, Path], flavour: int) -> Audio:
    """Wrap the slices' tree in the mix delay and off-speaker envelope some tracks carry."""
    if flavour % 3 == 1:
        other = SourceAudio(sources["other"], 0.5, 2.5, 0.01, 0.02)
        return MixAudio(At(0.0, tree), (At(0.4 + 0.013 * flavour, other),))
    if flavour % 3 == 2:
        primary = SourceAudio(sources["main"], 0.0, 1.0)
        envelopes = (
            SourceMuteEnvelope(1.0, 1.5, 0.05, 0.05),
            SourceMuteEnvelope(3.0, 3.3, 0.02, 0.1),
        )
        return OffSpeakerAudio(tree, primary, envelopes, ((1.2, 1.3),))
    return tree


def _bits(array: np.ndarray) -> np.ndarray:
    return array.view(np.uint32)


def _assert_same(got: _Entry, want: _Entry) -> None:
    assert got.digests == want.digests
    for rate in RATES:
        assert got.samples[rate].shape == want.samples[rate].shape, rate
        np.testing.assert_array_equal(_bits(got.samples[rate]), _bits(want.samples[rate]))
        assert repr(got.cache(rate).recording_profile) == repr(want.cache(rate).recording_profile)


def _entry(tree: Audio, base: _Entry | None = None) -> _Entry:
    built = track_evidence._evaluate(tree, "tri", None if base is None else base.base)
    assert not isinstance(built, Declined), built
    return built


@pytest.fixture
def fed(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """The input samples each evaluation sent to ffmpeg."""
    sizes: list[int] = []
    real = ungated_audio.resample_streams

    def counting(chunks: Iterator[np.ndarray], from_rate: int, to_rates):  # type: ignore[no-untyped-def]
        total = 0

        def count() -> Iterator[np.ndarray]:
            nonlocal total
            for chunk in chunks:
                total += len(chunk)
                yield chunk

        try:
            return real(count(), from_rate, to_rates)
        finally:
            sizes.append(total)

    for module in (track_evidence, resample_splice):
        if hasattr(module, "resample_streams"):
            monkeypatch.setattr(module, "resample_streams", counting)
    return sizes


@pytest.fixture
def sources(tmp_path: Path) -> dict[str, Path]:
    _ffmpeg_or_skip()
    return {
        "main": _write(tmp_path / "main.wav", "speech", 1),
        "other": _write(tmp_path / "other.wav", "noise", 2),
        "fill": _write(tmp_path / "fill.wav", "noise", 3),
    }


def _long_pair(tmp_path: Path) -> tuple[Audio, Audio, Path]:
    """A 40 s track and the same track with 0.37 s cut at 30 s."""
    path = _write(tmp_path / "long.wav", "noise", 7, seconds=40)

    def tree(cut: bool) -> Audio:
        parts = [SourceAudio(path, 0.0, 30.0, 0.01, 0.0)]
        if cut:
            parts += [SourceAudio(path, 30.37, 39.0, 0.0, 0.01)]
        else:
            parts += [SourceAudio(path, 30.0, 39.0, 0.0, 0.01)]
        return SequenceAudio(parts[0], tuple(parts[1:]))

    return tree(False), tree(True), path


def test_second_state_feeds_only_the_suffix(tmp_path: Path, fed: list[int]) -> None:
    _ffmpeg_or_skip()
    before, after, _ = _long_pair(tmp_path)

    first = _entry(before)
    second = _entry(after, first)

    assert fed[0] == 39 * RATE
    assert fed[1] < 0.5 * fed[0]
    _assert_same(second, _entry(after))


def test_spliced_evidence_equals_full_rebuild(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    before, after, _ = _long_pair(tmp_path)

    spliced = _entry(after, _entry(before))

    _assert_same(spliced, _entry(after))
    assert set(spliced.samples) == set(RATES)


def test_no_locality_means_the_full_pass(
    tmp_path: Path, fed: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    before, after, _ = _long_pair(tmp_path)
    first = _entry(before)
    monkeypatch.setattr(resample_splice, "resampler_locality", lambda *_: None)

    second = _entry(after, first)

    assert fed[1] == round(38.63 * RATE)
    _assert_same(second, _entry(after))


def test_no_base_means_the_full_pass(tmp_path: Path, fed: list[int]) -> None:
    _ffmpeg_or_skip()
    _, after, _ = _long_pair(tmp_path)

    entry = _entry(after)

    assert fed == [round(38.63 * RATE)]
    assert entry.digests


def test_a_stale_base_is_ignored(tmp_path: Path, fed: list[int]) -> None:
    _ffmpeg_or_skip()
    _, after, _ = _long_pair(tmp_path)
    other = _write(tmp_path / "other.wav", "speech", 9, seconds=40)
    stale = _entry(SequenceAudio(SourceAudio(other, 0.0, 30.0), (SourceAudio(other, 30.37, 39.0),)))

    entry = _entry(after, stale)

    assert fed[1] == fed[0]
    _assert_same(entry, _entry(after))


def test_an_evicted_base_is_not_offered(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _ffmpeg_or_skip()
    before, after, path = _long_pair(tmp_path)
    bases: list[object] = []
    real = track_evidence._evaluate

    def spy(tree, curve, base=None):  # type: ignore[no-untyped-def]
        bases.append(base)
        return real(tree, curve, base)

    monkeypatch.setattr(track_evidence, "_evaluate", spy)
    revisions = (file_revision(path),)
    keys = [EvidenceKey(tree, "tri", revisions) for tree in (before, after)]
    with batch_scope():
        store = track_evidence._store()
        store.get_or_build(keys[0], lambda base: track_evidence._evaluate(before, "tri", base))
        store._entries.clear()
        store.get_or_build(keys[1], lambda base: track_evidence._evaluate(after, "tri", base))

    assert bases == [None, None]


def test_the_newest_entry_over_the_same_sources_is_the_base(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    before, after, path = _long_pair(tmp_path)
    bases: list[object] = []
    real = track_evidence._evaluate

    def spy(tree, curve, base=None):  # type: ignore[no-untyped-def]
        bases.append(base)
        return real(tree, curve, base)

    monkeypatch.setattr(track_evidence, "_evaluate", spy)
    revisions = (file_revision(path),)
    with batch_scope():
        store = track_evidence._store()
        first = store.get_or_build(
            EvidenceKey(before, "tri", revisions),
            lambda base: track_evidence._evaluate(before, "tri", base),
        )
        store.get_or_build(
            EvidenceKey(after, "tri", revisions),
            lambda base: track_evidence._evaluate(after, "tri", base),
        )

    assert isinstance(first, _Entry)
    assert bases[0] is None
    assert bases[1] is not None
    assert bases[1].digests == first.digests  # type: ignore[attr-defined]


def test_rebuilt_with_changed_source_revision_misses(tmp_path: Path, fed: list[int]) -> None:
    _ffmpeg_or_skip()
    before, after, path = _long_pair(tmp_path)
    bases: list[object] = []
    real = track_evidence._evaluate

    with batch_scope():
        store = track_evidence._store()

        def build(tree: Audio):  # type: ignore[no-untyped-def]
            def run(base):  # type: ignore[no-untyped-def]
                bases.append(base)
                return real(tree, "tri", base)

            return run

        store.get_or_build(EvidenceKey(before, "tri", (file_revision(path),)), build(before))
        os.utime(path, ns=(1, 1))
        store.get_or_build(EvidenceKey(after, "tri", (file_revision(path),)), build(after))

    assert bases == [None, None]
    assert fed[1] == fed[0] - round(0.37 * RATE)


def test_a_failed_spliced_run_is_repeated_in_full(
    tmp_path: Path, fed: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    before, after, _ = _long_pair(tmp_path)
    first = _entry(before)
    real = resample_splice.resample_streams
    calls = []

    def flaky(chunks, from_rate, to_rates):  # type: ignore[no-untyped-def]
        calls.append(1)
        if len(calls) == 1:
            list(chunks)
            raise CalledProcessError(1, ["ffmpeg"])
        return real(chunks, from_rate, to_rates)

    monkeypatch.setattr(resample_splice, "resample_streams", flaky)

    second = _entry(after, first)

    assert len(calls) == 2
    _assert_same(second, _entry(after))


def test_verify_mode_accepts_a_spliced_entry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    before, after, path = _long_pair(tmp_path)
    monkeypatch.setenv("PODCAST_EVIDENCE_VERIFY", "1")
    revisions = (file_revision(path),)
    with batch_scope():
        store = track_evidence._store()
        for tree in (before, after, after):
            got = store.get_or_build(
                EvidenceKey(tree, "tri", revisions),
                lambda base, tree=tree: track_evidence._evaluate(tree, "tri", base),
            )
            assert isinstance(got, _Entry)


def test_a_non_48khz_track_keeps_no_digests(tmp_path: Path) -> None:
    _ffmpeg_or_skip()
    path = tmp_path / "mono44.wav"
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(44100)
        out.writeframes(np.zeros(44100 * 3, dtype="<i2").tobytes())
    tree = SequenceAudio(SourceAudio(path, 0.0, 1.0), (SourceAudio(path, 1.5, 2.5),))

    assert _entry(tree).digests is None


def _edit_points(rng: random.Random, slices: list[Slice]) -> tuple[int, int]:
    """A removal: anywhere, in the first block, at a seam, in the last block, or nothing."""
    total = slices[-1].end
    where = rng.choice(["anywhere", "first", "seam", "last", "none"])
    length = rng.randint(1, 30000)
    if where == "none":
        return 0, 0
    if where == "first":
        first = rng.randint(0, 40000)
    elif where == "last":
        first = max(0, total - rng.randint(length, 40000))
    elif where == "seam":
        first = rng.choice(slices).start + rng.randint(-200, 200)
    else:
        first = rng.randint(0, total)
    return max(first, 0), max(first, 0) + length


@pytest.mark.timeout(900)
def test_random_ripple_removes_equal_full_rebuilds_bit_for_bit(
    sources: dict[str, Path], fed: list[int]
) -> None:
    residues: set[int] = set()
    reused = 0
    for case in range(200):
        rng = random.Random(1958 + case)
        slices = _random_slices(rng)
        flavour = case
        chain = _entry(_decorate(_tree(slices, sources), sources, flavour))
        for _ in range(rng.randint(1, 6)):
            first, last = _edit_points(rng, slices)
            residues.add((last - first) % 6)
            if last > first:
                slices = _remove(slices, first, last)
            tree = _decorate(_tree(slices, sources), sources, flavour)
            spliced = _entry(tree, chain)
            _assert_same(spliced, _entry(tree))
            reused += fed[-2] < fed[-1] * 0.9
            chain = spliced
    assert residues == set(range(6))
    assert reused > 100
