from __future__ import annotations

from podcast_mcp.models import load_project
from podcast_mcp.services.session_control import SessionControlService
from podcast_mcp.services.session_state import (
    publish_agent_play,
    publish_viewer_snapshot,
    read_session_state,
    session_meta,
    session_state_path,
)
from podcast_mcp.services.session_sync.service import SessionSyncService
from podcast_mcp.services.workspace import ProjectWorkspace


def test_publish_agent_play_bumps_revision(minimal_project) -> None:
    proj = load_project(minimal_project)
    s1 = publish_agent_play(
        proj,
        timeline_start_sec=10.0,
        timeline_end_sec=20.0,
        source="premix",
        tier="premix",
        dry_run=True,
        query="party",
    )
    assert s1["revision"] == 1
    assert s1["origin"] == "agent"
    assert s1["command_id"]
    assert s1["region"] == {"start_sec": 10.0, "end_sec": 20.0}
    assert s1["query"] == "party"
    assert s1["audition_mode"] == "mix"
    # dry_run: DAW browser should play (no OS audio)
    assert s1["is_playing"] is True
    assert session_state_path(proj).is_file()

    s2 = publish_agent_play(
        proj,
        timeline_start_sec=30.0,
        timeline_end_sec=40.0,
        source="processed:host",
        tier="stem",
        dry_run=False,
    )
    assert s2["revision"] == 2
    assert s2["command_id"] != s1["command_id"]
    assert s2["audition_mode"] == "fx"
    assert s2["track_id"] == "host"
    assert s2["solo_tracks"] == {"host": True}
    # Real OS play: seek/highlight only - do not double with browser audio
    assert s2["is_playing"] is False


def test_viewer_snapshot_merge(minimal_project) -> None:
    proj = load_project(minimal_project)
    agent = publish_agent_play(
        proj,
        timeline_start_sec=1.0,
        timeline_end_sec=2.0,
        source="premix",
        tier="premix",
        dry_run=True,
    )
    assert agent["region"] == {"start_sec": 1.0, "end_sec": 2.0}
    # While playing, viewer playhead is presence-only (no SetPlayhead journal).
    out = publish_viewer_snapshot(
        proj,
        {
            "playhead_sec": 1.5,
            "client_id": "viewer-test",
            "ack_command_id": agent["command_id"],
        },
    )
    assert out["region"] == {"start_sec": 1.0, "end_sec": 2.0}
    clients = {c["client_id"]: c for c in (out.get("clients") or [])}
    assert clients["viewer-test"]["playhead_sec"] == 1.5
    # Durable playhead stays at agent region start until paused scrub.
    assert out["playhead_sec"] == 1.0


def test_session_meta_missing_and_present(minimal_project) -> None:
    meta = session_meta(minimal_project)
    assert meta["exists"] is False
    proj = load_project(minimal_project)
    publish_agent_play(
        proj,
        timeline_start_sec=0.0,
        timeline_end_sec=1.0,
        source="premix",
        tier="premix",
        dry_run=True,
    )
    meta2 = session_meta(minimal_project)
    assert meta2["exists"] is True
    assert meta2["mtime_ns"] > 0


def test_session_control_seek_stop_mode(minimal_project) -> None:
    import pytest

    from podcast_mcp.services.session_state import audition_mode_from_source
    from podcast_mcp.services.session_sync.commands import SyncCommand
    from podcast_mcp.services.session_sync.service import SessionSyncService

    assert audition_mode_from_source(None) == "mix"
    assert audition_mode_from_source("follow-transcript:processed:host") == "fx"

    ws = ProjectWorkspace.open(minimal_project)
    svc = SessionControlService(ws)
    sync = SessionSyncService(ws.project)
    assert svc.get_state() is None
    seeked = svc.seek(12.5, selection={"kind": "clip", "id": "c1"})
    assert seeked["playhead_sec"] == 12.5
    assert seeked["selection"]["id"] == "c1"
    roster = svc.presence()
    assert any(c.get("role") == "agent" for c in roster)
    assert any(c.get("display_name") == "Agent" for c in roster)
    assert all("ui" in c for c in roster)
    sync.submit(
        SyncCommand(
            type="PresenceHeartbeat",
            payload={"label": "CLI", "meta": {"display_name": "CLI"}},
            client_id="cli-1",
            role="cli",
            client_seq=1,
        )
    )
    sync.submit(
        SyncCommand(
            type="PresenceHeartbeat",
            payload={"label": "G", "meta": {"display_name": "G"}},
            client_id="guest-xxxx-tab",
            role="viewer",
            client_seq=1,
        )
    )
    sync.submit(
        SyncCommand(
            type="PresenceHeartbeat",
            payload={"label": "Host", "meta": {"display_name": "Host"}},
            client_id="viewer-host",
            role="viewer",
            client_seq=1,
        )
    )
    ordered = [c["client_id"] for c in svc.presence()]
    assert ordered.index("viewer-host") < ordered.index("cli-1")
    assert ordered.index("cli-1") < ordered.index("guest-xxxx-tab")
    selected = svc.set_selection({"kind": "clip", "id": "c1"})
    assert selected["selection"]["id"] == "c1"
    assert seeked["origin"] == "agent"
    with pytest.raises(ValueError, match="playhead_sec"):
        svc.seek(-1.0)
    playing = svc.set_playing(True)
    assert playing["is_playing"] is True
    mode = svc.set_mode("fx")
    assert mode["audition_mode"] == "fx"
    with pytest.raises(ValueError, match="mode"):
        svc.set_mode("nope")
    region = svc.set_region(
        10.0,
        15.0,
        playing=True,
        query="x",
        selection={"kind": "clip", "id": "c1"},
    )
    assert region["is_playing"] is True
    assert region["query"] == "x"
    with pytest.raises(ValueError, match="end_sec"):
        svc.set_region(5.0, 5.0)
    cleared = sync.submit_control("ClearRegion", {"stop": False})["snapshot"]
    assert cleared["region"] is None
    solo = sync.submit_control("SetMuteSolo", {"solo_tracks": {"host": True}})["snapshot"]
    assert solo["solo_tracks"] == {"host": True}
    mute = sync.submit_control("SetMuteSolo", {"viewer_mute": {"host": True}})["snapshot"]
    assert mute["viewer_mute"] == {"host": True}
    stopped = svc.stop()
    assert stopped["is_playing"] is False
    assert stopped["region"] is None
    opened = SessionControlService(ProjectWorkspace.open(minimal_project))
    assert opened.get_state() is not None


