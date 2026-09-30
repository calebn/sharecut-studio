from __future__ import annotations

import wave
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.edits.clips_ops import JOIN_GAP_TOLERANCE_SEC
from podcast_mcp.engines.ffmpeg import FFmpegEngine, PlacedSegment
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


def _write_constant_pcm_wav(
    path: Path,
    *,
    duration_sec: float,
    amplitude: float,
    sample_rate: int = 48_000,
) -> bytes:
    import numpy as np

    samples = np.full(
        round(duration_sec * sample_rate),
        round(amplitude * 32767),
        dtype="<i2",
    )
    data = samples.tobytes()
    _write_pcm_wav_bytes(path, data, sample_rate=sample_rate)
    return data


def _write_pcm_wav_bytes(path: Path, data: bytes, *, sample_rate: int = 48_000) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as audio_file:
        audio_file.setnchannels(1)
        audio_file.setsampwidth(2)
        audio_file.setframerate(sample_rate)
        audio_file.writeframes(data)


def _read_pcm(path: Path):
    import numpy as np

    with wave.open(str(path), "rb") as audio_file:
        return np.frombuffer(audio_file.readframes(audio_file.getnframes()), dtype="<i2")


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
    assert dur == pytest.approx(1.0, abs=1 / 48_000)


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


def test_render_track_segment_uses_each_clip_source_and_keeps_timeline_hole(
    tmp_path: Path,
) -> None:
    import numpy as np

    from podcast_mcp.models import SourceRecording

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    ws = tmp_path / "ws_segment_sources"
    raw = ws / "raw"
    raw.mkdir(parents=True)

    def write_constant(path: Path, amplitude: float) -> None:
        samples = np.full(4 * 48_000, amplitude, dtype=np.float32)
        pcm16 = np.round(samples * 32767).astype("<i2")
        with wave.open(str(path), "wb") as audio_file:
            audio_file.setnchannels(1)
            audio_file.setsampwidth(2)
            audio_file.setframerate(48_000)
            audio_file.writeframes(pcm16.tobytes())

    write_constant(raw / "primary.wav", 0.05)
    write_constant(raw / "source-a.wav", 0.25)
    write_constant(raw / "source-b.wav", 0.5)
    project = EpisodeProject.create("segment_sources", str(ws))
    project.sources.extend(
        [
            SourceRecording(id="a", path="raw/source-a.wav", speaker="Host"),
            SourceRecording(id="b", path="raw/source-b.wav", speaker="Host"),
        ]
    )
    track = Track(
        id="host",
        label="Host",
        role=TrackRole.DIALOGUE,
        media=MediaAsset(path="raw/primary.wav", duration_sec=4.0),
        transcript_gate=True,
    )
    project.timeline.tracks.append(track)
    project.timeline.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=0.5,
            timeline_start=1.0,
            source_id="a",
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=0.0,
            source_end=0.5,
            timeline_start=2.25,
            source_id="b",
        ),
    ]

    out = ws / "artifacts" / "segment_sources.wav"
    with patch("podcast_mcp.engines.transcript_gated_play.apply_track_transcript_gate") as gate:
        render_track_segment(project, "host", 1.0, 3.0, out, {}, engine=eng)
    assert gate.call_args.kwargs["timeline_start"] == 1.0
    assert gate.call_args.kwargs["timeline_end"] == 3.0
    with wave.open(str(out), "rb") as rendered:
        audio = np.frombuffer(rendered.readframes(rendered.getnframes()), dtype="<i2")
        sample_rate = rendered.getframerate()
    assert sample_rate == 48_000
    assert len(audio) == 2 * sample_rate
    assert float(np.abs(audio[:12_000]).mean()) / 32768 == pytest.approx(0.25, abs=0.01)
    assert float(np.abs(audio[36_000:48_000]).mean()) / 32768 == pytest.approx(0.0, abs=0.002)
    assert float(np.abs(audio[60_000:72_000]).mean()) / 32768 == pytest.approx(0.5, abs=0.01)


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
    from podcast_mcp.edits.clips_ops import (
        crossfade_ms_at_join,
        uses_crossfade_join,
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
    assert not uses_crossfade_join(left, right)
    right.join_in_mode = ClipJoinMode.CROSSFADE
    assert uses_crossfade_join(left, right)
    assert crossfade_ms_at_join(left, right) >= 20


def test_crossfade_join_uses_canonical_gap_tolerance():
    from podcast_mcp.edits.clips_ops import uses_crossfade_join

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
        timeline_start=1.0 + JOIN_GAP_TOLERANCE_SEC / 2,
        fade_in_ms=20,
        join_in_mode=ClipJoinMode.CROSSFADE,
    )
    assert uses_crossfade_join(left, right)
    right.timeline_start = 1.0 + JOIN_GAP_TOLERANCE_SEC + 1e-3
    assert not uses_crossfade_join(left, right)


