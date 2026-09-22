from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.timeline_render import (
    edits_for_clip_source,
    render_track_from_timeline,
    render_track_segment,
    resolve_clip_audio_path,
    timeline_duration_sec,
)
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
)


def test_render_two_clips_with_gap(sample_wav: Path, tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    raw = ws / "raw"
    raw.mkdir()
    audio = raw / "host.wav"
    audio.write_bytes(sample_wav.read_bytes())

    project = EpisodeProject.create("timeline_test", str(ws))
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    )
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=0.5,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=1.0,
            source_end=1.5,
            timeline_start=1.0,
        ),
    ]
    out = ws / "artifacts" / "host.wav"
    render_track_from_timeline(project, project.tracks[0], out, {})
    assert out.is_file()
    dur = FFmpegEngine().probe(out).duration_sec
    assert dur > 0.5
    assert dur < 1.6


def test_render_sequential_clips_concatenates(sample_wav: Path, tmp_path: Path) -> None:
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        import pytest

        pytest.skip("ffmpeg not available")

    ws = tmp_path / "ws_seq"
    ws.mkdir()
    raw = ws / "raw"
    raw.mkdir()
    audio = raw / "host.wav"
    audio.write_bytes(sample_wav.read_bytes())

    project = EpisodeProject.create("seq", str(ws))
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    )
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=0.4,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=0.6,
            source_end=1.0,
            timeline_start=0.4,
        ),
    ]
    out = ws / "artifacts" / "host_seq.wav"
    render_track_from_timeline(project, project.tracks[0], out, {})
    dur = eng.probe(out).duration_sec
    assert 0.75 < dur < 0.85


def test_render_applies_edit_in_clip(sample_wav: Path, tmp_path: Path) -> None:
    ws = tmp_path / "ws2"
    ws.mkdir()
    raw = ws / "raw"
    raw.mkdir()
    audio = raw / "host.wav"
    audio.write_bytes(sample_wav.read_bytes())

    project = EpisodeProject.create("edit_test", str(ws))
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    )
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
    ]
    project.edit_decisions.append(
        EditDecision(
            id="cut1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.5,
            end=1.0,
            applied=True,
        )
    )
    out = ws / "artifacts" / "host_edited.wav"
    render_track_from_timeline(project, project.tracks[0], out, {})
    assert out.is_file()
    dur = FFmpegEngine().probe(out).duration_sec
    assert dur < 1.8


def test_render_applies_transcript_gate_when_flagged(sample_wav: Path, tmp_path: Path) -> None:
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    ws = tmp_path / "ws_gate"
    ws.mkdir()
    raw = ws / "raw"
    raw.mkdir()
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())

    project = EpisodeProject.create("gate", str(ws))
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
            transcript_gate=True,
        )
    )
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
    ]
    out = ws / "artifacts" / "gated.wav"
    with patch("podcast_mcp.engines.transcript_gated_play.apply_track_transcript_gate") as gate:
        gate.side_effect = lambda project, tid, path, **kw: path
        render_track_from_timeline(project, project.tracks[0], out, {})
        gate.assert_called_once()
        assert gate.call_args.kwargs["timeline_start"] == 0.0

    seg = ws / "artifacts" / "seg.wav"
    with patch("podcast_mcp.engines.transcript_gated_play.apply_track_transcript_gate") as gate:
        gate.side_effect = lambda project, tid, path, **kw: path
        render_track_segment(project, "host", 0.0, 1.0, seg, {})
        gate.assert_called_once()
        assert gate.call_args.kwargs["timeline_end"] == 1.0


def test_render_track_segment_range(sample_wav: Path, tmp_path: Path) -> None:
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        import pytest

        pytest.skip("ffmpeg not available")

    ws = tmp_path / "ws3"
    ws.mkdir()
    raw = ws / "raw"
    raw.mkdir()
    audio = raw / "host.wav"
    audio.write_bytes(sample_wav.read_bytes())

    project = EpisodeProject.create("seg", str(ws))
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    )
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
    ]
    project.edit_decisions.append(
        EditDecision(
            id="cut1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.5,
            end=1.0,
            applied=True,
        )
    )
    out = ws / "artifacts" / "segment.wav"
    render_track_segment(project, "host", 0.0, 1.5, out, {})
    assert out.is_file()
    dur = eng.probe(out).duration_sec
    assert 0.4 < dur < 1.2


