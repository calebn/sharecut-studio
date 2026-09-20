from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.engines.timemap import timeline_to_source
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.services.play import PlayRequest, PlayService
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.time_parse import parse_time_sec

runner = CliRunner()


def test_parse_time_sec_formats() -> None:
    assert parse_time_sec("12.5") == 12.5
    assert parse_time_sec("1:30") == 90.0
    assert parse_time_sec("0:01:05") == 65.0
    assert parse_time_sec("-3") == -3.0


def test_parse_time_sec_invalid() -> None:
    with pytest.raises(ValueError, match="invalid time"):
        parse_time_sec("not-a-time")


def test_timeline_to_source_with_clip(minimal_project, sample_wav, tmp_workspace) -> None:
    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    proj.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=10.0,
            source_end=50.0,
            timeline_start=0.0,
        )
    ]
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)
    path, src_t = timeline_to_source(proj, "host", 5.0)
    assert path.name == "host.wav"
    assert src_t == 15.0


def test_play_service_dry_run(minimal_project, sample_wav, tmp_workspace) -> None:
    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    mock_extract = MagicMock(return_value=dest)
    with patch("podcast_mcp.services.play.FFmpegEngine") as eng_cls:
        eng_cls.return_value.extract_segment = mock_extract
        result = PlayService(ws).play(
            PlayRequest(source="track:host", start_sec=0.0, end_sec=1.0),
            dry_run=True,
        )
    assert result.wav_path.suffix == ".wav"
    mock_extract.assert_called_once()
    from podcast_mcp.services.session_state import read_session_state

    state = read_session_state(ws.project)
    assert state is not None
    # dry_run play → browser transport; real play would leave is_playing False
    assert state["is_playing"] is True
    assert state["region"] == {"start_sec": 0.0, "end_sec": 1.0}
    assert state["source"] == "track:host"
    assert state["track_id"] == "host"
    assert state["command_id"]
    assert state["origin"] == "agent"


def test_play_publish_audition_can_skip(minimal_project, sample_wav, tmp_workspace) -> None:
    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    with patch("podcast_mcp.services.play.FFmpegEngine") as eng_cls:
        eng_cls.return_value.extract_segment = MagicMock(return_value=dest)
        PlayService(ws).play(
            PlayRequest(source="track:host", start_sec=0.0, end_sec=1.0),
            dry_run=True,
            publish_audition=False,
        )
    from podcast_mcp.services.session_state import read_session_state

    assert read_session_state(ws.project) is None


def test_play_cli_dry_run(minimal_project, sample_wav, tmp_workspace) -> None:
    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(proj, minimal_project)
    with patch("podcast_mcp.services.play.FFmpegEngine") as eng_cls:
        eng_cls.return_value.extract_segment = MagicMock(return_value=dest)
        result = runner.invoke(
            app,
            [
                "play",
                "--project",
                str(minimal_project),
                "--source",
                "track:host",
                "--start",
                "0",
                "--end",
                "1",
                "--dry-run",
            ],
        )
    assert result.exit_code == 0
    assert "wav" in result.stdout


def test_resolve_transport_path_premix_stem_raw(minimal_project, sample_wav, tmp_workspace) -> None:
    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    premix = ws.project.artifacts_dir() / "premix.wav"
    premix.parent.mkdir(parents=True, exist_ok=True)
    premix.write_bytes(b"RIFF")
    stem = ws.project.artifacts_dir() / "tracks" / "host.wav"
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(b"RIFF")

    svc = PlayService(ws)
    tp = svc.resolve_transport_path("premix")
    assert tp.tier == "premix"
    assert tp.path == premix.resolve()
    assert tp.source == "premix"

    ts = svc.resolve_transport_path("stem", track_id="host")
    assert ts.tier == "stem"
    assert ts.source == "processed:host"
    assert ts.path == stem.resolve()

    tr = svc.resolve_transport_path("raw", track_id="host")
    assert tr.tier == "raw"
    assert tr.source == "track:host"
    assert tr.path == dest.resolve()

    with pytest.raises(ValueError, match="unknown transport"):
        svc.resolve_transport_path("nope")


