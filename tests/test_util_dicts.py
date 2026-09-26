from __future__ import annotations

from podcast_mcp.util.dicts import deep_merge


def test_deep_merge_nested_keeps_siblings() -> None:
    out = deep_merge({"a": {"x": 1, "y": 2}, "b": 1}, {"a": {"x": 9}})
    assert out == {"a": {"x": 9, "y": 2}, "b": 1}


def test_deep_merge_skips_underscore_keys() -> None:
    assert deep_merge({"a": 1}, {"_note": "x", "b": 2}) == {"a": 1, "b": 2}


def test_deep_merge_does_not_alias_override() -> None:
    override = {"items": [1]}
    out = deep_merge({}, override)
    out["items"].append(2)
    assert override["items"] == [1]
