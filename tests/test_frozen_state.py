"""A cut's read-only proof fingerprints each track once; a mutation is never read through (#1554)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import play_audit
from podcast_mcp.util.batch_scope import frozen, frozen_state


def test_frozen_shares_a_result_only_inside_the_block() -> None:
    calls: list[int] = []

    def make() -> int:
        calls.append(1)
        return len(calls)

    assert frozen("k", make) == 1
    assert frozen("k", make) == 2
    with frozen_state():
        assert frozen("k", make) == 3
        assert frozen("k", make) == 3
        assert frozen("other", make) == 4
    assert frozen("k", make) == 5


def test_a_nested_block_shares_the_outer_one() -> None:
    calls: list[int] = []
    with frozen_state():
        frozen("k", lambda: calls.append(1))
        with frozen_state():
            frozen("k", lambda: calls.append(1))
    assert calls == [1]


def test_render_hash_is_read_once_per_track_in_the_block_and_again_after(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = SimpleNamespace()
    seen: list[str] = []

    def fake(_project: object, track_id: str, **_kw) -> str:
        seen.append(track_id)
        return f"hash-{len(seen)}"

    monkeypatch.setattr(play_audit, "_track_render_hash", fake)

    with frozen_state():
        first = play_audit.track_render_hash(project, "a", defaults=load_defaults())  # type: ignore[arg-type]
        again = play_audit.track_render_hash(project, "a", defaults=load_defaults())  # type: ignore[arg-type]
        other = play_audit.track_render_hash(project, "b", defaults=load_defaults())  # type: ignore[arg-type]
    after = play_audit.track_render_hash(project, "a", defaults=load_defaults())  # type: ignore[arg-type]

    assert first == again == "hash-1"
    assert other == "hash-2"
    assert after == "hash-3"
    assert seen == ["a", "b", "a"]