def _two_clip_project(ws: Path, sample_wav: Path, gap: float, mode: ClipJoinMode) -> EpisodeProject:
    raw = ws / "raw"
    raw.mkdir(parents=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("join_tol", str(ws))
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
            fade_out_ms=20,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=0.6,
            source_end=1.0,
            timeline_start=0.4 + gap,
            fade_in_ms=20,
            join_in_mode=mode,
        ),
    ]
    return project


def _capture_segment_placement(project: EpisodeProject, out: Path) -> list[PlacedSegment]:
    captured: list[PlacedSegment] = []

    def fake_render(_src, output_path, placed, *_args, **_kwargs):
        captured.extend(placed)
        return output_path

    eng = FFmpegEngine()
    with patch.object(eng, "render_timeline", side_effect=fake_render):
        render_track_segment(project, "host", 0.0, 1.0, out, {}, engine=eng)
    return captured


def test_render_track_segment_crossfades_sub_tolerance_gap(sample_wav: Path, tmp_path: Path):
    project = _two_clip_project(
        tmp_path / "ws", sample_wav, JOIN_GAP_TOLERANCE_SEC / 2, ClipJoinMode.CROSSFADE
    )

    placed = _capture_segment_placement(project, tmp_path / "seg.wav")

    assert placed[1].crossfade_prev_sec == pytest.approx(0.02)
    assert placed[1].gap_before_sec == 0.0


def test_render_track_segment_keeps_gap_beyond_tolerance(sample_wav: Path, tmp_path: Path):
    gap = JOIN_GAP_TOLERANCE_SEC + 0.01
    project = _two_clip_project(tmp_path / "ws", sample_wav, gap, ClipJoinMode.CROSSFADE)

    placed = _capture_segment_placement(project, tmp_path / "seg.wav")

    assert placed[1].crossfade_prev_sec == 0.0
    assert placed[1].gap_before_sec == pytest.approx(gap)


def test_render_crossfade_join_absorbs_sub_tolerance_gap(sample_wav: Path, tmp_path: Path):
    """A CROSSFADE join with a 30 ms gap renders as a crossfade; the gap is not kept.

    Same rule as FADE joins: gaps within JOIN_GAP_TOLERANCE_SEC close up, so the
    stem is shorter than the timeline by the gap plus the crossfade overlap.
    """
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    gap = 0.03
    assert gap < JOIN_GAP_TOLERANCE_SEC
    ws = tmp_path / "ws"
    project = _two_clip_project(ws, sample_wav, gap, ClipJoinMode.CROSSFADE)
    out = ws / "xfade_gap.wav"
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
    assert "acrossfade=d=0.02:c1=tri:c2=tri" in render_cmds[0]
    assert "apad" not in render_cmds[0]
    # 0.4 s + 0.4 s - 0.02 s crossfade overlap; the 30 ms gap is absorbed.
    assert eng.probe(out).duration_sec == pytest.approx(0.78, abs=0.01)


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


