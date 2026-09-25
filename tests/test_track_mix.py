"""Saved track mix state (#386): the volume fader and the mix mute.

The fader sits on top of the pipeline's staging gain (output = gain_db +
fader_db), balance never touches it, and it's applied at mix time, so a
volume or mute change stales the premix without staling any stem. Both are
listening choices: edits, the audio audit and render caches ignore them.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.config import load_defaults
from podcast_mcp.edits.timeline_ops import ripple_delete
from podcast_mcp.engines.audio_audit import TrackRmsCacheSet, _rms_for_track_at_timeline
from podcast_mcp.engines.play_audit import (
    mix_gains,
    mix_render_hash,
    premix_hash_path,
    premix_path,
    premix_stale_vs_mix,
    read_premix_hash,
    track_render_hash,
    write_premix_hash,
)
from podcast_mcp.engines.reconciliation_state import audio_state_fingerprint
from podcast_mcp.engines.render_status import render_status_report
from podcast_mcp.history.summary import format_history_group_title
from podcast_mcp.mcp.server import track_set_mute_tool, track_set_volume_tool
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.models.episode import FADER_MAX_DB, FADER_MIN_DB
from podcast_mcp.pipeline import steps
from podcast_mcp.services import EpisodeService, ProjectWorkspace
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.capabilities import authorize_document_command
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.projection_types import ViewProjection
from podcast_mcp.services.document_sync.projections import projection_for_command
from podcast_mcp.services.history import HistoryService
from podcast_mcp.services.play import _compose_gain_db

ROOT = Path(__file__).resolve().parents[1]


def _two_tracks(minimal_project: Path) -> ProjectWorkspace:
    proj = load_project(minimal_project)
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
            gain_db=-2.0,
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        ),
    ]
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _fake_premix(ws: ProjectWorkspace) -> None:
    premix = premix_path(ws.project)
    premix.parent.mkdir(parents=True, exist_ok=True)
    premix.write_bytes(b"RIFF")


def _fake_rendered_stems(project) -> dict[str, str]:
    """Pretend the stem step ran: ``track_outputs.json`` lists every track."""
    tracks_dir = project.artifacts_dir() / "tracks"
    tracks_dir.mkdir(parents=True, exist_ok=True)
    rendered = {t.id: str(tracks_dir / f"{t.id}.wav") for t in project.tracks}
    (project.artifacts_dir() / "track_outputs.json").write_text(json.dumps(rendered))
    return rendered


def _mixing_engine() -> MagicMock:
    """An ffmpeg stand-in whose mix writes the file it's asked for."""
    eng = MagicMock()
    eng.mix_tracks.side_effect = lambda inputs, out: out.write_bytes(b"RIFFMIX") or out
    return eng


def test_output_gain_adds_the_fader_to_the_staging_gain() -> None:
    track = Track(id="a", label="A", gain_db=-2.0, fader_db=-3.5)
    assert track.output_gain_db == -5.5
    with pytest.raises(ValidationError):
        Track(id="a", label="A", fader_db=12.5)
    with pytest.raises(ValidationError):
        Track(id="a", label="A", fader_db=-61)


def test_the_volume_range_matches_the_gui_and_the_schema() -> None:
    audio_ts = (ROOT / "gui/web/src/utils/audio.ts").read_text(encoding="utf-8")
    for name, value in (("FADER_MIN_DB", FADER_MIN_DB), ("FADER_MAX_DB", FADER_MAX_DB)):
        match = re.search(rf"export const {name} = (-?[\d.]+);", audio_ts)
        assert match, name
        assert float(match.group(1)) == value, name
    schema = json.loads((ROOT / "schemas/episode.project.schema.json").read_text(encoding="utf-8"))
    fader = schema["$defs"]["Track"]["properties"]["fader_db"]
    assert (fader["minimum"], fader["maximum"]) == (FADER_MIN_DB, FADER_MAX_DB)


def test_set_track_volume_saves_rounds_and_undoes(minimal_project: Path) -> None:
    ws = _two_tracks(minimal_project)
    out = EpisodeService(ws).set_track_volume("host", -3.337)
    assert out == {"track_id": "host", "fader_db": -3.34, "output_gain_db": -5.34}
    assert load_project(minimal_project).track_by_id("host").fader_db == -3.34

    HistoryService(ws).undo()
    assert ws.project.track_by_id("host").fader_db == 0.0


