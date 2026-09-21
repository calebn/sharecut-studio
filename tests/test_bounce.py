"""BounceService: mix private stems / range into export/bounces/ without mastering."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, save_project
from podcast_mcp.services import BounceRequest, BounceService, ProjectWorkspace
from podcast_mcp.services.bounce import _slug


def _seed_bounce_project(
    minimal_project: Path,
    sample_wav: Path,
    *,
    clip_end_sec: float = 2.0,
) -> ProjectWorkspace:
    ws = ProjectWorkspace.open(minimal_project)
    raw = ws.project.workspace_path() / "raw"
    raw.mkdir(exist_ok=True)
    host = raw / "host.wav"
    guest = raw / "guest.wav"
    host.write_bytes(sample_wav.read_bytes())
    guest.write_bytes(sample_wav.read_bytes())
    ws.project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav"),
        ),
    ]
    ws.project.timeline.clips = [
        Clip(
            id="h1",
            track_id="host",
            source_start=0.0,
            source_end=clip_end_sec,
            timeline_start=0.0,
        ),
        Clip(
            id="g1",
            track_id="guest",
            source_start=0.0,
            source_end=clip_end_sec,
            timeline_start=0.0,
        ),
    ]
    ws.project.timeline.duration_sec = clip_end_sec
    save_project(ws.project, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _ffmpeg_mock(*, mix_duration: float = 2.0) -> MagicMock:
    eng = MagicMock()

    def _render(project, track, out, defaults):
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_bytes(b"STEM")
        return Path(out)

    eng.render_dialogue_track.side_effect = _render
    eng.mix_tracks.side_effect = lambda inputs, out: out.write_bytes(b"RIFFMIX") or out
    eng.probe.return_value = MagicMock(duration_sec=mix_duration)
    eng.export_audio.side_effect = lambda *a, **k: Path(a[1])
    eng.extract_segment.side_effect = lambda src, out, start, end: (
        out.write_bytes(b"RIFFTRIM") or out
    )
    return eng


def test_bounce_slug_preserves_legacy_hyphen_separator():
    assert _slug(["Host Guest", "bounce"]) == "Host-Guest_bounce"


def test_bounce_all_tracks_wav(minimal_project, sample_wav):
    ws = _seed_bounce_project(minimal_project, sample_wav, clip_end_sec=2.0)
    eng = _ffmpeg_mock(mix_duration=2.0)

    with patch("podcast_mcp.services.bounce.ffmpeg", return_value=eng):
        paths = BounceService(ws).bounce(BounceRequest(formats=["wav"]))

    assert len(paths) == 1
    assert paths[0].parent.name == "bounces"
    assert paths[0].suffix == ".wav"
    assert paths[0].is_file()
    assert eng.render_dialogue_track.call_count == 2
    eng.mix_tracks.assert_called_once()
    # Private stem paths live under bounces/.*.stems/, not artifacts/tracks/
    stem_path = eng.mix_tracks.call_args[0][0][0][0]
    assert "bounces" in stem_path.parts
    assert stem_path.name == "host.wav"
    eng.extract_segment.assert_not_called()
    shared = ws.project.artifacts_dir() / "tracks" / "host.wav"
    assert not shared.exists()


def test_bounce_clamps_unscoped_to_clip_extent_when_mix_longer(minimal_project, sample_wav):
    """Lab repro: post-edit bounce must not export full pre-edit length."""
    ws = _seed_bounce_project(minimal_project, sample_wav, clip_end_sec=2.0)
    # Optional field wrong/zero must not disable clamp — clip extent wins.
    ws.project.timeline.duration_sec = 0.0
    save_project(ws.project, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    eng = _ffmpeg_mock(mix_duration=10.0)

    with patch("podcast_mcp.services.bounce.ffmpeg", return_value=eng):
        paths = BounceService(ws).bounce(BounceRequest(formats=["wav"]))

    assert paths[0].read_bytes() == b"RIFFTRIM"
    assert eng.extract_segment.call_args[0][2:] == (0.0, 2.0)


def test_bounce_renders_private_stems_not_shared_artifacts(minimal_project, sample_wav):
    ws = _seed_bounce_project(minimal_project, sample_wav)
    eng = _ffmpeg_mock(mix_duration=2.0)
    shared_dir = ws.project.artifacts_dir() / "tracks"
    shared_dir.mkdir(parents=True, exist_ok=True)
    (shared_dir / "host.wav").write_bytes(b"SHARED-OLD")

    with patch("podcast_mcp.services.bounce.ffmpeg", return_value=eng):
        BounceService(ws).bounce(BounceRequest(formats=["wav"]))

    assert (shared_dir / "host.wav").read_bytes() == b"SHARED-OLD"
    for call in eng.render_dialogue_track.call_args_list:
        out = Path(call.args[2])
        assert "artifacts" not in out.parts or out.parts[-3] != "artifacts"
        assert out.parent.name.endswith(".stems") or ".stems" in str(out.parent)


def test_bounce_selected_tracks_and_range(minimal_project, sample_wav):
    ws = _seed_bounce_project(minimal_project, sample_wav)
    eng = _ffmpeg_mock(mix_duration=5.0)

    def _mix(inputs, out):
        assert len(inputs) == 1
        assert inputs[0][0].name == "guest.wav"
        out.write_bytes(b"RIFFMIX")
        return out

    eng.mix_tracks.side_effect = _mix

    with patch("podcast_mcp.services.bounce.ffmpeg", return_value=eng):
        paths = BounceService(ws).bounce(
            BounceRequest(track_ids=["guest"], start_s=1.0, end_s=2.5, formats=["wav"])
        )

    assert len(paths) == 1
    assert paths[0].read_bytes() == b"RIFFTRIM"
    eng.extract_segment.assert_called_once()
    assert eng.render_dialogue_track.call_count == 1


def test_bounce_rejects_unknown_track(minimal_project, sample_wav):
    ws = _seed_bounce_project(minimal_project, sample_wav)
    with pytest.raises(ValueError, match="unknown track_ids"):
        BounceService(ws).bounce(BounceRequest(track_ids=["missing"]))


def test_bounce_rejects_inverted_range(minimal_project, sample_wav):
    ws = _seed_bounce_project(minimal_project, sample_wav)
    with pytest.raises(ValueError, match="end_s"):
        BounceService(ws).bounce(BounceRequest(start_s=3.0, end_s=1.0))


def test_bounce_wav_and_mp3_via_shared_writer(minimal_project, sample_wav):
    ws = _seed_bounce_project(minimal_project, sample_wav, clip_end_sec=2.0)
    eng = _ffmpeg_mock(mix_duration=2.0)
    eng.export_audio.side_effect = lambda *a, **k: Path(a[1]).write_bytes(b"MP3")

    with patch("podcast_mcp.services.bounce.ffmpeg", return_value=eng):
        paths = BounceService(ws).bounce(BounceRequest(formats=["wav", "mp3"]))

    assert {p.suffix for p in paths} == {".wav", ".mp3"}
    assert all(p.parent.name == "bounces" for p in paths)
    eng.export_audio.assert_called_once()
    wav = next(p for p in paths if p.suffix == ".wav")
    assert wav.read_bytes() == b"RIFFMIX"


def test_bounce_cleans_temp_mix_when_trim_fails(minimal_project, sample_wav):
    ws = _seed_bounce_project(minimal_project, sample_wav)
    eng = _ffmpeg_mock(mix_duration=5.0)
    temps: list[Path] = []

    def _mix(inputs, out):
        out.write_bytes(b"RIFFMIX")
        temps.append(out)
        return out

    eng.mix_tracks.side_effect = _mix
    eng.extract_segment.side_effect = RuntimeError("ffmpeg trim failed")

    with patch("podcast_mcp.services.bounce.ffmpeg", return_value=eng):
        with pytest.raises(RuntimeError, match="trim failed"):
            BounceService(ws).bounce(
                BounceRequest(track_ids=["guest"], start_s=1.0, end_s=2.5, formats=["wav"])
            )

    assert temps
    assert not temps[0].exists()


def test_bounce_defaults_and_skips_muted_tracks(minimal_project, sample_wav):
    ws = _seed_bounce_project(minimal_project, sample_wav, clip_end_sec=2.0)
    ws.project.tracks[0].muted = True
    save_project(ws.project, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    eng = _ffmpeg_mock(mix_duration=2.0)

    with patch("podcast_mcp.services.bounce.ffmpeg", return_value=eng):
        paths = BounceService(ws).bounce()

    assert len(paths) == 1
    assert eng.render_dialogue_track.call_count == 1
    assert eng.render_dialogue_track.call_args.args[1].id == "guest"


def test_bounce_skips_tracks_without_media(minimal_project, sample_wav):
    ws = _seed_bounce_project(minimal_project, sample_wav)
    ws.project.tracks[0].media = None
    ws.project.tracks[1].media = None
    save_project(ws.project, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(ValueError, match="no bounceable tracks"):
        BounceService(ws).bounce(BounceRequest(formats=["wav"]))


def test_bounce_start_only_uses_clip_extent_or_probe(minimal_project, sample_wav):
    ws = _seed_bounce_project(minimal_project, sample_wav, clip_end_sec=0.0)
    ws.project.timeline.clips = []
    save_project(ws.project, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    eng = _ffmpeg_mock(mix_duration=4.0)

    with patch("podcast_mcp.services.bounce.ffmpeg", return_value=eng):
        paths = BounceService(ws).bounce(BounceRequest(start_s=1.0, formats=["wav"]))

    assert paths[0].read_bytes() == b"RIFFTRIM"
    assert eng.extract_segment.call_args[0][2:] == (1.0, 4.0)


def test_bounce_rejects_probe_range_when_end_not_after_start(minimal_project, sample_wav):
    ws = _seed_bounce_project(minimal_project, sample_wav, clip_end_sec=0.0)
    ws.project.timeline.clips = []
    save_project(ws.project, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    eng = _ffmpeg_mock(mix_duration=1.0)

    with patch("podcast_mcp.services.bounce.ffmpeg", return_value=eng):
        with pytest.raises(ValueError, match="end_s must be greater"):
            BounceService(ws).bounce(BounceRequest(start_s=1.0, formats=["wav"]))


def test_bounce_cancel_check_stops_before_encode(minimal_project, sample_wav):
    from podcast_mcp.util.progress import CancelledProgress

    ws = _seed_bounce_project(minimal_project, sample_wav)
    eng = _ffmpeg_mock()
    cancelled = {"n": 0}

    def cancel_check() -> bool:
        cancelled["n"] += 1
        return cancelled["n"] > 1

    with patch("podcast_mcp.services.bounce.ffmpeg", return_value=eng):
        with pytest.raises(CancelledProgress, match="Bounce cancelled"):
            BounceService(ws).bounce(
                BounceRequest(formats=["wav"]),
                cancel_check=cancel_check,
            )
    eng.mix_tracks.assert_not_called()


def test_bounce_cleans_private_stem_dir(minimal_project, sample_wav):
    ws = _seed_bounce_project(minimal_project, sample_wav)
    eng = _ffmpeg_mock(mix_duration=2.0)
    stem_dirs: list[Path] = []

    def _render(project, track, out, defaults):
        p = Path(out)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"STEM")
        stem_dirs.append(p.parent)
        return p

    eng.render_dialogue_track.side_effect = _render

    with patch("podcast_mcp.services.bounce.ffmpeg", return_value=eng):
        BounceService(ws).bounce(BounceRequest(formats=["wav"]))

    assert stem_dirs
    assert not stem_dirs[0].exists()


def test_slug_falls_back_when_parts_empty():
    from podcast_mcp.services.bounce import _slug

    assert _slug([]) == "bounce"
    assert _slug(["", "!!!"]) == "bounce"