def test_multi_source_segment_applies_transcript_gate_once_to_pcm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import numpy as np

    from podcast_mcp.engines.bleed_gate import BleedGatePlan
    from podcast_mcp.models import SourceRecording

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    ws = tmp_path / "ws_multi_source_gate_once"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    for name in ("a.wav", "b.wav"):
        _write_constant_pcm_wav(raw / name, duration_sec=2.0, amplitude=0.4)

    project = EpisodeProject.create("multi_source_gate_once", str(ws))
    project.sources.extend(
        [
            SourceRecording(id="a", path="raw/a.wav", speaker="Host"),
            SourceRecording(id="b", path="raw/b.wav", speaker="Host"),
        ]
    )
    track = Track(
        id="host",
        label="Host",
        role=TrackRole.DIALOGUE,
        media=MediaAsset(path="raw/a.wav", duration_sec=2.0),
        transcript_gate=True,
    )
    project.timeline.tracks.append(track)
    project.timeline.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
            source_id="a",
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=1.0,
            source_id="b",
        ),
    ]
    plan = BleedGatePlan(attenuation_spans=((0.2, 0.8),), fade_sec=0.1)
    monkeypatch.setattr(
        "podcast_mcp.engines.transcript_gated_play.build_bleed_gate_plan",
        lambda *_args, **_kwargs: plan,
    )

    full = ws / "artifacts" / "full.wav"
    segment = ws / "artifacts" / "segment.wav"
    render_track_from_timeline(project, track, full, {}, engine=eng)
    render_track_segment(project, "host", 0.0, 2.0, segment, {}, engine=eng)

    full_pcm = _read_pcm(full)
    segment_pcm = _read_pcm(segment)
    assert segment_pcm.shape == full_pcm.shape
    np.testing.assert_allclose(segment_pcm, full_pcm, atol=2)


def test_multi_source_segment_fades_only_at_real_clip_edges(tmp_path: Path) -> None:
    import numpy as np

    from podcast_mcp.models import SourceRecording

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    ws = tmp_path / "ws_multi_source_fades"
    raw = ws / "raw"
    a_pcm = _write_constant_pcm_wav(raw / "a.wav", duration_sec=2.0, amplitude=0.4)
    b_pcm = _write_constant_pcm_wav(raw / "b.wav", duration_sec=2.0, amplitude=0.4)
    _write_pcm_wav_bytes(raw / "single.wav", a_pcm + b_pcm)

    project = EpisodeProject.create("multi_source_fades", str(ws))
    project.sources.extend(
        [
            SourceRecording(id="a", path="raw/a.wav", speaker="Host"),
            SourceRecording(id="b", path="raw/b.wav", speaker="Host"),
        ]
    )
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/a.wav", duration_sec=2.0),
        )
    )
    project.timeline.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
            source_id="a",
            fade_in_ms=100,
            fade_out_ms=100,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=1.5,
            source_id="b",
            fade_in_ms=100,
            fade_out_ms=100,
        ),
    ]
    full = ws / "artifacts" / "full.wav"
    seek = ws / "artifacts" / "seek.wav"
    render_track_segment(project, "host", 0.0, 2.5, full, {}, engine=eng)
    render_track_segment(project, "host", 0.25, 2.25, seek, {}, engine=eng)

    single_project = EpisodeProject.create("single_source_fades", str(ws))
    single_project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/single.wav", duration_sec=4.0),
        )
    )
    single_project.timeline.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
            fade_in_ms=100,
            fade_out_ms=100,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=2.0,
            source_end=3.0,
            timeline_start=1.5,
            fade_in_ms=100,
            fade_out_ms=100,
        ),
    ]
    single_full = ws / "artifacts" / "single_full.wav"
    single_seek = ws / "artifacts" / "single_seek.wav"
    render_track_segment(single_project, "host", 0.0, 2.5, single_full, {}, engine=eng)
    render_track_segment(single_project, "host", 0.25, 2.25, single_seek, {}, engine=eng)

    full_pcm = _read_pcm(full).astype(np.float32)
    seek_pcm = _read_pcm(seek).astype(np.float32)
    np.testing.assert_allclose(full_pcm, _read_pcm(single_full), atol=2)
    np.testing.assert_allclose(seek_pcm, _read_pcm(single_seek), atol=2)
    rate = 48_000

    def mean_abs(
        pcm: np.ndarray, start_sec: float, end_sec: float, *, origin: float = 0.0
    ) -> float:
        first = round((start_sec - origin) * rate)
        last = round((end_sec - origin) * rate)
        return float(np.abs(pcm[first:last]).mean())

    first_clip_level = mean_abs(full_pcm, 0.3, 0.5)
    second_clip_level = mean_abs(full_pcm, 1.8, 2.0)
    assert mean_abs(full_pcm, 0.0, 0.02) < first_clip_level * 0.25
    assert mean_abs(full_pcm, 0.98, 1.0) < first_clip_level * 0.25
    assert mean_abs(full_pcm, 1.5, 1.52) < second_clip_level * 0.25
    assert mean_abs(full_pcm, 2.48, 2.5) < second_clip_level * 0.25
    assert mean_abs(seek_pcm, 0.25, 0.27, origin=0.25) > first_clip_level * 0.8
    assert mean_abs(seek_pcm, 2.23, 2.25, origin=0.25) > second_clip_level * 0.8