@pytest.mark.parametrize("bad", [12.01, -60.5, float("nan"), float("inf")])
def test_set_track_volume_rejects_values_outside_the_range(minimal_project, bad) -> None:
    ws = _two_tracks(minimal_project)
    with pytest.raises(ValueError, match="between -60 and 12 dB"):
        EpisodeService(ws).set_track_volume("host", bad)


def test_set_track_mute_saves_and_undoes(minimal_project: Path) -> None:
    ws = _two_tracks(minimal_project)
    assert EpisodeService(ws).set_track_mute("guest", True) == {
        "track_id": "guest",
        "muted": True,
    }
    assert load_project(minimal_project).track_by_id("guest").muted is True
    HistoryService(ws).undo()
    assert ws.project.track_by_id("guest").muted is False


def test_unknown_tracks_are_rejected(minimal_project: Path) -> None:
    ws = _two_tracks(minimal_project)
    with pytest.raises(ValueError, match="unknown track"):
        EpisodeService(ws).set_track_volume("nobody", 0.0)
    with pytest.raises(ValueError, match="unknown track"):
        EpisodeService(ws).set_track_mute("nobody", True)


def test_balance_never_touches_the_fader(minimal_project: Path) -> None:
    ws = _two_tracks(minimal_project)
    ws.project.track_by_id("host").fader_db = -4.0
    eng = MagicMock()
    eng.measure_loudness.return_value = -26.0
    with patch.object(steps, "ffmpeg", return_value=eng):
        steps.balance_tracks(ws.project, {"balance": {"dialogue_lufs": -20.0}})
    host = ws.project.track_by_id("host")
    assert host.gain_db == 6.0
    assert host.fader_db == -4.0


def test_the_mix_applies_output_gain_skips_muted_and_hashes_the_mix(
    minimal_project: Path,
) -> None:
    ws = _two_tracks(minimal_project)
    project = ws.project
    project.track_by_id("host").fader_db = -3.0
    project.track_by_id("guest").muted = True
    rendered = _fake_rendered_stems(project)
    eng = _mixing_engine()
    with patch.object(steps, "ffmpeg", return_value=eng):
        steps.mix_with_music(project, load_defaults())
    (inputs, _out), _kw = eng.mix_tracks.call_args
    assert inputs == [(Path(rendered["host"]), -5.0)]
    assert premix_path(project).read_bytes() == b"RIFFMIX"
    assert read_premix_hash(project) == mix_render_hash({"host": -5.0})
    assert premix_stale_vs_mix(project) is False


def test_a_failed_mix_leaves_the_old_premix_whole(minimal_project: Path) -> None:
    ws = _two_tracks(minimal_project)
    _fake_premix(ws)
    write_premix_hash(ws.project, {"old": 0.0})
    _fake_rendered_stems(ws.project)
    eng = MagicMock()
    eng.mix_tracks.side_effect = RuntimeError("ffmpeg died")
    with patch.object(steps, "ffmpeg", return_value=eng), pytest.raises(RuntimeError):
        steps.mix_with_music(ws.project, load_defaults())
    assert premix_path(ws.project).read_bytes() == b"RIFF"
    assert read_premix_hash(ws.project) == mix_render_hash({"old": 0.0})


@pytest.mark.parametrize(
    ("muted", "has_stems", "message"),
    [(True, True, "every track is muted"), (False, False, "no tracks to mix")],
)
def test_an_empty_mix_says_why(
    minimal_project: Path, muted: bool, has_stems: bool, message: str
) -> None:
    ws = _two_tracks(minimal_project)
    for track in ws.project.tracks:
        track.muted = muted
    if has_stems:
        _fake_rendered_stems(ws.project)
    else:
        (ws.project.artifacts_dir()).mkdir(parents=True, exist_ok=True)
        (ws.project.artifacts_dir() / "track_outputs.json").write_text("{}")
    eng = _mixing_engine()
    with (
        patch.object(steps, "ffmpeg", return_value=eng),
        pytest.raises(ValueError, match=message),
    ):
        steps.mix_with_music(ws.project, load_defaults())
    eng.mix_tracks.assert_not_called()
    assert read_premix_hash(ws.project) is None


