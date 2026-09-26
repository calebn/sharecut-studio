"""Agent/CLI control of the DAW session via SessionSyncService."""

from __future__ import annotations

from typing import Any

from podcast_mcp.services.session_sync.commands import normalize_presence_playhead
from podcast_mcp.services.session_sync.service import SessionSyncService
from podcast_mcp.services.workspace import ProjectWorkspace

_VALID_MODES = frozenset({"mix", "fx", "raw"})


class SessionControlService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.workspace = workspace
        self.project = workspace.project
        self._sync = SessionSyncService(workspace.project)

    def get_state(self) -> dict[str, Any] | None:
        return self._sync.state_or_none()

    def seek(
        self,
        playhead_sec: float,
        *,
        selection: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        sec = normalize_presence_playhead(playhead_sec)
        if sec is None:
            raise ValueError("playhead_sec must be a finite number >= 0")
        payload: dict[str, Any] = {"playhead_sec": sec}
        if selection is not None:
            payload["selection"] = selection
        return self._sync.submit_control("SetPlayhead", payload)["snapshot"]

    def set_selection(self, selection: dict[str, Any] | None) -> dict[str, Any]:
        return self._sync.submit_control("SetSelection", {"selection": selection})["snapshot"]

    def set_playing(self, playing: bool) -> dict[str, Any]:
        return self._sync.submit_control("SetPlaying", {"is_playing": bool(playing)})["snapshot"]

    def stop(self) -> dict[str, Any]:
        self._sync.submit_control("ClearRegion", {"stop": True})
        return self._sync.submit_control("SetPlaying", {"is_playing": False})["snapshot"]

    def set_mode(self, mode: str) -> dict[str, Any]:
        if mode not in _VALID_MODES:
            raise ValueError(f"mode must be one of {sorted(_VALID_MODES)}")
        source = {"mix": "premix", "fx": "processed", "raw": "track"}.get(mode)
        return self._sync.submit_control("SetMode", {"audition_mode": mode, "source": source})[
            "snapshot"
        ]

    def set_region(
        self,
        start_sec: float,
        end_sec: float,
        *,
        playing: bool = False,
        query: str | None = None,
        selection: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        start = normalize_presence_playhead(start_sec)
        end = normalize_presence_playhead(end_sec)
        if start is None or end is None:
            raise ValueError("start_sec and end_sec must be finite numbers >= 0")
        if end <= start:
            raise ValueError("end_sec must be after start_sec")
        payload: dict[str, Any] = {
            "start_sec": start,
            "end_sec": end,
            "playhead_sec": start,
            "is_playing": bool(playing),
            "query": query,
        }
        if selection is not None:
            payload["selection"] = selection
        return self._sync.submit_control("SetRegion", payload)["snapshot"]

    def presence(self) -> list[dict[str, Any]]:
        """Flattened live roster for agents (ephemeral; never journaled)."""
        snap = self._sync.snapshot()
        clients = list(snap.get("clients") or [])

        def sort_key(row: dict[str, Any]) -> tuple[int, str]:
            role = str(row.get("role") or "")
            cid = str(row.get("client_id") or "")
            if role == "agent":
                pri = 0
            elif role == "viewer" and not cid.startswith("guest-"):
                pri = 1
            elif role == "cli":
                pri = 2
            else:
                pri = 3
            return (pri, cid)

        out: list[dict[str, Any]] = []
        for row in sorted(clients, key=sort_key):
            meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
            out.append(
                {
                    "client_id": row.get("client_id"),
                    "role": row.get("role"),
                    "display_name": meta.get("display_name") or row.get("label"),
                    "color_index": meta.get("color_index"),
                    "cursor": meta.get("cursor"),
                    "selection": meta.get("selection"),
                    "viewport": meta.get("viewport"),
                    "transport": meta.get("transport"),
                    "following": meta.get("following"),
                    "ui": meta.get("ui"),
                    "followers": row.get("followers", 0),
                    "last_seen_ns": row.get("last_seen_ns"),
                }
            )
        return out