def test_track_id_and_mode_helpers(minimal_project) -> None:
    from podcast_mcp.services.session_state import (
        audition_mode_from_source,
        publish_agent_control,
        track_id_from_source,
    )

    assert track_id_from_source("") is None
    assert track_id_from_source("track:host") == "host"
    assert track_id_from_source("follow-transcript:processed:olga") == "olga"
    assert audition_mode_from_source("track:host") == "raw"

    proj = load_project(minimal_project)
    SessionSyncService(proj).submit_control("SetPlayhead", {"playhead_sec": 1.0})
    viewer = publish_viewer_snapshot(
        proj, {"playhead_sec": 2.0, "client_id": "v1", "ack_command_id": None}
    )
    assert viewer["playhead_sec"] == 2.0
    assert viewer["server_seq"] >= 1

    assert publish_agent_control(proj, {"playhead_sec": 3.0})["playhead_sec"] == 3.0
    assert publish_agent_control(proj, {"is_playing": True})["is_playing"] is True
    assert (
        publish_agent_control(proj, {"audition_mode": "fx", "source": "processed"})["audition_mode"]
        == "fx"
    )
    cleared = publish_agent_control(proj, {"region": None, "is_playing": False})
    assert cleared["region"] is None
    assert cleared["is_playing"] is False
    # Clear region without is_playing key
    publish_agent_control(proj, {"region": {"start_sec": 0.0, "end_sec": 1.0}})
    only_clear = publish_agent_control(proj, {"region": None})
    assert only_clear["region"] is None
    regioned = publish_agent_control(
        proj,
        {
            "region": {"start_sec": 1.0, "end_sec": 2.0},
            "playhead_sec": 1.0,
            "is_playing": True,
            "query": "hi",
        },
    )
    assert regioned["region"]["end_sec"] == 2.0
    assert regioned["query"] == "hi"
    muted = publish_agent_control(
        proj, {"solo_tracks": {"host": True}, "viewer_mute": {"guest": True}}
    )
    assert muted["solo_tracks"] == {"host": True}
    assert muted["viewer_mute"] == {"guest": True}
    # Fallback: playhead with extra ignored keys
    assert publish_agent_control(proj, {"playhead_sec": 7.0, "tier": "x"})["playhead_sec"] == 7.0
    # Empty patch returns current snapshot
    assert publish_agent_control(proj, {})["playhead_sec"] == 7.0


def test_read_empty_authority_returns_none(minimal_project) -> None:
    from podcast_mcp.services.session_sync.snapshot import empty_snapshot

    proj = load_project(minimal_project)
    svc = SessionSyncService(proj)
    svc.store.put_snapshot(0, empty_snapshot())
    assert read_session_state(proj) is None


def test_viewer_snapshot_field_commands(minimal_project) -> None:
    proj = load_project(minimal_project)
    agent = publish_agent_play(
        proj,
        timeline_start_sec=1.0,
        timeline_end_sec=2.0,
        source="premix",
        tier="premix",
        dry_run=True,
    )
    out = publish_viewer_snapshot(
        proj,
        {
            "client_id": "v-fields",
            "ack_command_id": agent["command_id"],
            "selection": {"kind": "track", "track_id": "host"},
            "viewer_mute": {"host": True},
            "solo_tracks": {},
            "audition_mode": "raw",
            "source": "track:host",
            "playhead_sec": 1.25,
            "is_playing": False,
            "region": None,
        },
    )
    assert out["selection"]["track_id"] == "host"
    assert out["viewer_mute"] == {"host": True}
    assert out["audition_mode"] == "raw"
    assert out["playhead_sec"] == 1.25
    assert out["is_playing"] is False
    assert out["region"] is None