def test_play_processed_segment_render(minimal_project, sample_wav, tmp_workspace) -> None:
    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    seg_out = tmp_workspace / "seg.wav"
    with patch(
        "podcast_mcp.services.play.render_track_segment",
        return_value=seg_out,
    ) as seg:
        seg_out.touch()
        result = PlayService(ws).play(
            PlayRequest(source="processed:host", start_sec=0.0, end_sec=1.0),
            dry_run=True,
        )
    seg.assert_called_once()
    assert result.tier in ("segment_render", "segment_cache")


def _wav_duration_sec(path: Path) -> float:
    import wave

    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def test_play_ab_wavs_concat_includes_gap(minimal_project, sample_wav, tmp_workspace) -> None:
    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    svc = PlayService(ws)
    a = svc.play(
        PlayRequest(source="track:host", start_sec=0.0, end_sec=0.4),
        dry_run=True,
        publish_audition=False,
    ).wav_path
    b = svc.play(
        PlayRequest(source="track:host", start_sec=0.4, end_sec=0.8),
        dry_run=True,
        publish_audition=False,
    ).wav_path
    gap = 0.25
    result = svc.play_ab_wavs(a, b, gap_sec=gap, dry_run=True)
    assert result.tier == "ab_concat"
    assert result.wav_path.is_file()
    dur = _wav_duration_sec(result.wav_path)
    expected = _wav_duration_sec(a) + gap + _wav_duration_sec(b)
    assert abs(dur - expected) < 0.05


def test_play_ab_wavs_zero_gap(minimal_project, sample_wav, tmp_workspace) -> None:
    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    svc = PlayService(ws)
    a = svc.play(
        PlayRequest(source="track:host", start_sec=0.0, end_sec=0.3),
        dry_run=True,
        publish_audition=False,
    ).wav_path
    b = svc.play(
        PlayRequest(source="track:host", start_sec=0.3, end_sec=0.6),
        dry_run=True,
        publish_audition=False,
    ).wav_path
    result = svc.play_ab_wavs(a, b, gap_sec=0.0, dry_run=True)
    assert result.wav_path.is_file()
    dur = _wav_duration_sec(result.wav_path)
    expected = _wav_duration_sec(a) + _wav_duration_sec(b)
    assert abs(dur - expected) < 0.05


def test_play_history_ab_copies_then_concats(minimal_project, sample_wav, tmp_workspace) -> None:
    from podcast_mcp.services.history import HistoryService

    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    hist = HistoryService(ws)
    # Ensure at least two snapshots to A/B between.
    ws.record_snapshot("probe/ab-a", force=True)
    before = hist.status()["cursor"]
    # Nudge project label so a second snapshot is distinct.
    ws.project.name = "episode-b"
    ws.save()
    ws.record_snapshot("probe/ab-b", force=True)
    after = hist.status()["cursor"]
    assert after != before

    play_calls: list[int] = []
    real_play = PlayService.play

    def tracking_play(self, req, **kwargs):  # type: ignore[no-untyped-def]
        play_calls.append(hist.status()["cursor"])
        return real_play(self, req, **kwargs)

    with patch.object(PlayService, "play", tracking_play):
        result = PlayService(ws).play_history_ab(
            before,
            after,
            PlayRequest(source="track:host", start_sec=0.0, end_sec=0.5),
            gap_sec=0.2,
            dry_run=True,
        )
    assert result.tier == "ab_concat"
    assert result.wav_path.is_file()
    assert play_calls[:2] == [before, after]
    assert hist.status()["cursor"] == after


def test_play_ab_wavs_missing_files(minimal_project, sample_wav, tmp_workspace) -> None:
    proj = load_project(minimal_project)
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    svc = PlayService(ws)
    with pytest.raises(FileNotFoundError, match="A wav"):
        svc.play_ab_wavs(tmp_workspace / "missing_a.wav", sample_wav, dry_run=True)
    with pytest.raises(FileNotFoundError, match="B wav"):
        svc.play_ab_wavs(sample_wav, tmp_workspace / "missing_b.wav", dry_run=True)


