"""PIN the wire output of the session-suggestion hear path (#1811, refactor step 0).

These tests freeze the exact dict ``SessionSuggestionService.preview`` and ``cached_preview``
return (key set, key ORDER, value types and values), the ``current``/``suggested`` side
sub-dicts, and what the GUI route, the MCP tool and the CLI print from it. A behavior-preserving
refactor must keep every assertion here green without editing it. WAV paths are normalised to
play-cache-relative names with the content digest replaced by ``<h>``.
"""

# ruff: noqa: F811
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.mcp.tools.review import hear_session_suggestion_tool
from test_record_replace_accept import _words
from test_record_session_preview import (  # noqa: F401  (ws is a fixture)
    CLI,
    _insert,
    _replace,
    _svc,
    ws,
)

pytestmark = pytest.mark.unscoped_ok

SID = "ss-aaaaaaaaaaaa"
KEYS = [
    "suggestion_id",
    "kind",
    "mode",
    "take_index",
    "pad_sec",
    "wav",
    "player",
    "current",
    "suggested",
    "delta_s",
    "removed_s",
    "span_s",
    "speech",
    "speech_message",
]
CURRENT_KEYS = ["wav", "start_s", "end_s"]
SUGGESTED_KEYS = ["wav", "start_s", "end_s", "delta_s"]
TYPES = {
    "suggestion_id": str,
    "kind": str,
    "mode": str,
    "pad_sec": float,
    "wav": str,
}
_DIGEST = re.compile(r"_[0-9a-f]{16}\.wav$")


def _wav(ws, value: str) -> str:
    """A WAV path as ``play_cache/<name>_<h>.wav``, asserting the file is real."""
    path = Path(value)
    assert path.is_file()
    assert path.parent == ws.project.artifacts_dir() / "play_cache"
    assert _DIGEST.search(path.name)
    return "play_cache/" + _DIGEST.sub("_<h>.wav", path.name)


def _norm(ws, heard: dict) -> dict:
    out = dict(heard)
    out["wav"] = _wav(ws, heard["wav"])
    for side in ("current", "suggested"):
        if heard[side] is not None:
            out[side] = {**heard[side], "wav": _wav(ws, heard[side]["wav"])}
    return out


def _pin(ws, heard: dict, expected: dict) -> None:
    assert list(heard) == KEYS
    assert type(heard["pad_sec"]) is float
    for key, kind in TYPES.items():
        assert isinstance(heard[key], kind), key
    for side, keys in (("current", CURRENT_KEYS), ("suggested", SUGGESTED_KEYS)):
        if heard[side] is not None:
            assert list(heard[side]) == keys
            for key in heard[side]:
                if key != "wav":
                    assert type(heard[side][key]) is float, (side, key)
    normal = _norm(ws, heard)
    assert normal == expected
    assert json.dumps(normal, sort_keys=False) == json.dumps(expected, sort_keys=False)


def _replace_expected(mode: str, **over) -> dict:
    base = {
        "suggestion_id": SID,
        "kind": "replace",
        "mode": mode,
        "take_index": 0,
        "pad_sec": 1.5,
        "wav": "play_cache/session_suggested_<h>.wav",
        "player": None,
        "current": None,
        "suggested": {
            "wav": "play_cache/session_suggested_<h>.wav",
            "start_s": 1.5,
            "end_s": 7.5,
            "delta_s": 1.0,
        },
        "delta_s": 1.0,
        "removed_s": 2.0,
        "span_s": 3.0,
        "speech": None,
        "speech_message": None,
    }
    current = {"wav": "play_cache/session_current_<h>.wav", "start_s": 1.5, "end_s": 6.5}
    if mode == "current":
        base.update(
            take_index=None,
            wav=current["wav"],
            current=current,
            suggested=None,
            delta_s=None,
            removed_s=None,
            span_s=None,
        )
    elif mode == "ab":
        base.update(wav="play_cache/ab_concat_<h>.wav", current=current)
    base.update(over)
    return base


def _fresh(ws):
    return _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 3.0)]})


# --- preview: replace ---


@pytest.mark.parametrize("mode", ["current", "suggested", "ab"])
def test_replace_preview_wire(ws, mode) -> None:
    sid = _fresh(ws)
    heard = _svc(ws).preview(sid, mode=mode, take_index=0, dry_run=True).model_dump()
    _pin(ws, heard, _replace_expected(mode))