def test_volume_and_mute_stale_the_premix_but_no_stem(minimal_project: Path) -> None:
    ws = _two_tracks(minimal_project)
    _fake_premix(ws)
    write_premix_hash(ws.project, mix_gains(ws.project))
    assert premix_stale_vs_mix(ws.project) is False
    stem_hashes = {t.id: track_render_hash(ws.project, t.id) for t in ws.project.tracks}
    fingerprint = audio_state_fingerprint(ws.project)

    def unchanged() -> bool:
        hashes = {t.id: track_render_hash(ws.project, t.id) for t in ws.project.tracks}
        return hashes == stem_hashes and audio_state_fingerprint(ws.project) == fingerprint

    EpisodeService(ws).set_track_volume("host", -6.0)
    assert premix_stale_vs_mix(ws.project) is True
    assert unchanged()
    report = render_status_report(ws.project)
    assert report["premix"]["stale_vs_mix"] is True
    assert report["needs_rerender"] is True

    write_premix_hash(ws.project, mix_gains(ws.project))
    assert premix_stale_vs_mix(ws.project) is False
    EpisodeService(ws).set_track_mute("guest", True)
    assert premix_stale_vs_mix(ws.project) is True
    # No stem, no reconciliation and no invalidation for a mix-only change.
    assert unchanged()
    assert ws.project.render.invalidations == []
    assert ws.project.reconciliation_stale is False


def test_render_status_keeps_reporting_a_muted_track(minimal_project: Path) -> None:
    ws = _two_tracks(minimal_project)
    EpisodeService(ws).set_track_mute("guest", True)
    assert set(render_status_report(ws.project)["tracks"]) == {"host", "guest"}


def test_a_muted_stem_newer_than_the_premix_doesnt_stale_it(minimal_project: Path) -> None:
    ws = _two_tracks(minimal_project)
    rendered = _fake_rendered_stems(ws.project)
    for path in rendered.values():
        Path(path).write_bytes(b"RIFF")
    _fake_premix(ws)
    later = premix_path(ws.project).stat().st_mtime + 10
    os.utime(rendered["guest"], (later, later))
    assert render_status_report(ws.project)["premix"]["stale_vs_stems"] is True
    ws.project.track_by_id("guest").muted = True
    assert render_status_report(ws.project)["premix"]["stale_vs_stems"] is False


def test_the_mix_hash_covers_only_what_the_mix_plays(minimal_project: Path) -> None:
    ws = _two_tracks(minimal_project)
    _fake_premix(ws)
    write_premix_hash(ws.project, mix_gains(ws.project))
    ws.project.tracks.reverse()
    ws.project.tracks.append(Track(id="empty", label="Empty", fader_db=-6.0, muted=True))
    assert premix_stale_vs_mix(ws.project) is False
    # The same output gain from a different split is the same mix.
    host = ws.project.track_by_id("host")
    host.gain_db, host.fader_db = -1.0, -1.0
    assert premix_stale_vs_mix(ws.project) is False
    # A premix that left out a track with media is stale.
    write_premix_hash(ws.project, {"host": -2.0})
    assert premix_stale_vs_mix(ws.project) is True


@pytest.mark.parametrize(
    ("change", "stale"),
    [({}, False), ({"fader_db": 1.5}, True), ({"muted": True}, True)],
)
def test_a_premix_from_before_the_hash_is_stale_once_the_mix_is_saved(
    minimal_project: Path, change: dict, stale: bool
) -> None:
    ws = _two_tracks(minimal_project)
    _fake_premix(ws)
    assert not premix_hash_path(ws.project).exists()
    for field, value in change.items():
        setattr(ws.project.track_by_id("guest"), field, value)
    assert premix_stale_vs_mix(ws.project) is stale


def test_no_premix_is_never_stale_vs_mix(minimal_project: Path) -> None:
    ws = _two_tracks(minimal_project)
    EpisodeService(ws).set_track_volume("host", -1.0)
    assert premix_stale_vs_mix(ws.project) is False


def test_the_audio_audit_hears_the_recording_not_the_mix(minimal_project: Path) -> None:
    ws = _two_tracks(minimal_project)
    host = ws.project.track_by_id("host")
    caches = TrackRmsCacheSet(caches={"host": MagicMock(**{"rms_db.return_value": -30.0})})
    before = _rms_for_track_at_timeline(ws.project, "host", 0.0, 1.0, caches=caches)
    host.fader_db, host.muted = -20.0, True
    after = _rms_for_track_at_timeline(ws.project, "host", 0.0, 1.0, caches=caches)
    assert before == after == -32.0