def test_render_track_segment_preserves_timeline_gap(sample_wav: Path, tmp_path: Path) -> None:
    """Play/segment render must keep insert_gap silence between clips."""
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        import pytest

        pytest.skip("ffmpeg not available")

    ws = tmp_path / "ws_gap"
    ws.mkdir()
    raw = ws / "raw"
    raw.mkdir()
    audio = raw / "host.wav"
    audio.write_bytes(sample_wav.read_bytes())

    project = EpisodeProject.create("seg_gap", str(ws))
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    )
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=0.5,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=1.0,
            source_end=1.5,
            timeline_start=1.0,  # 0.5s timeline hole after c1 ends at 0.5
        ),
    ]
    out = ws / "artifacts" / "segment_gap.wav"
    render_track_segment(project, "host", 0.0, 1.5, out, {})
    assert out.is_file()
    dur = eng.probe(out).duration_sec
    # 0.5 audio + 0.5 silence + 0.5 audio ≈ 1.5s (not ~1.0 if gap dropped)
    assert 1.35 < dur < 1.65


def test_render_track_segment_nonzero_source_start(sample_wav: Path, tmp_path: Path) -> None:
    """Clip-local edit segments must intersect absolute source bounds."""
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        import pytest

        pytest.skip("ffmpeg not available")

    ws = tmp_path / "ws_nonzero_src"
    ws.mkdir()
    raw = ws / "raw"
    raw.mkdir()
    audio = raw / "host.wav"
    audio.write_bytes(sample_wav.read_bytes())

    project = EpisodeProject.create("seg_nz", str(ws))
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    )
    # Mid-file clip: source_start > 0 (common after focus/tighten).
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.5,
            source_end=2.0,
            timeline_start=0.0,
        ),
    ]
    out = ws / "artifacts" / "segment_nz.wav"
    render_track_segment(project, "host", 0.2, 0.8, out, {})
    assert out.is_file()
    dur = eng.probe(out).duration_sec
    assert 0.4 < dur < 0.8


def _many_gapless_clips_project(
    tmp_path: Path,
    sample_wav: Path,
    *,
    clip_count: int = 60,
    clip_dur: float = 0.03,
) -> tuple[EpisodeProject, float]:
    ws = tmp_path / "ws_many"
    ws.mkdir()
    raw = ws / "raw"
    raw.mkdir()
    audio = raw / "host.wav"
    audio.write_bytes(sample_wav.read_bytes())
    eng = FFmpegEngine()
    source_dur = eng.probe(audio).duration_sec

    project = EpisodeProject.create("many_clips", str(ws))
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=source_dur),
        )
    )
    clips: list[Clip] = []
    timeline = 0.0
    source = 0.0
    for i in range(clip_count):
        take = min(clip_dur, max(0.0, source_dur - source))
        if take <= 0.001:
            break
        clips.append(
            Clip(
                id=f"c{i:04d}",
                track_id="host",
                source_start=source,
                source_end=source + take,
                timeline_start=timeline,
            )
        )
        source += take
        timeline += take
    project.timeline.clips = clips
    expected_end = max(c.timeline_end for c in clips)
    return project, expected_end