def test_replace_preview_default_mode_is_ab_and_default_take_is_last(ws) -> None:
    sid = _fresh(ws)
    heard = _svc(ws).preview(sid, dry_run=True).model_dump()
    _pin(ws, heard, _replace_expected("ab"))


def test_replace_take_index_picks_the_take(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 4.0)]})
    first = _svc(ws).preview(sid, mode="suggested", take_index=0, dry_run=True).model_dump()
    second = _svc(ws).preview(sid, mode="suggested", take_index=1, dry_run=True).model_dump()
    _pin(
        ws,
        first,
        _replace_expected(
            "suggested",
            take_index=0,
            delta_s=-1.0,
            span_s=1.0,
            suggested={
                "wav": "play_cache/session_suggested_<h>.wav",
                "start_s": 1.5,
                "end_s": 5.5,
                "delta_s": -1.0,
            },
        ),
    )
    _pin(
        ws,
        second,
        _replace_expected(
            "suggested",
            take_index=1,
            delta_s=2.0,
            span_s=4.0,
            suggested={
                "wav": "play_cache/session_suggested_<h>.wav",
                "start_s": 1.5,
                "end_s": 8.5,
                "delta_s": 2.0,
            },
        ),
    )
    assert first["wav"] != second["wav"]


def test_replace_pad_and_gap(ws) -> None:
    sid = _fresh(ws)
    heard = (
        _svc(ws)
        .preview(sid, mode="ab", take_index=0, pad_sec=0.5, gap_sec=0.1, dry_run=True)
        .model_dump()
    )
    _pin(
        ws,
        heard,
        _replace_expected(
            "ab",
            pad_sec=0.5,
            current={
                "wav": "play_cache/session_current_<h>.wav",
                "start_s": 2.5,
                "end_s": 5.5,
            },
            suggested={
                "wav": "play_cache/session_suggested_<h>.wav",
                "start_s": 2.5,
                "end_s": 6.5,
                "delta_s": 1.0,
            },
        ),
    )


def test_replace_speech_and_message_wire(ws) -> None:
    _words(ws, "guest", ("so", 3.2, 3.5), ("plan", 3.6, 3.9))
    sid = _fresh(ws)
    heard = _svc(ws).preview(sid, mode="suggested", dry_run=True).model_dump()
    assert list(heard) == KEYS
    assert heard["speech"] == {
        "spans": [{"start": 3.0, "end": 5.0}],
        "tracks": [
            {
                "track_id": "guest",
                "speaker": "Guest",
                "words": [
                    {"text": "so", "timeline_start": 3.2, "timeline_end": 3.5},
                    {"text": "plan", "timeline_start": 3.6, "timeline_end": 3.9},
                ],
                "sound_spans": [],
            }
        ],
    }
    assert list(heard["speech"]) == ["spans", "tracks"]
    assert list(heard["speech"]["tracks"][0]) == ["track_id", "speaker", "words", "sound_spans"]
    assert list(heard["speech"]["tracks"][0]["words"][0]) == [
        "text",
        "timeline_start",
        "timeline_end",
    ]
    assert heard["speech_message"] == (
        'Replacing this range also removes 2 words from Guest: "so plan". '
        "Replace anyway to apply it; undo brings it back."
    )


# --- preview: insert ---


def _insert_expected(mode: str, **over) -> dict:
    base = {
        "suggestion_id": SID,
        "kind": "insert",
        "mode": mode,
        "take_index": None,
        "pad_sec": 1.5,
        "wav": "play_cache/session_suggested_<h>.wav",
        "player": None,
        "current": None,
        "suggested": {
            "wav": "play_cache/session_suggested_<h>.wav",
            "start_s": 2.5,
            "end_s": 8.5,
            "delta_s": 3.0,
        },
        "delta_s": 3.0,
        "removed_s": 0.0,
        "span_s": 3.0,
        "speech": None,
        "speech_message": None,
    }
    current = {"wav": "play_cache/session_current_<h>.wav", "start_s": 2.5, "end_s": 5.5}
    if mode == "current":
        base.update(
            wav=current["wav"],
            current=current,
            suggested=None,
            delta_s=None,
            removed_s=None,
            span_s=None,
        )
    elif mode == "ab":
        base.update(wav="play_cache/ab_concat_<h>.wav", current=current)
    base.update(over)
    return base