def test_play_history_ab_rejects_same_index(minimal_project, sample_wav, tmp_workspace) -> None:
    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(ValueError, match="must differ"):
        PlayService(ws).play_history_ab(
            0,
            0,
            PlayRequest(source="track:host", start_sec=0.0, end_sec=0.5),
            dry_run=True,
        )


def test_play_ab_wavs_reuses_cache_and_plays(minimal_project, sample_wav, tmp_workspace) -> None:
    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    svc = PlayService(ws)
    a = svc.play(
        PlayRequest(source="track:host", start_sec=0.0, end_sec=0.2),
        dry_run=True,
        publish_audition=False,
    ).wav_path
    b = svc.play(
        PlayRequest(source="track:host", start_sec=0.2, end_sec=0.4),
        dry_run=True,
        publish_audition=False,
    ).wav_path
    first = svc.play_ab_wavs(a, b, gap_sec=0.1, dry_run=True)
    with patch.object(PlayService, "_write_ab_concat") as write_concat:
        second = svc.play_ab_wavs(a, b, gap_sec=0.1, dry_run=True)
        write_concat.assert_not_called()
    assert first.wav_path == second.wav_path
    with patch("podcast_mcp.services.play.run") as run_mock:
        run_mock.return_value = MagicMock(returncode=0)
        played = svc.play_ab_wavs(
            a,
            b,
            gap_sec=0.1,
            dry_run=False,
            player="true",
            publish_audition=True,
            start_sec=1.0,
            end_sec=2.0,
        )
    assert played.player_cmd == ["true", str(first.wav_path)]
    run_mock.assert_called()