def test_render_many_gapless_clips_single_ffmpeg_pass(sample_wav: Path, tmp_path: Path) -> None:
    import podcast_mcp.engines.ffmpeg as ff

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    project, _ = _many_gapless_clips_project(tmp_path, sample_wav, clip_count=60)
    out = project.workspace_path() / "artifacts" / "host_many.wav"

    ffmpeg_calls = {"n": 0}
    real_run = ff.run

    def counting_run(cmd, *args, **kwargs):
        if isinstance(cmd, (list, tuple)) and cmd and str(cmd[0]).endswith("ffmpeg"):
            ffmpeg_calls["n"] += 1
        return real_run(cmd, *args, **kwargs)

    with patch.object(ff, "run", side_effect=counting_run):
        render_track_from_timeline(project, project.tracks[0], out, {}, engine=eng)

    assert ffmpeg_calls["n"] == 1
    assert out.is_file()


def test_render_many_gapless_clips_duration_matches_timeline(
    sample_wav: Path, tmp_path: Path
) -> None:
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    project, expected_end = _many_gapless_clips_project(tmp_path, sample_wav, clip_count=60)
    out = project.workspace_path() / "artifacts" / "host_many.wav"
    render_track_from_timeline(project, project.tracks[0], out, {})
    assert out.is_file()
    dur = eng.probe(out).duration_sec
    assert abs(dur - expected_end) < 0.1


def test_timeline_duration_from_track_media():
    project = EpisodeProject.create("dur", "/tmp/ws")
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=42.0),
        )
    ]
    assert timeline_duration_sec(project) == 42.0


def test_edits_for_clip_source_maps_local_time():
    clip = Clip(
        id="c1",
        track_id="host",
        source_start=10.0,
        source_end=20.0,
        timeline_start=0.0,
    )
    edits = [
        EditDecision(
            id="e1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=12.0,
            end=14.0,
            applied=True,
        ),
        EditDecision(
            id="e2",
            track_id="guest",
            type=EditDecisionType.REMOVE,
            start=12.0,
            end=14.0,
            applied=True,
        ),
    ]
    mapped = edits_for_clip_source(edits, "host", clip)
    assert len(mapped) == 1
    assert mapped[0].start == 2.0
    assert mapped[0].end == 4.0


def test_render_track_segment_range_partial(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    ws = tmp_path / "ws_seg"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    audio = raw / "host.wav"
    audio.write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("seg", str(ws))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    out = ws / "seg.wav"
    render_track_segment(project, "host", 0.2, 0.8, out, {}, engine=eng)
    assert out.is_file()


def test_render_gap_between_clips_pads_silence(sample_wav: Path, tmp_path: Path):
    """A timeline gap between clips is preserved as silence in a single pass."""
    import podcast_mcp.engines.ffmpeg as ff

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    ws = tmp_path / "ws_gap"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("gap", str(ws))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=0.5, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=1.0, source_end=1.5, timeline_start=1.0),
    ]
    out = ws / "gapped.wav"
    commands: list[str] = []
    real_run = ff.run

    def capture_run(cmd, *args, **kwargs):
        if isinstance(cmd, (list, tuple)):
            commands.append(" ".join(str(x) for x in cmd))
        return real_run(cmd, *args, **kwargs)

    with patch.object(ff, "run", side_effect=capture_run):
        render_track_from_timeline(project, project.tracks[0], out, {}, engine=eng)

    render_cmds = [c for c in commands if "filter_complex" in c]
    assert len(render_cmds) == 1
    assert "apad=pad_dur=0.5" in render_cmds[0]
    dur = eng.probe(out).duration_sec
    assert 1.4 < dur < 1.6


def test_render_overlapping_clips_mixes(sample_wav: Path, tmp_path: Path):
    """Clips that overlap in timeline time are summed (amix), not abutted."""
    import podcast_mcp.engines.ffmpeg as ff

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    ws = tmp_path / "ws_ov"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("ov", str(ws))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    # c2 starts at 0.5 but c1 occupies 0.0-0.8 → 0.3s overlap, no soft-join fades.
    project.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=0.8, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=1.0, source_end=1.8, timeline_start=0.5),
    ]
    out = ws / "ov.wav"
    commands: list[str] = []
    real_run = ff.run

    def capture_run(cmd, *args, **kwargs):
        if isinstance(cmd, (list, tuple)):
            commands.append(" ".join(str(x) for x in cmd))
        return real_run(cmd, *args, **kwargs)

    with patch.object(ff, "run", side_effect=capture_run):
        render_track_from_timeline(project, project.tracks[0], out, {}, engine=eng)

    render_cmds = [c for c in commands if "filter_complex" in c]
    assert len(render_cmds) == 1
    assert "amix=inputs=2" in render_cmds[0]
    assert "adelay=" in render_cmds[0]
    # Overlap preserved: c1 (0.0-0.8) mixed with c2 delayed to 0.5 → ends at 1.3s.
    dur = eng.probe(out).duration_sec
    assert 1.2 < dur < 1.4


