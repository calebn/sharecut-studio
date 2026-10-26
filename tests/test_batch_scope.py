"""A batch of edits decodes each stem once: Approve all must not redo the ffmpeg pass per edit."""

from __future__ import annotations

import threading
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import ffmpeg
from podcast_mcp.engines.ungated_audio import load_mono_full
from podcast_mcp.util.batch_scope import batch_scope, scoped_by_file, shared_while_batching
from podcast_mcp.util.binaries import FFmpegPair


@pytest.fixture
def decodes(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    seen: list[Path] = []

    def fake(
        self: ffmpeg.FFmpegEngine, path: Path, *, sample_rate: int, layout: list[str]
    ) -> np.ndarray:
        seen.append(path)
        return np.zeros(4, dtype=np.float32)

    monkeypatch.setattr(
        ffmpeg,
        "resolve_ffmpeg_pair",
        lambda *args, **kwargs: FFmpegPair(
            "/admitted/ffmpeg", "/admitted/ffprobe", (9, 0, 2), "explicit"
        ),
    )
    monkeypatch.setattr(ffmpeg.FFmpegEngine, "decode_full_f32", fake)
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


def test_resolve_within_key_includes_root_and_base(tmp_path: Path) -> None:
    from podcast_mcp.util.workspace_paths import resolve_within

    (tmp_path / "x").mkdir()
    (tmp_path / "y").mkdir()
    with batch_scope():
        a = resolve_within(tmp_path, "f.wav", base=tmp_path / "x")
        b = resolve_within(tmp_path, "f.wav", base=tmp_path / "y")
        assert a != b
        with pytest.raises(ValueError, match="escapes"):
            resolve_within(tmp_path, "../o.wav")
        with pytest.raises(ValueError, match="escapes"):
            resolve_within(tmp_path, "../o.wav")


def test_scoped_by_file_key_includes_extra(tmp_path: Path) -> None:
    f = tmp_path / "a.wav"
    f.write_bytes(b"x")
    with batch_scope():
        one = scoped_by_file("k", f, (16000, "ffmpeg", ("mono",)), lambda: object())
        two = scoped_by_file("k", f, (48000, "ffmpeg", ("mono",)), lambda: object())
        again = scoped_by_file("k", f, (16000, "ffmpeg", ("mono",)), lambda: object())
    assert one is again
    assert one is not two


def test_two_batches_at_once_share_a_value_and_the_last_to_end_frees_it() -> None:
    made: list[int] = []

    def make() -> int:
        made.append(1)
        return len(made)

    assert shared_while_batching("k", make) == 1 and len(made) == 1  # no scope: not kept
    with batch_scope():
        first = shared_while_batching("k", make)
        seen: list[int] = []

        def other() -> None:
            with batch_scope():
                seen.append(shared_while_batching("k", make))

        thread = threading.Thread(target=other)
        thread.start()
        thread.join()
        assert seen == [first]
    with batch_scope():
        assert shared_while_batching("k", make) != first