@pytest.mark.parametrize("mode", ["current", "suggested", "ab"])
def test_insert_preview_wire(ws, mode) -> None:
    sid = _insert(ws, 4.0, [1.0, 2.0])
    heard = _svc(ws).preview(sid, mode=mode, dry_run=True).model_dump()
    _pin(ws, heard, _insert_expected(mode))


def test_insert_pad(ws) -> None:
    sid = _insert(ws, 4.0, [1.0, 2.0])
    heard = _svc(ws).preview(sid, mode="ab", pad_sec=0.5, gap_sec=0.1, dry_run=True).model_dump()
    _pin(
        ws,
        heard,
        _insert_expected(
            "ab",
            pad_sec=0.5,
            current={
                "wav": "play_cache/session_current_<h>.wav",
                "start_s": 3.5,
                "end_s": 4.5,
            },
            suggested={
                "wav": "play_cache/session_suggested_<h>.wav",
                "start_s": 3.5,
                "end_s": 7.5,
                "delta_s": 3.0,
            },
        ),
    )


# --- dry_run / player ---


def test_dry_run_has_no_player_and_a_live_run_names_the_player_command(ws) -> None:
    sid = _fresh(ws)
    dry = _svc(ws).preview(sid, mode="ab", take_index=0, dry_run=True, player="true").model_dump()
    assert dry["player"] is None
    live = _svc(ws).preview(sid, mode="ab", take_index=0, dry_run=False, player="true").model_dump()
    assert list(live) == KEYS
    assert live["player"] == ["true", live["wav"]]
    assert isinstance(live["player"], list)
    assert {k: v for k, v in live.items() if k != "player"} == {
        k: v for k, v in dry.items() if k != "player"
    }
    single = (
        _svc(ws)
        .preview(sid, mode="suggested", take_index=0, dry_run=False, player="true")
        .model_dump()
    )
    assert single["player"] == ["true", single["wav"]]


def test_a_second_preview_returns_the_same_wire(ws) -> None:
    sid = _fresh(ws)
    first = _svc(ws).preview(sid, mode="ab", take_index=0, dry_run=True).model_dump()
    second = _svc(ws).preview(sid, mode="ab", take_index=0, dry_run=True).model_dump()
    assert first == second
    assert list(second) == KEYS


# --- cached_preview ---


@pytest.mark.parametrize("mode", ["current", "suggested", "ab"])
def test_cached_preview_is_none_before_anything_is_rendered(ws, mode) -> None:
    sid = _fresh(ws)
    assert _svc(ws).cached_preview(sid, mode=mode, take_index=0) is None


def test_cached_preview_is_none_for_an_unrendered_side_or_pad(ws) -> None:
    sid = _fresh(ws)
    _svc(ws).preview(sid, mode="current", dry_run=True)
    assert _svc(ws).cached_preview(sid, mode="ab", take_index=0) is None
    assert _svc(ws).cached_preview(sid, mode="suggested", take_index=0) is None
    assert _svc(ws).cached_preview(sid, mode="current", pad_sec=0.25) is None
    assert _svc(ws).cached_preview(sid, mode="current") is not None


@pytest.mark.parametrize("mode", ["current", "suggested", "ab"])
def test_cached_preview_equals_preview_once_rendered(ws, mode) -> None:
    sid = _fresh(ws)
    heard = _svc(ws).preview(sid, mode=mode, take_index=0, dry_run=True).model_dump()
    cached_model = _svc(ws).cached_preview(sid, mode=mode, take_index=0)
    assert cached_model is not None
    cached = cached_model.model_dump()
    assert list(cached) == KEYS
    assert cached == heard
    _pin(ws, cached, _replace_expected(mode))


def test_cached_preview_after_a_live_run_carries_no_player(ws) -> None:
    sid = _fresh(ws)
    _svc(ws).preview(sid, mode="ab", take_index=0, dry_run=False, player="true")
    cached = _svc(ws).cached_preview(sid, mode="ab", take_index=0)
    assert cached is not None
    assert cached.player is None


def test_cached_preview_of_an_insert(ws) -> None:
    sid = _insert(ws, 4.0, [1.0, 2.0])
    assert _svc(ws).cached_preview(sid, mode="ab") is None
    _svc(ws).preview(sid, mode="ab", dry_run=True)
    _pin(ws, _svc(ws).cached_preview(sid, mode="ab").model_dump(), _insert_expected("ab"))