def test_render_leading_offset_delays_first_clip(sample_wav: Path, tmp_path: Path):
    """A first clip that starts after t=0 gets a leading silence via adelay."""
    import podcast_mcp.engines.ffmpeg as ff

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    ws = tmp_path / "ws_lead"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("lead", str(ws))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=0.5, timeline_start=0.5),
    ]
    out = ws / "lead.wav"
    commands: list[str] = []
    real_run = ff.run

    def capture_run(cmd, *args, **kwargs):
        if isinstance(cmd, (list, tuple)):
            commands.append(" ".join(str(x) for x in cmd))
        return real_run(cmd, *args, **kwargs)

    with patch.object(ff, "run", side_effect=capture_run):
        render_track_from_timeline(project, project.tracks[0], out, {}, engine=eng)

    render_cmds = [c for c in commands if "filter_complex" in c]
    assert "adelay=500:all=1" in render_cmds[0]
    dur = eng.probe(out).duration_sec
    assert 0.9 < dur < 1.1


def test_render_track_without_clips_uses_full_file(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    ws = tmp_path / "ws"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    audio = raw / "host.wav"
    audio.write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("full", str(ws))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    project.timeline.clips = []
    out = ws / "out.wav"
    render_track_from_timeline(project, project.tracks[0], out, {}, engine=eng)
    assert out.is_file()


def test_crossfade_join_helpers():
    from podcast_mcp.engines.timeline_render import (
        _crossfade_ms_at_join,
        _uses_crossfade_join,
    )

    left = Clip(
        id="c1",
        track_id="host",
        source_start=0.0,
        source_end=0.5,
        timeline_start=0.0,
        fade_out_ms=30,
    )
    right = Clip(
        id="c2",
        track_id="host",
        source_start=0.6,
        source_end=1.0,
        timeline_start=0.5,
        fade_in_ms=20,
    )
    assert not _uses_crossfade_join(left, right)
    right.join_in_mode = ClipJoinMode.CROSSFADE
    assert _uses_crossfade_join(left, right)
    assert _crossfade_ms_at_join(left, right) >= 20


def test_crossfade_join_uses_canonical_gap_tolerance():
    from podcast_mcp.engines.timeline_render import _uses_crossfade_join

    left = Clip(
        id="left",
        track_id="host",
        source_start=0.0,
        source_end=1.0,
        timeline_start=0.0,
        fade_out_ms=20,
    )
    right = Clip(
        id="right",
        track_id="host",
        source_start=0.0,
        source_end=1.0,
        timeline_start=1.03,
        fade_in_ms=20,
        join_in_mode=ClipJoinMode.CROSSFADE,
    )
    assert _uses_crossfade_join(left, right)
    right.timeline_start = 1.051
    assert not _uses_crossfade_join(left, right)


def test_render_fade_join_uses_segment_afade_not_acrossfade(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    ws = tmp_path / "ws_fade"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    audio = raw / "host.wav"
    audio.write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("fade", str(ws))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=0.4,
            timeline_start=0.0,
            fade_out_ms=25,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=0.6,
            source_end=1.0,
            timeline_start=0.4,
            fade_in_ms=25,
            join_in_mode=ClipJoinMode.FADE,
        ),
    ]
    out = ws / "fade.wav"
    import podcast_mcp.engines.ffmpeg as ff

    real_run = ff.run
    commands: list[str] = []

    def capture_run(cmd, *args, **kwargs):
        if isinstance(cmd, (list, tuple)):
            commands.append(" ".join(str(x) for x in cmd))
        return real_run(cmd, *args, **kwargs)

    with patch.object(ff, "run", side_effect=capture_run):
        render_track_from_timeline(
            project,
            project.tracks[0],
            out,
            {"render": {"crossfade_curve": "tri"}},
            engine=eng,
        )

    render_cmds = [c for c in commands if "filter_complex" in c]
    assert len(render_cmds) == 1
    assert "acrossfade" not in render_cmds[0]
    assert "afade" in render_cmds[0]
    assert out.is_file()