def test_play_ab_cli_dry_run(minimal_project, sample_wav, tmp_workspace) -> None:
    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ws.record_snapshot("ab-cli-a", force=True)
    from podcast_mcp.services.history import HistoryService

    before = HistoryService(ws).status()["cursor"]
    ws.project.name = "renamed"
    ws.save()
    ws.record_snapshot("ab-cli-b", force=True)
    after = HistoryService(ws).status()["cursor"]

    result = runner.invoke(
        app,
        [
            "play",
            "ab",
            "--project",
            str(minimal_project),
            "--before-index",
            str(before),
            "--after-index",
            str(after),
            "--source",
            "track:host",
            "--start",
            "0",
            "--end",
            "0.5",
            "--gap",
            "0.1",
            "--dry-run",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "ab_concat" in result.output or '"tier"' in result.output


def test_play_pending_preview_suggested_shorter_than_current(
    minimal_project, sample_wav, tmp_workspace
) -> None:
    from podcast_mcp.models import Clip, EditDecision, EditDecisionType, Track, TrackRole

    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    proj.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    proj.edit_decisions.append(
        EditDecision(
            id="cut1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.8,
            end=1.2,
            applied=False,
            review_required=True,
            scope="session",
        )
    )
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    premix = ws.project.artifacts_dir() / "premix.wav"
    premix.parent.mkdir(parents=True, exist_ok=True)
    premix.write_bytes(sample_wav.read_bytes())

    svc = PlayService(ws)
    with pytest.raises(ValueError, match="mode must be"):
        svc.play_pending_preview("cut1", mode="nope", dry_run=True)
    suggested = svc.play_pending_preview("cut1", mode="suggested", pad_sec=0.3, dry_run=True)
    assert svc.pending_preview_cached_wav("cut1", mode="current") is None
    current = svc.play_pending_preview("cut1", mode="current", pad_sec=0.3, dry_run=True)
    assert _wav_duration_sec(suggested.wav_path) < _wav_duration_sec(current.wav_path)
    assert suggested.tier == "pending_suggested"

    from podcast_mcp.edits.pending_preview import resolve_pending_preview

    window = resolve_pending_preview(ws.project, "cut1", pad_sec=0.3)
    path_before = svc._pending_suggested_path(window, source="premix")
    os.utime(premix, ns=(1_000_000_000, 2_000_000_000))
    path_after = svc._pending_suggested_path(window, source="premix")
    assert path_before != path_after

    cli = runner.invoke(
        app,
        [
            "play",
            "pending-preview",
            "--project",
            str(minimal_project),
            "--edit-id",
            "cut1",
            "--mode",
            "current",
            "--padding",
            "0.3",
            "--dry-run",
        ],
    )
    assert cli.exit_code == 0, cli.output
    assert "pending_current" in cli.output

    split = EditDecision(
        id="split1",
        track_id="host",
        type=EditDecisionType.SPLIT,
        start=1.0,
        end=1.0,
        applied=False,
        timebase="timeline",
    )
    ws.project.edit_decisions.append(split)
    save_project(ws.project, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(ValueError, match="split"):
        PlayService(ws).play_pending_preview("split1", mode="suggested", dry_run=True)


def test_play_compose_mixes_two_raw_tracks(minimal_project, sample_wav, tmp_workspace) -> None:
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    for tid in ("host", "guest"):
        dest = raw / f"{tid}.wav"
        dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=2.0),
        ),
    ]
    proj.clips = [
        Clip(
            id="c_host",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c_guest",
            track_id="guest",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    result = PlayService(ws).play_compose(
        ["host", "guest"],
        0.0,
        1.0,
        tier="raw",
        dry_run=True,
        publish_audition=False,
    )
    assert result.tier == "compose"
    assert result.wav_path.is_file()
    assert "host,guest" in result.source_label

    with pytest.raises(ValueError, match="unknown track_ids"):
        PlayService(ws).play_compose(["nope"], 0.0, 1.0, dry_run=True)
    with pytest.raises(ValueError, match="track_ids"):
        PlayService(ws).play_compose([], 0.0, 1.0, dry_run=True)
    with pytest.raises(ValueError, match="tier"):
        PlayService(ws).play_compose(["host"], 0.0, 1.0, tier="fx", dry_run=True)


def test_play_compose_cli_dry_run(minimal_project, sample_wav, tmp_workspace) -> None:
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    proj.clips = [
        Clip(
            id="c_host",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    save_project(proj, minimal_project)
    cli = runner.invoke(
        app,
        [
            "play",
            "compose",
            "--project",
            str(minimal_project),
            "--track-ids",
            "host",
            "--start",
            "0",
            "--end",
            "1",
            "--tier",
            "raw",
            "--dry-run",
        ],
    )
    assert cli.exit_code == 0, cli.output
    assert "compose" in cli.output


def test_play_compose_processed_skips_gain_and_writes_atomic(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
) -> None:
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    proj = load_project(minimal_project)
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    dest = raw / "host.wav"
    dest.write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
            gain_db=6.0,
        )
    ]
    proj.clips = [
        Clip(
            id="c_host",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    wav = tmp_workspace / "seg.wav"
    wav.write_bytes(sample_wav.read_bytes())

    def fake_resolve(self, source, start, end, *, rerender=False):
        return wav, "stem", start, end

    mix_dests: list[str] = []
    gains: list[float] = []

    def fake_mix(self, segments, dest):
        mix_dests.append(dest.name)
        gains.extend(g for _, g in segments)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(sample_wav.read_bytes())
        return dest

    monkeypatch.setattr(PlayService, "_resolve_audio", fake_resolve)
    monkeypatch.setattr(FFmpegEngine, "mix_tracks", fake_mix)
    result = PlayService(ws).play_compose(
        ["host"], 0.0, 1.0, tier="processed", dry_run=True, publish_audition=False
    )
    assert gains == [0.0]
    assert mix_dests and "partial" in mix_dests[0]
    assert "partial" not in result.wav_path.name
    assert result.wav_path.is_file()
    assert result.wav_path.name.startswith("compose_")

    gains.clear()
    mix_dests.clear()
    PlayService(ws).play_compose(
        ["host"], 0.0, 1.0, tier="raw", dry_run=True, publish_audition=False, rerender=True
    )
    assert gains == [6.0]