def test_a_cut_ripples_a_muted_track_too(minimal_project: Path) -> None:
    ws = _two_tracks(minimal_project)
    project = ws.project
    project.timeline.clips = [
        Clip(id=f"c_{tid}", track_id=tid, source_start=0.0, source_end=10.0, timeline_start=0.0)
        for tid in ("host", "guest")
    ]
    project.track_by_id("guest").muted = True
    ripple_delete(project, 2.0, 5.0, use_inaudible_opt=False)
    ends = {
        tid: max(c.timeline_end for c in project.clips if c.track_id == tid)
        for tid in ("host", "guest")
    }
    assert ends == {"host": 7.0, "guest": 7.0}


def test_compose_adds_only_the_gain_a_tier_has_not_baked() -> None:
    track = Track(id="a", label="A", gain_db=-2.0, fader_db=-3.0)
    # Segment renders bake the staging gain; stems and raw audio don't.
    assert _compose_gain_db(track, "segment_render") == -3.0
    assert _compose_gain_db(track, "segment_cache") == -3.0
    assert _compose_gain_db(track, "stem") == -5.0
    assert _compose_gain_db(track, "raw") == -5.0
    assert _compose_gain_db(None, "stem") == 0.0


def test_document_commands_apply_and_send_a_mix_patch(minimal_project: Path) -> None:
    _two_tracks(minimal_project)
    svc = DocumentSyncService.open(minimal_project)
    fader = svc.submit(
        DocumentCommand(
            type="SetTrackFader",
            payload={"track_id": "host", "fader_db": -4.5},
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert fader["ok"]
    patch_body = fader["snapshot"]["patch"]
    assert set(patch_body) == {"tracks", "render_status"}
    host = next(t for t in patch_body["tracks"] if t["id"] == "host")
    assert host["fader_db"] == -4.5

    mute = svc.submit(
        DocumentCommand(
            type="SetTrackMute",
            payload={"track_id": "guest", "muted": True},
            client_id="c1",
            role="viewer",
            client_seq=2,
        )
    )
    assert mute["ok"]
    guest = next(t for t in mute["snapshot"]["patch"]["tracks"] if t["id"] == "guest")
    assert guest["muted"] is True
    assert projection_for_command("SetTrackFader") is ViewProjection.MIX
    assert projection_for_command("SetTrackMute") is ViewProjection.MIX


@pytest.mark.parametrize("command", ["SetTrackFader", "SetTrackMute"])
def test_only_the_host_and_editors_may_change_the_mix(command: str) -> None:
    authorize_document_command(None, command)
    authorize_document_command(["edit"], command)
    for caps in (["suggest"], ["view"], ["comment"], []):
        with pytest.raises(PermissionError):
            authorize_document_command(caps, command)


def test_mcp_tools_set_volume_and_mute(minimal_project: Path) -> None:
    _two_tracks(minimal_project)
    out = track_set_volume_tool(str(minimal_project), "host", -2.0)
    assert out["fader_db"] == -2.0
    assert track_set_mute_tool(str(minimal_project), "host", True)["muted"] is True
    host = load_project(minimal_project).track_by_id("host")
    assert (host.fader_db, host.muted) == (-2.0, True)


def test_cli_sets_volume_and_mute(minimal_project: Path) -> None:
    _two_tracks(minimal_project)
    runner = CliRunner()
    volume = runner.invoke(
        app,
        [
            "episode",
            "set-track-volume",
            "--project",
            str(minimal_project),
            "--id",
            "host",
            "--db",
            "-7",
        ],
    )
    assert volume.exit_code == 0, volume.output
    assert json.loads(volume.output)["fader_db"] == -7.0
    muted = runner.invoke(
        app,
        ["episode", "set-track-mute", "--project", str(minimal_project), "--id", "host", "--muted"],
    )
    assert muted.exit_code == 0, muted.output
    assert load_project(minimal_project).track_by_id("host").muted is True


def test_history_titles_name_volume_and_mute() -> None:
    fader = format_history_group_title(
        kind="mutation",
        operation="set_track_volume",
        params={"track_id": "host", "fader_db": -3.0},
    )
    assert fader.startswith("set track volume")
    assert "-3.0 dB" in fader
    mute = format_history_group_title(
        kind="mutation",
        operation="set_track_mute",
        params={"track_id": "host", "muted": False},
    )
    assert "unmuted" in mute
