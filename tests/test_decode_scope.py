"""A batch of edits decodes each stem once: Approve all must not redo the ffmpeg pass per edit."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import ungated_audio
from podcast_mcp.engines.ungated_audio import decode_scope, load_mono_full


@pytest.fixture
def decodes(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    seen: list[Path] = []

    def fake(path: Path, sample_rate: int, ffmpeg: str | None, layout: list[str]) -> np.ndarray:
        seen.append(path)
        return np.zeros(4, dtype=np.float32)

    monkeypatch.setattr(ungated_audio, "_decode_f32_uncached", fake)
    return seen


def test_decodes_each_file_once_inside_the_scope(tmp_path: Path, decodes: list[Path]) -> None:
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"x")
    with decode_scope():
        first = load_mono_full(wav, sample_rate=8000)
        second = load_mono_full(wav, sample_rate=8000)
    assert second is first
    assert decodes == [wav]


def test_other_rates_and_files_decode_separately(tmp_path: Path, decodes: list[Path]) -> None:
    a, b = tmp_path / "a.wav", tmp_path / "b.wav"
    a.write_bytes(b"x")
    b.write_bytes(b"x")
    with decode_scope():
        load_mono_full(a, sample_rate=8000)
        load_mono_full(a, sample_rate=16000)
        load_mono_full(b, sample_rate=8000)
    assert decodes == [a, a, b]


def test_a_changed_file_is_decoded_again(tmp_path: Path, decodes: list[Path]) -> None:
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"x")
    with decode_scope():
        load_mono_full(wav)
        wav.write_bytes(b"xyz")
        load_mono_full(wav)
    assert decodes == [wav, wav]


def test_nothing_is_kept_outside_or_after_a_scope(tmp_path: Path, decodes: list[Path]) -> None:
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"x")
    load_mono_full(wav)
    load_mono_full(wav)
    with decode_scope():
        load_mono_full(wav)
    with decode_scope():
        load_mono_full(wav)
    assert decodes == [wav] * 4


def test_a_nested_scope_shares_the_outer_decodes(tmp_path: Path, decodes: list[Path]) -> None:
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"x")
    with decode_scope():
        load_mono_full(wav)
        with decode_scope():
            load_mono_full(wav)
    assert decodes == [wav]