@pytest.mark.parametrize(
    ("join_mode", "expected_duration", "fade_at_join"),
    [
        (ClipJoinMode.CUT, 2.0, False),
        (ClipJoinMode.FADE, 2.0, True),
        (ClipJoinMode.CROSSFADE, 1.8, False),
    ],
)
def test_multi_source_join_modes_keep_declared_audio_semantics(
    tmp_path: Path,
    join_mode: ClipJoinMode,
    expected_duration: float,
    fade_at_join: bool,
) -> None:
    import numpy as np

    from podcast_mcp.models import SourceRecording

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")

    ws = tmp_path / f"ws_multi_source_{join_mode.value}"
    raw = ws / "raw"
    a_pcm = _write_constant_pcm_wav(raw / "a.wav", duration_sec=1.0, amplitude=0.3)
    b_pcm = _write_constant_pcm_wav(raw / "b.wav", duration_sec=1.0, amplitude=0.6)
    _write_pcm_wav_bytes(raw / "single.wav", a_pcm + b_pcm)
    project = EpisodeProject.create("multi_source_join", str(ws))
    project.sources.extend(
        [
            SourceRecording(id="a", path="raw/a.wav", speaker="Host"),
            SourceRecording(id="b", path="raw/b.wav", speaker="Host"),
        ]
    )
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/a.wav", duration_sec=2.0),
        )
    )
    project.timeline.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.2,
            source_id="a",
            fade_out_ms=200,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=1.2,
            source_id="b",
            fade_in_ms=200,
            join_in_mode=join_mode,
        ),
    ]
    output = ws / "artifacts" / "joined.wav"
    render_track_from_timeline(project, project.tracks[0], output, {}, engine=eng)

    pcm = _read_pcm(output).astype(np.float32)
    single_project = EpisodeProject.create("single_source_join", str(ws))
    single_project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/single.wav", duration_sec=2.0),
        )
    )
    single_project.timeline.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.2,
            fade_out_ms=200,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=1.0,
            source_end=2.0,
            timeline_start=1.2,
            fade_in_ms=200,
            join_in_mode=join_mode,
        ),
    ]
    single_output = ws / "artifacts" / "single.wav"
    render_track_from_timeline(
        single_project, single_project.tracks[0], single_output, {}, engine=eng
    )
    single_pcm = _read_pcm(single_output).astype(np.float32)

    assert pcm.shape == single_pcm.shape
    np.testing.assert_allclose(pcm, single_pcm, atol=2)
    assert eng.probe(output).duration_sec == pytest.approx(expected_duration + 0.2, abs=0.02)
    join_window = float(np.abs(pcm[round(1.1 * 48_000) : round(1.2 * 48_000)]).mean())
    if fade_at_join:
        assert join_window < 0.3 * 0.3 * 32767
    else:
        assert join_window > 0.2 * 0.3 * 32767