def test_render_crossfade_join_calls_acrossfade(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    ws = tmp_path / "ws_soft"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    audio = raw / "host.wav"
    audio.write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("soft", str(ws))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=0.4,
            timeline_start=0.0,
            fade_out_ms=25,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=0.6,
            source_end=1.0,
            timeline_start=0.4,
            fade_in_ms=25,
            join_in_mode=ClipJoinMode.CROSSFADE,
        ),
    ]
    out = ws / "soft.wav"
    import podcast_mcp.engines.ffmpeg as ff

    real_run = ff.run
    commands: list[str] = []

    def capture_run(cmd, *args, **kwargs):
        if isinstance(cmd, (list, tuple)):
            commands.append(" ".join(str(x) for x in cmd))
        return real_run(cmd, *args, **kwargs)

    with patch.object(ff, "run", side_effect=capture_run):
        render_track_from_timeline(
            project,
            project.tracks[0],
            out,
            {"render": {"crossfade_curve": "tri"}},
            engine=eng,
        )

    render_cmds = [c for c in commands if "filter_complex" in c]
    assert len(render_cmds) == 1
    assert "acrossfade=d=0.025:c1=tri:c2=tri" in render_cmds[0]
    assert out.is_file()


def test_identical_clips_different_fade_ms_same_stem_length(
    sample_wav: Path, tmp_path: Path
) -> None:
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    ws = tmp_path / "ws_multitrack"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    for name in ("olga", "vicky"):
        (raw / f"{name}.wav").write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("sync", str(ws))
    project.timeline.tracks = [
        Track(
            id="olga",
            label="Olga",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/olga.wav", duration_sec=2.0),
        ),
        Track(
            id="vicky",
            label="Vicky",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/vicky.wav", duration_sec=2.0),
        ),
    ]
    clip_pairs = [
        (
            Clip(
                id="o1",
                track_id="olga",
                source_start=0.0,
                source_end=0.4,
                timeline_start=0.0,
                fade_out_ms=35,
            ),
            Clip(
                id="o2",
                track_id="olga",
                source_start=0.6,
                source_end=1.0,
                timeline_start=0.4,
                fade_in_ms=10,
                join_in_mode=ClipJoinMode.FADE,
            ),
        ),
        (
            Clip(
                id="v1",
                track_id="vicky",
                source_start=0.0,
                source_end=0.4,
                timeline_start=0.0,
                fade_out_ms=75,
            ),
            Clip(
                id="v2",
                track_id="vicky",
                source_start=0.6,
                source_end=1.0,
                timeline_start=0.4,
                fade_in_ms=50,
                join_in_mode=ClipJoinMode.FADE,
            ),
        ),
    ]
    project.timeline.clips = [c for pair in clip_pairs for c in pair]
    defaults = {"render": {"crossfade_curve": "tri"}}
    outs: list[Path] = []
    for track in project.tracks:
        out = ws / f"{track.id}.wav"
        render_track_from_timeline(project, track, out, defaults, engine=eng)
        outs.append(out)
    probe = eng.probe(outs[0])
    for out in outs[1:]:
        other = eng.probe(out)
        assert abs(other.duration_sec - probe.duration_sec) < 0.001


