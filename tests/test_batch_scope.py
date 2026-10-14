"""A batch of edits decodes each stem once: Approve all must not redo the ffmpeg pass per edit."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import ungated_audio
from podcast_mcp.engines.ungated_audio import load_mono_full
from podcast_mcp.util.batch_scope import batch_scope


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
    with batch_scope():
        first = load_mono_full(wav, sample_rate=8000)
        second = load_mono_full(wav, sample_rate=8000)
    assert second is first
    assert decodes == [wav]


def test_other_rates_and_files_decode_separately(tmp_path: Path, decodes: list[Path]) -> None:
    a, b = tmp_path / "a.wav", tmp_path / "b.wav"
    a.write_bytes(b"x")
    b.write_bytes(b"x")
    with batch_scope():
        load_mono_full(a, sample_rate=8000)
        load_mono_full(a, sample_rate=16000)
        load_mono_full(b, sample_rate=8000)
    assert decodes == [a, a, b]


def test_a_changed_file_is_decoded_again(tmp_path: Path, decodes: list[Path]) -> None:
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"x")
    with batch_scope():
        load_mono_full(wav)
        wav.write_bytes(b"xyz")
        load_mono_full(wav)
    assert decodes == [wav, wav]


def test_nothing_is_kept_outside_or_after_a_scope(tmp_path: Path, decodes: list[Path]) -> None:
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"x")
    load_mono_full(wav)
    load_mono_full(wav)
    with batch_scope():
        load_mono_full(wav)
    with batch_scope():
        load_mono_full(wav)
    assert decodes == [wav] * 4


def test_a_nested_scope_shares_the_outer_decodes(tmp_path: Path, decodes: list[Path]) -> None:
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"x")
    with batch_scope():
        load_mono_full(wav)
        with batch_scope():
            load_mono_full(wav)
    assert decodes == [wav]


def test_a_path_is_resolved_once_inside_the_scope_and_every_time_outside(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.util import workspace_paths

    calls: list[str] = []
    real = workspace_paths._resolve_within

    def counting(root: Path, stored: str, base: Path | None) -> Path:
        calls.append(stored)
        return real(root, stored, base)

    monkeypatch.setattr(workspace_paths, "_resolve_within", counting)
    (tmp_path / "a.wav").write_bytes(b"x")

    first = workspace_paths.resolve_within(tmp_path, "a.wav")
    assert workspace_paths.resolve_within(tmp_path, "a.wav") == first
    assert calls == ["a.wav", "a.wav"]

    calls.clear()
    with batch_scope():
        workspace_paths.resolve_within(tmp_path, "a.wav")
        workspace_paths.resolve_within(tmp_path, "a.wav")
        workspace_paths.resolve_within(tmp_path, "b.wav")
    assert calls == ["a.wav", "b.wav"]


def test_an_escaping_path_is_refused_inside_the_scope_too(tmp_path: Path) -> None:
    from podcast_mcp.util.workspace_paths import resolve_within

    with batch_scope(), pytest.raises(ValueError, match="escapes"):
        resolve_within(tmp_path, "../outside.wav")
