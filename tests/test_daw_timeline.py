from __future__ import annotations

import shlex
import wave
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.export.daw_timeline import build_daw_timeline
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.media.daw_session import export_reaper_session


def _wav(path: Path, channels: int) -> MediaAsset:
    with wave.open(str(path), "wb") as audio:
        audio.setparams((channels, 2, 48_000, 0, "NONE", "not compressed"))
        audio.writeframes(bytes(range(2 * channels)) * 48_000)
    return MediaAsset(path=path.name)


def test_saved_geometry_keeps_separate_items_and_untouched_track(tmp_path: Path) -> None:
    root = tmp_path / "original"
    with write_grant(WriteGrantKind.DISPATCHER):
        ws = ProjectWorkspace.create(root)
    project = ws.project
    mono = _wav(root / "mono.wav", 1)
    stereo = _wav(root / "stereo.wav", 2)
    project.timeline.tracks = [
        Track(id="speaker-a", label="Host", media=mono),
        Track(id="speaker-b", label="Guest", media=stereo),
        Track(id="empty", label="Empty", media=mono, timeline_empty=True),
    ]
    project.timeline.clips = [
        Clip(
            id="moved",
            track_id="speaker-a",
            source_start=0.25,
            source_end=0.75,
            timeline_start=0.5,
            fade_in_ms=20,
        ),
        Clip(
            id="overlap",
            track_id="speaker-a",
            source_start=0,
            source_end=0.25,
            timeline_start=0.875,
            fade_out_ms=10,
        ),
        Clip(
            id="after-gap",
            track_id="speaker-a",
            source_start=0,
            source_end=0.125,
            timeline_start=1.5,
        ),
    ]

    with write_grant(WriteGrantKind.DISPATCHER):
        ws.save()
    result = build_daw_timeline(project)

    assert [track.label for track in result.tracks] == ["Host", "Guest", "Empty"]
    assert [(asset.package_name, asset.channels) for asset in result.media] == [
        ("media/0001.wav", 1),
        ("media/0002.wav", 2),
    ]
    assert [
        (item.position_sec, item.start_frame, item.end_frame, item.fade_in_ms, item.fade_out_ms)
        for item in result.tracks[0].items
    ] == [
        (0.5, 12_000, 36_000, 20, 0),
        (0.875, 0, 12_000, 0, 10),
        (1.5, 0, 6_000, 0, 0),
    ]
    (guest_item,) = result.tracks[1].items
    assert (guest_item.position_sec, guest_item.start_frame, guest_item.end_frame) == (
        0,
        0,
        48_000,
    )
    assert not result.tracks[2].items

    before = ws.path.read_bytes()
    output = tmp_path / "export"
    cli = CliRunner().invoke(
        app,
        ["episode", "export-reaper", "--project", str(ws.path), "--output", str(output)],
    )
    assert cli.exit_code == 0, cli.output
    assert ws.path.read_bytes() == before
    expected_audio = [(root / media.path).read_bytes() for media in (mono, stereo)]
    moved = output.rename(tmp_path / "relocated")
    root.rename(tmp_path / "unavailable-project")
    records = [
        shlex.split(line)
        for line in (moved / "session.rpp").read_text().splitlines()
        if line.strip()
    ]
    for name, expected in {
        "NAME": [["Host"], ["Guest"], ["Empty"]],
        "POSITION": [["0.5"], ["0.875"], ["1.5"], ["0"]],
        "LENGTH": [["0.5"], ["0.25"], ["0.125"], ["1"]],
        "SOFFS": [["0.25"], ["0"], ["0"], ["0"]],
        "FILE": [["media/0001.wav"]] * 3 + [["media/0002.wav"]],
    }.items():
        assert [fields[1:] for fields in records if fields[0] == name] == expected
    for key, expected in {"FADEIN": [0.02, 0, 0, 0], "FADEOUT": [0, 0.01, 0, 0]}.items():
        fades = [fields for fields in records if fields[0] == key]
        assert [int(fields[1]) for fields in fades] == [0] * 4
        assert [float(fields[2]) for fields in fades] == expected
    for index, expected in enumerate(expected_audio, 1):
        wav = moved / "media" / f"{index:04d}.wav"
        assert wav.read_bytes() == expected

    assert not (moved / "media" / "0003.wav").exists()


def test_media_must_exist_and_stay_under_workspace(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    project = EpisodeProject.create("episode", str(root))
    project.timeline.tracks = [Track(id="host", label="Host", media=MediaAsset(path="missing.wav"))]
    with pytest.raises(FileNotFoundError):
        build_daw_timeline(project)

    project.timeline.tracks[0].media = _wav(tmp_path / "outside.wav", 1).model_copy(
        update={"path": "../outside.wav"}
    )
    with pytest.raises(ValueError, match="under workspace"):
        build_daw_timeline(project)


def test_package_collision_leaves_existing_destination_and_no_stage(tmp_path: Path) -> None:
    root = tmp_path / "original"
    with write_grant(WriteGrantKind.DISPATCHER):
        ws = ProjectWorkspace.create(root)
    asset = _wav(root / "mono.wav", 1)
    ws.project.timeline.tracks = [Track(id="host", label="Host", media=asset)]
    with write_grant(WriteGrantKind.DISPATCHER):
        ws.save()
    output = tmp_path / "export"
    output.mkdir()
    sentinel = output / "existing"
    sentinel.write_bytes(b"keep")
    with pytest.raises(FileExistsError):
        export_reaper_session(ws.path, output)
    assert list(output.iterdir()) == [sentinel]
    assert sentinel.read_bytes() == b"keep"
    assert {path.name for path in tmp_path.iterdir()} == {"original", "export"}