def test_cached_preview_still_refuses_what_preview_refuses(ws) -> None:
    sid = _fresh(ws)
    with pytest.raises(KeyError):
        _svc(ws).cached_preview("ss-nope")
    with pytest.raises(ValueError):
        _svc(ws).cached_preview(sid, mode="ab", pad_sec=11)


# --- surfaces ---


def test_gui_route_json_pops_wav_and_player(ws) -> None:
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    sid = _fresh(ws)
    client = TestClient(create_app())
    for mode in ("current", "suggested", "ab"):
        res = client.get(
            "/api/session-suggestion/hear",
            params={"path": str(ws.path), "suggestion_id": sid, "mode": mode, "take_index": 0},
        )
        assert res.status_code == 200, res.text
        body = res.json()
        want = {k: v for k, v in _replace_expected(mode).items() if k not in ("wav", "player")}
        for side in ("current", "suggested"):
            if want[side] is not None:
                want[side] = {k: v for k, v in want[side].items() if k != "wav"}
        assert body == want
        assert list(body) == [k for k in KEYS if k not in ("wav", "player")]
        for side, keys in (("current", CURRENT_KEYS[1:]), ("suggested", SUGGESTED_KEYS[1:])):
            if body[side] is not None:
                assert list(body[side]) == keys
    # default mode is ab, default pad is 1.5, default take is the last
    default = client.get(
        "/api/session-suggestion/hear", params={"path": str(ws.path), "suggestion_id": sid}
    ).json()
    assert default["mode"] == "ab"
    assert default["take_index"] == 0
    # the second call is served from the cache with the same body
    again = client.get(
        "/api/session-suggestion/hear",
        params={"path": str(ws.path), "suggestion_id": sid, "mode": "ab", "pad_sec": 1.5},
    ).json()
    assert again == default


def test_gui_route_insert_json(ws) -> None:
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    sid = _insert(ws, 4.0, [1.0, 2.0])
    body = (
        TestClient(create_app())
        .get(
            "/api/session-suggestion/hear",
            params={"path": str(ws.path), "suggestion_id": sid, "mode": "ab", "pad_sec": 0.5},
        )
        .json()
    )
    assert list(body) == [k for k in KEYS if k not in ("wav", "player")]
    assert body["kind"] == "insert"
    assert body["take_index"] is None
    assert body["current"] == {"start_s": 3.5, "end_s": 4.5}
    assert body["suggested"] == {"start_s": 3.5, "end_s": 7.5, "delta_s": 3.0}


def test_mcp_tool_returns_the_service_wire_as_json(ws) -> None:
    sid = _fresh(ws)
    text = hear_session_suggestion_tool(str(ws.path), sid, take_index=0, mode="ab", dry_run=True)
    assert isinstance(text, str)
    payload = json.loads(text)
    assert list(payload) == KEYS
    _pin(ws, payload, _replace_expected("ab"))
    assert payload == json.loads(
        json.dumps(_svc(ws).preview(sid, mode="ab", take_index=0, dry_run=True).model_dump())
    )
    one = json.loads(
        hear_session_suggestion_tool(
            str(ws.path),
            sid,
            take_index=0,
            mode="suggested",
            pad_sec=1.5,
            gap_sec=0.4,
            dry_run=True,
        )
    )
    _pin(ws, one, _replace_expected("suggested"))


def test_cli_review_preview_output(ws) -> None:
    sid = _fresh(ws)
    ran = CLI.invoke(
        cli_app,
        [
            "review",
            "preview-session-suggestion",
            "--project",
            str(ws.path),
            "--id",
            sid,
            "--take",
            "0",
            "--mode",
            "ab",
            "--dry-run",
        ],
    )
    assert ran.exit_code == 0, ran.output
    assert ran.output.startswith('{\n  "suggestion_id": "' + SID + '",\n  "kind": "replace",\n')
    payload = json.loads(ran.output)
    assert list(payload) == KEYS
    _pin(ws, payload, _replace_expected("ab"))
    again = _svc(ws).preview(sid, mode="ab", take_index=0, dry_run=True).model_dump()
    assert ran.output == json.dumps(again, indent=2) + "\n"