def test_cut_join_drops_only_the_fades_at_that_join(tmp_path: Path) -> None:
    project = EpisodeProject.create("cutfades", str(tmp_path))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
            fade_out_ms=20,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=1.0,
            source_end=2.0,
            timeline_start=1.0,
            fade_in_ms=20,
            fade_out_ms=30,
            join_in_mode=ClipJoinMode.CUT,
        ),
        Clip(
            id="c",
            track_id="host",
            source_start=2.0,
            source_end=3.0,
            timeline_start=2.0,
            fade_in_ms=30,
            join_in_mode=ClipJoinMode.FADE,
        ),
    ]
    eng = MagicMock(spec=FFmpegEngine)
    eng.segments_after_edits.side_effect = lambda dur, *_a: [MagicMock(start=0.0, end=dur)]
    render_track_from_timeline(project, project.tracks[0], tmp_path / "out.wav", {}, engine=eng)
    placed = eng.render_timeline.call_args.args[2]
    fades = [(s.fade_in_sec, s.fade_out_sec) for s in placed]
    # a->b is a cut: a's fade-out and b's fade-in go; b->c is a fade: both stay.
    assert fades == [(0.0, 0.0), (0.0, pytest.approx(0.03)), (pytest.approx(0.03), 0.0)]


def test_first_clip_cut_mode_keeps_its_fade_in(tmp_path: Path) -> None:
    project = EpisodeProject.create("firstcutfadein", str(tmp_path))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
            fade_in_ms=20,
            fade_out_ms=0,
            join_in_mode=ClipJoinMode.CUT,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=1.0,
            source_end=2.0,
            timeline_start=1.0,
            fade_in_ms=0,
            join_in_mode=ClipJoinMode.FADE,
        ),
    ]
    eng = MagicMock(spec=FFmpegEngine)
    eng.segments_after_edits.side_effect = lambda dur, *_a: [MagicMock(start=0.0, end=dur)]
    render_track_from_timeline(project, project.tracks[0], tmp_path / "out.wav", {}, engine=eng)
    placed = eng.render_timeline.call_args.args[2]
    # The first clip has no join, so its leftover cut mode drops nothing.
    assert placed[0].fade_in_sec == pytest.approx(0.02)


def test_render_semantics_rev_bumped_for_per_join_cut() -> None:
    from podcast_mcp.engines.timeline_render import RENDER_SEMANTICS_REV

    assert RENDER_SEMANTICS_REV >= 3


def _multi_source_constant_project(
    tmp_path: Path,
    name: str,
    specs: list[tuple[str, float, float, float, dict[str, object]]],
) -> tuple[EpisodeProject, Path]:
    from podcast_mcp.models import SourceRecording

    ws = tmp_path / name
    raw = ws / "raw"
    sources = []
    clips = []
    for sid, timeline_start, duration, amplitude, clip_fields in specs:
        _write_constant_pcm_wav(raw / f"{sid}.wav", duration_sec=duration, amplitude=amplitude)
        sources.append(
            SourceRecording(id=sid, path=f"raw/{sid}.wav", speaker="Host", duration_sec=duration)
        )
        clips.append(
            Clip(
                id=sid,
                track_id="host",
                source_id=sid,
                source_start=0.0,
                source_end=duration,
                timeline_start=timeline_start,
                **clip_fields,
            )
        )
    project = EpisodeProject.create(name, str(ws))
    project.sources = sources
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"raw/{sources[0].id}.wav", duration_sec=specs[0][2]),
        )
    ]
    project.timeline.clips = clips
    return project, ws