def test_resolve_clip_audio_rejects_workspace_escape(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    project = EpisodeProject.create("escape", str(ws))
    track = Track(
        id="host",
        label="Host",
        role=TrackRole.DIALOGUE,
        media=MediaAsset(path="../secret.wav", duration_sec=1.0),
    )
    project.timeline.tracks.append(track)
    clip = Clip(
        id="c1",
        track_id="host",
        source_start=0.0,
        source_end=1.0,
        timeline_start=0.0,
    )
    project.clips.append(clip)
    with pytest.raises(ValueError, match="under workspace"):
        resolve_clip_audio_path(project, track, clip)


def test_resolve_clip_audio_uses_source_recording(tmp_path: Path, sample_wav: Path) -> None:
    from podcast_mcp.models import SourceRecording

    ws = tmp_path / "ws"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    extra = raw / "guest.wav"
    extra.write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("src", str(ws))
    project.sources.append(
        SourceRecording(id="g1", path="raw/guest.wav", speaker="Guest", duration_sec=1.0)
    )
    track = Track(
        id="guest",
        label="Guest",
        role=TrackRole.DIALOGUE,
        media=MediaAsset(path="raw/missing.wav", duration_sec=1.0),
    )
    clip = Clip(
        id="c1",
        track_id="guest",
        source_start=0.0,
        source_end=1.0,
        timeline_start=0.0,
        source_id="g1",
    )
    assert resolve_clip_audio_path(project, track, clip) == extra.resolve()


def test_resolve_clip_audio_missing_source_does_not_fallback(
    tmp_path: Path, sample_wav: Path
) -> None:
    from podcast_mcp.models import SourceRecording

    ws = tmp_path / "ws"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    (raw / "primary.wav").write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("src", str(ws))
    project.sources.append(
        SourceRecording(id="g1", path="raw/missing-extra.wav", speaker="Guest", duration_sec=1.0)
    )
    track = Track(
        id="guest",
        label="Guest",
        role=TrackRole.DIALOGUE,
        media=MediaAsset(path="raw/primary.wav", duration_sec=1.0),
    )
    clip = Clip(
        id="c1",
        track_id="guest",
        source_start=0.0,
        source_end=1.0,
        timeline_start=0.0,
        source_id="g1",
    )
    with pytest.raises(FileNotFoundError, match="missing"):
        resolve_clip_audio_path(project, track, clip)


def test_render_overlapping_multi_source_clips_mixes(sample_wav: Path, tmp_path: Path):
    """Different source_id clips that overlap are mixed, not concatenated."""
    import podcast_mcp.engines.ffmpeg as ff
    from podcast_mcp.models import SourceRecording

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    ws = tmp_path / "ws_ms"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    (raw / "a.wav").write_bytes(sample_wav.read_bytes())
    (raw / "b.wav").write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("ms", str(ws))
    project.sources.extend(
        [
            SourceRecording(id="s1", path="raw/a.wav", speaker="Host", duration_sec=2.0),
            SourceRecording(id="s2", path="raw/b.wav", speaker="Host", duration_sec=2.0),
        ]
    )
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/a.wav", duration_sec=2.0),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=0.8,
            timeline_start=0.0,
            source_id="s1",
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=0.0,
            source_end=0.8,
            timeline_start=0.5,
            source_id="s2",
        ),
    ]
    out = ws / "ov.wav"
    commands: list[str] = []
    import podcast_mcp.util.process as proc

    real_run = proc.run

    def capture_run(cmd, *args, **kwargs):
        if isinstance(cmd, (list, tuple)):
            commands.append(" ".join(str(x) for x in cmd))
        return real_run(cmd, *args, **kwargs)

    with (
        patch.object(ff, "run", side_effect=capture_run),
        patch.object(proc, "run", side_effect=capture_run),
    ):
        render_track_from_timeline(project, project.tracks[0], out, {}, engine=eng)

    mix_cmds = [c for c in commands if "amix=" in c]
    assert mix_cmds
    dur = eng.probe(out).duration_sec
    assert 1.2 < dur < 1.5
