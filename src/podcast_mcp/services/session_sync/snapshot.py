"""Per-field LWW materialization from typed commands."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from podcast_mcp.services.session_sync.commands import (
    TRANSPORT_FIELDS,
    audition_mode_from_source,
    normalize_presence_playhead,
    track_id_from_source,
)

SNAPSHOT_VERSION = 3


def empty_snapshot() -> dict[str, Any]:
    return {
        "version": SNAPSHOT_VERSION,
        "server_seq": 0,
        "updated_at_ns": 0,
        "last_command_id": None,
        "last_client_id": None,
        "last_role": None,
        "fields": {},
        # Flattened convenience view (same keys as legacy session_state)
        "playhead_sec": 0.0,
        "is_playing": False,
        "audition_mode": "mix",
        "region": None,
        "source": None,
        "track_id": None,
        "query": None,
        "match_index": None,
        "selection": None,
        "viewer_mute": {},
        "solo_tracks": {},
        "tier": None,
        "dry_run": False,
        "wav": None,
        "compare_segments": None,
        "clients": [],
        "origin": "viewer",
    }


def _set_field(
    snap: dict[str, Any],
    key: str,
    value: Any,
    *,
    server_seq: int,
    client_id: str,
) -> None:
    fields: dict[str, Any] = snap.setdefault("fields", {})
    fields[key] = {
        "value": value,
        "server_seq": server_seq,
        "client_id": client_id,
    }
    snap[key] = value


def _set_playhead(payload: dict[str, Any], set_f: Callable[[str, Any], None]) -> None:
    sec = normalize_presence_playhead(payload["playhead_sec"])
    if sec is not None:
        set_f("playhead_sec", sec)
    if "selection" in payload:
        set_f("selection", payload.get("selection"))


def _set_playing(payload: dict[str, Any], set_f: Callable[[str, Any], None]) -> None:
    set_f("is_playing", bool(payload["is_playing"]))


def _set_mode(payload: dict[str, Any], set_f: Callable[[str, Any], None]) -> None:
    mode = payload["audition_mode"]
    set_f("audition_mode", mode)
    if "source" in payload:
        set_f("source", payload["source"])
    else:
        set_f(
            "source",
            {"mix": "premix", "fx": "processed", "raw": "track"}.get(mode),
        )


def _set_region(payload: dict[str, Any], set_f: Callable[[str, Any], None]) -> None:
    region = {
        "start_sec": float(payload["start_sec"]),
        "end_sec": float(payload["end_sec"]),
    }
    set_f("region", region)
    sec = normalize_presence_playhead(payload.get("playhead_sec", region["start_sec"]))
    if sec is not None:
        set_f("playhead_sec", sec)
    if "is_playing" in payload:
        set_f("is_playing", bool(payload["is_playing"]))
    if "query" in payload:
        set_f("query", payload["query"])
    if "selection" in payload:
        set_f("selection", payload.get("selection"))


def _clear_region(payload: dict[str, Any], set_f: Callable[[str, Any], None]) -> None:
    set_f("region", None)
    if payload.get("stop"):
        set_f("is_playing", False)


def _set_selection(payload: dict[str, Any], set_f: Callable[[str, Any], None]) -> None:
    set_f("selection", payload.get("selection"))


def _set_mute_solo(payload: dict[str, Any], set_f: Callable[[str, Any], None]) -> None:
    if "viewer_mute" in payload:
        set_f("viewer_mute", dict(payload["viewer_mute"] or {}))
    if "solo_tracks" in payload:
        set_f("solo_tracks", dict(payload["solo_tracks"] or {}))


def _play_os_audio(payload: dict[str, Any], set_f: Callable[[str, Any], None]) -> None:
    # Speakers play OS audio - DAW seeks/highlights only.
    _materialize_playback(payload, set_f, is_playing=False, dry_run=False)


def _materialize_playback(
    payload: dict[str, Any],
    set_f: Callable[[str, Any], None],
    *,
    is_playing: bool,
    dry_run: bool,
) -> None:
    """Apply shared playback fields in their stable command sequence."""
    start = float(payload["timeline_start_sec"])
    end = float(payload["timeline_end_sec"])
    source = payload.get("source")
    set_f("playhead_sec", start)
    set_f("is_playing", is_playing)
    set_f("region", {"start_sec": start, "end_sec": end})
    set_f("source", source)
    set_f("audition_mode", audition_mode_from_source(source))
    tid = payload.get("track_id") or track_id_from_source(source)
    set_f("track_id", tid)
    set_f("solo_tracks", {tid: True} if tid else {})
    set_f("viewer_mute", {})
    set_f("query", payload.get("query"))
    set_f("match_index", payload.get("match_index"))
    set_f("tier", payload.get("tier"))
    set_f("dry_run", dry_run)
    # Host play resolves wav locally from source/region; never persist paths.
    set_f("wav", None)
    set_f("compare_segments", None)
    if "selection" in payload:
        set_f("selection", payload.get("selection"))


def _audition_in_viewer(payload: dict[str, Any], set_f: Callable[[str, Any], None]) -> None:
    _materialize_playback(payload, set_f, is_playing=True, dry_run=True)


_COMMAND_HANDLERS: dict[str, Callable[[dict[str, Any], Callable[[str, Any], None]], None]] = {
    "SetPlayhead": _set_playhead,
    "SetPlaying": _set_playing,
    "SetMode": _set_mode,
    "SetRegion": _set_region,
    "ClearRegion": _clear_region,
    "SetSelection": _set_selection,
    "SetMuteSolo": _set_mute_solo,
    "PlayOsAudio": _play_os_audio,
    "AuditionInViewer": _audition_in_viewer,
}


def attribution_fields(row: dict[str, Any]) -> dict[str, Any]:
    """Last-writer fields naming journal/command ``row``: ``last_command_id``,
    ``last_client_id``, ``last_role`` and ``origin`` (``agent``/``viewer``; any other role
    maps to ``agent``). Shared by ``apply_command`` and the cross-process publish (#695).
    """
    role = row["role"]
    return {
        "last_command_id": row["command_id"],
        "last_client_id": row["client_id"],
        "last_role": role,
        "origin": role if role in ("agent", "viewer") else "agent",
    }


def apply_command(snap: dict[str, Any], cmd: dict[str, Any]) -> dict[str, Any]:
    """Apply one logged command onto a snapshot (mutates and returns snap)."""
    ctype = cmd["type"]
    payload = cmd.get("payload") or {}
    server_seq = int(cmd["server_seq"])
    client_id = cmd["client_id"]

    def set_f(key: str, value: Any) -> None:
        _set_field(snap, key, value, server_seq=server_seq, client_id=client_id)

    handler = _COMMAND_HANDLERS.get(ctype)
    if handler is not None:
        handler(payload, set_f)

    snap["server_seq"] = server_seq
    snap["updated_at_ns"] = int(cmd.get("ts_ns") or time.time_ns())
    snap.update(attribution_fields(cmd))
    snap["version"] = SNAPSHOT_VERSION
    # Ensure all transport keys exist
    for key in TRANSPORT_FIELDS:
        snap.setdefault(key, empty_snapshot().get(key))
    return snap


def flatten_for_api(snap: dict[str, Any], clients: list[dict[str, Any]]) -> dict[str, Any]:
    out = dict(snap)
    out["clients"] = clients
    out["available"] = True
    return out