def test_multi_source_segment_preserves_partial_overlapping_placements(tmp_path: Path) -> None:
    import numpy as np

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    project, ws = _multi_source_constant_project(
        tmp_path,
        "segment_overlap",
        [("a", 0.0, 1.0, 0.1, {}), ("b", 0.5, 1.0, 0.2, {})],
    )
    full_path = ws / "full.wav"
    render_track_from_timeline(project, project.tracks[0], full_path, {}, engine=eng)
    full = _read_pcm(full_path).astype(np.float32)
    rate = 48_000

    for start, end in ((0.4, 1.2), (0.6, 1.2)):
        segment_path = ws / f"segment-{start}.wav"
        render_track_segment(project, "host", start, end, segment_path, {}, engine=eng)
        segment = _read_pcm(segment_path).astype(np.float32)
        expected = full[round(start * rate) : round(end * rate)]
        assert segment.shape == expected.shape
        np.testing.assert_allclose(segment, expected, atol=2)
    overlap = full[round(0.6 * rate) : round(0.9 * rate)]
    assert np.mean(np.abs(overlap)) == pytest.approx(0.3 * 32767, abs=2)


def test_multi_source_segment_uses_cut_neighbor_beyond_window(tmp_path: Path) -> None:
    import numpy as np

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    project, ws = _multi_source_constant_project(
        tmp_path,
        "cut_neighbor",
        [
            ("a", 0.0, 1.0, 0.1, {}),
            ("b", 1.0, 1.0, 0.2, {"fade_out_ms": 200}),
            ("c", 2.0, 1.0, 0.3, {"join_in_mode": ClipJoinMode.CUT}),
        ],
    )
    full_path = ws / "full.wav"
    segment_path = ws / "segment.wav"
    render_track_from_timeline(project, project.tracks[0], full_path, {}, engine=eng)
    full = _read_pcm(full_path).astype(np.float32)
    project.source_by_id("c").path = "raw/missing-outside-window.wav"
    render_track_segment(project, "host", 0.0, 2.0, segment_path, {}, engine=eng)
    segment = _read_pcm(segment_path).astype(np.float32)
    expected = full[: 2 * 48_000]
    assert segment.shape == expected.shape
    np.testing.assert_allclose(segment, expected, atol=2)
    assert np.mean(np.abs(segment[-round(0.02 * 48_000) :])) == pytest.approx(0.2 * 32767, abs=2)


def test_multi_source_nested_overlap_keeps_absolute_timeline_clock(tmp_path: Path) -> None:
    import numpy as np

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    project, ws = _multi_source_constant_project(
        tmp_path,
        "nested_overlap",
        [("a", 0.0, 3.0, 0.1, {}), ("b", 0.5, 1.0, 0.2, {}), ("c", 2.0, 1.0, 0.3, {})],
    )
    output = ws / "nested.wav"
    render_track_from_timeline(project, project.tracks[0], output, {}, engine=eng)
    pcm = _read_pcm(output).astype(np.float32)
    assert pcm.shape == (3 * 48_000,)
    c_region = pcm[round(2.2 * 48_000) : round(2.4 * 48_000)]
    assert np.mean(np.abs(c_region)) == pytest.approx(0.4 * 32767, abs=2)


def _renderer_final_project(
    root: Path,
    sources: list[tuple[str, float, float]],
    clips: list[tuple[str, str, float, float, float]],
) -> EpisodeProject:
    from podcast_mcp.models import SourceRecording

    source_rows = []
    for source_id, duration, amplitude in sources:
        relative_path = f"raw/{source_id}.wav"
        _write_constant_pcm_wav(
            root / relative_path,
            duration_sec=duration,
            amplitude=amplitude,
        )
        source_rows.append(
            SourceRecording(
                id=source_id,
                path=relative_path,
                speaker="Host",
                duration_sec=duration,
            )
        )
    project = EpisodeProject.create("renderer_final_segment", str(root))
    project.sources = source_rows
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=source_rows[0].path, duration_sec=max(s[1] for s in sources)),
        )
    ]
    project.timeline.clips = [
        Clip(
            id=clip_id,
            track_id="host",
            source_id=source_id,
            source_start=source_start,
            source_end=source_end,
            timeline_start=timeline_start,
        )
        for clip_id, source_id, source_start, source_end, timeline_start in clips
    ]
    return project


