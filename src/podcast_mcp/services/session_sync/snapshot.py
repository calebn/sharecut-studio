"""Per-field LWW materialization from typed commands."""

from __future__ import annotations

import time
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


def apply_command(snap: dict[str, Any], cmd: dict[str, Any]) -> dict[str, Any]:
    """Apply one logged command onto a snapshot (mutates and returns snap)."""
    ctype = cmd["type"]
    payload = cmd.get("payload") or {}
    server_seq = int(cmd["server_seq"])
    client_id = cmd["client_id"]
    role = cmd["role"]

    def set_f(key: str, value: Any) -> None:
        _set_field(snap, key, value, server_seq=server_seq, client_id=client_id)

    if ctype == "Ack" or ctype == "PresenceHeartbeat":
        # Presence handled by store; no transport field changes required.
        pass
    elif ctype == "SetPlayhead":
        sec = normalize_presence_playhead(payload["playhead_sec"])
        if sec is not None:
            set_f("playhead_sec", sec)
        if "selection" in payload:
            set_f("selection", payload.get("selection"))
    elif ctype == "SetPlaying":
        set_f("is_playing", bool(payload["is_playing"]))
    elif ctype == "SetMode":
        mode = payload["audition_mode"]
        set_f("audition_mode", mode)
        if "source" in payload:
            set_f("source", payload["source"])
        else:
            set_f(
                "source",
                {"mix": "premix", "fx": "processed", "raw": "track"}.get(mode),
            )
    elif ctype == "SetRegion":
        region = {
            "start_sec": float(payload["start_sec"]),
            "end_sec": float(payload["end_sec"]),
        }
        set_f("region", region)
        set_f("playhead_sec", float(payload.get("playhead_sec", region["start_sec"])))
        if "is_playing" in payload:
            set_f("is_playing", bool(payload["is_playing"]))
        if "query" in payload:
            set_f("query", payload["query"])
        if "selection" in payload:
            set_f("selection", payload.get("selection"))
    elif ctype == "ClearRegion":
        set_f("region", None)
        if payload.get("stop"):
            set_f("is_playing", False)
    elif ctype == "SetSelection":
        set_f("selection", payload.get("selection"))
    elif ctype == "SetMuteSolo":
        if "viewer_mute" in payload:
            set_f("viewer_mute", dict(payload["viewer_mute"] or {}))
        if "solo_tracks" in payload:
            set_f("solo_tracks", dict(payload["solo_tracks"] or {}))
    elif ctype == "PlayOsAudio":
        # Speakers play OS audio - DAW seeks/highlights only.
        start = float(payload["timeline_start_sec"])
        end = float(payload["timeline_end_sec"])
        source = payload.get("source")
        set_f("playhead_sec", start)
        set_f("is_playing", False)
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
        set_f("dry_run", False)
        # Host play resolves wav locally from source/region; never persist paths.
        set_f("wav", None)
        set_f("compare_segments", None)
        if "selection" in payload:
            set_f("selection", payload.get("selection"))
    elif ctype == "AuditionInViewer":
        start = float(payload["timeline_start_sec"])
        end = float(payload["timeline_end_sec"])
        source = payload.get("source")
        set_f("playhead_sec", start)
        set_f("is_playing", True)
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
        set_f("dry_run", True)
        set_f("wav", None)
        set_f("compare_segments", None)
        if "selection" in payload:
            set_f("selection", payload.get("selection"))
    else:
        # Unknown - ignore for forward compatibility
        pass

    snap["server_seq"] = server_seq
    snap["updated_at_ns"] = int(cmd.get("ts_ns") or time.time_ns())
    snap["last_command_id"] = cmd["command_id"]
    snap["last_client_id"] = client_id
    snap["last_role"] = role
    snap["origin"] = role if role in ("agent", "viewer") else "agent"
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
