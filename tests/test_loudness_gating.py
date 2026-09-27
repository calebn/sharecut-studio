from __future__ import annotations

from podcast_mcp.util.loudness import (
    MIN_SPEECH_BLOCKS,
    integrated_lufs_from_blocks,
    speech_blocks,
    speech_gated_lufs,
)


def _blocks(value: float, start: float, count: int) -> list[tuple[float, float]]:
    return [(round(start + 0.1 * i, 3), value) for i in range(count)]


def test_constant_blocks_integrate_to_their_level() -> None:
    assert integrated_lufs_from_blocks([-23.0] * 20) == -23.0


def test_absolute_gate_drops_silence() -> None:
    assert integrated_lufs_from_blocks([-120.7] * 5 + [-23.0] * 5) == -23.0
    assert integrated_lufs_from_blocks([-120.7] * 5) is None
    assert integrated_lufs_from_blocks([]) is None


def test_relative_gate_drops_quiet_blocks() -> None:
    assert integrated_lufs_from_blocks([-20.0] * 50 + [-35.0] * 50) == -20.0


def test_speech_blocks_use_the_window_centre() -> None:
    # t=1.2 -> centre 1.0, inside (1.0, 1.5); t=1.0 -> centre 0.8, outside.
    assert speech_blocks([(1.2, -20.0), (1.0, -30.0), (1.8, -40.0)], [(1.0, 1.5)]) == [-20.0]


def test_speech_blocks_handle_unmerged_overlaps() -> None:
    assert speech_blocks([(1.5, -20.0)], [(0.0, 3.0), (1.0, 1.2)]) == [-20.0]


def test_bleed_outside_speech_is_excluded() -> None:
    blocks = _blocks(-20.0, 1.2, 60) + _blocks(-28.0, 20.0, 200)
    got = speech_gated_lufs(blocks, [(1.0, 7.0)])
    assert got.speech_gated is True
    assert got.lufs == -20.0
    ungated = integrated_lufs_from_blocks([m for _t, m in blocks])
    assert ungated is not None and ungated < -20.0


def test_too_little_speech_falls_back_to_ungated() -> None:
    blocks = _blocks(-20.0, 1.2, MIN_SPEECH_BLOCKS - 1) + _blocks(-30.0, 20.0, 50)
    got = speech_gated_lufs(blocks, [(1.0, 1.0 + 0.1 * (MIN_SPEECH_BLOCKS - 1))])
    assert got.speech_gated is False
    assert got.lufs is not None
    assert speech_gated_lufs(blocks, []).speech_gated is False