def test_same_source_overlap_segment_matches_full_window_with_other_recording_outside_window(
    tmp_path: Path,
) -> None:
    import numpy as np

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    ws = tmp_path / "same_source_overlap"
    project = _renderer_final_project(
        ws,
        [("a", 1.0, 0.1), ("outside", 1.0, 0.3)],
        [
            ("a-first", "a", 0.0, 1.0, 0.0),
            ("a-overlap", "a", 0.0, 1.0, 0.5),
            ("outside-window", "outside", 0.0, 1.0, 2.0),
        ],
    )
    full_path = ws / "full.wav"
    segment_path = ws / "segment.wav"
    render_track_from_timeline(project, project.tracks[0], full_path, {}, engine=eng)
    expected = _read_pcm(full_path).astype(np.float32)[: round(1.5 * 48_000)]
    (ws / "raw" / "outside.wav").unlink()

    render_track_segment(project, "host", 0.0, 1.5, segment_path, {}, engine=eng)
    segment = _read_pcm(segment_path).astype(np.float32)
    assert segment.shape == expected.shape
    np.testing.assert_array_equal(segment, expected)
    overlap = segment[round(0.6 * 48_000) : round(0.9 * 48_000)]
    assert np.mean(np.abs(overlap)) == pytest.approx(0.2 * 32767, abs=2)


def test_one_source_segment_preserves_head_and_tail_holes_with_other_recording_outside_window(
    tmp_path: Path,
) -> None:
    import numpy as np

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    ws = tmp_path / "one_source_head_tail"
    project = _renderer_final_project(
        ws,
        [("inside", 1.0, 0.2), ("outside", 1.0, 0.3)],
        [
            ("inside", "inside", 0.0, 1.0, 2.0),
            ("outside-window", "outside", 0.0, 1.0, 3.5),
        ],
    )
    full_path = ws / "full.wav"
    segment_path = ws / "segment.wav"
    render_track_from_timeline(project, project.tracks[0], full_path, {}, engine=eng)
    expected = _read_pcm(full_path).astype(np.float32)[round(1.5 * 48_000) : round(3.5 * 48_000)]
    (ws / "raw" / "outside.wav").unlink()

    render_track_segment(project, "host", 1.5, 3.5, segment_path, {}, engine=eng)
    segment = _read_pcm(segment_path).astype(np.float32)
    assert segment.shape == expected.shape == (round(2.0 * 48_000),)
    np.testing.assert_array_equal(segment, expected)
    assert np.max(np.abs(segment[: round(0.5 * 48_000)])) == 0
    assert np.mean(np.abs(segment[round(0.6 * 48_000) : round(1.4 * 48_000)])) == pytest.approx(
        0.2 * 32767, abs=2
    )
    assert np.max(np.abs(segment[round(1.5 * 48_000) :])) == 0


def test_pure_single_source_segment_preserves_internal_timeline_hole_pcm(
    tmp_path: Path,
) -> None:
    import numpy as np

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    ws = tmp_path / "pure_single_source_gap"
    _write_constant_pcm_wav(ws / "raw" / "host.wav", duration_sec=2.0, amplitude=0.2)
    project = EpisodeProject.create("pure_single_source_gap", str(ws))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    project.timeline.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=0.5, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=1.0, source_end=1.5, timeline_start=1.0),
    ]
    full_path = ws / "full.wav"
    segment_path = ws / "segment.wav"
    render_track_from_timeline(project, project.tracks[0], full_path, {}, engine=eng)
    render_track_segment(project, "host", 0.0, 1.5, segment_path, {}, engine=eng)
    full = _read_pcm(full_path)
    segment = _read_pcm(segment_path)
    assert segment.shape == full.shape == (round(1.5 * 48_000),)
    np.testing.assert_array_equal(segment, full)
    assert np.max(np.abs(segment[round(0.5 * 48_000) : round(1.0 * 48_000)])) == 0
