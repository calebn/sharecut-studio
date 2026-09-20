from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.engines.ffmpeg import (
    AudioProbe,
    FFmpegEngine,
    RenderSegment,
    _annotate_vf,
    _escape_drawtext,
)
from podcast_mcp.models import (
    AutomationEnvelope,
    AutomationPoint,
    EditDecision,
    EditDecisionType,
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
    TrackRole,
)


def test_probe_sample_wav(sample_wav: Path):
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    probe = eng.probe(sample_wav)
    assert probe.duration_sec > 1.0
    assert probe.sample_rate >= 8000


def test_probe_untrusted_adds_protocol_whitelist(tmp_path: Path):
    eng = FFmpegEngine(ffprobe="ffprobe")
    fake = {
        "streams": [{"codec_type": "audio", "sample_rate": "48000", "channels": 1}],
        "format": {"duration": "1.0"},
    }
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        run.return_value = MagicMock(stdout=json.dumps(fake), returncode=0)
        eng.probe(tmp_path / "x.wav", untrusted=True)
    cmd = run.call_args[0][0]
    assert "-protocol_whitelist" in cmd
    assert "file,crypto,data" in cmd


def test_build_track_filter_highpass_and_compressor():
    eng = FFmpegEngine()
    chain = ProcessingChain(
        track_id="host",
        effects=[
            ProcessingEffect(effect="highpass", params={"frequency": 100}),
            ProcessingEffect(
                effect="acompressor",
                params={
                    "threshold_db": -20,
                    "ratio": 2,
                    "attack_ms": 12,
                    "release_ms": 180,
                    "makeup_db": 2,
                },
            ),
        ],
    )
    filt = eng.build_track_filter(chain, None)
    assert "highpass" in filt
    assert "acompressor=threshold=-20dB:ratio=2:attack=12:release=180:makeup=2.0" in filt


def test_build_track_filter_compressor_omits_zero_makeup():
    eng = FFmpegEngine()
    chain = ProcessingChain(
        track_id="host",
        effects=[
            ProcessingEffect(
                effect="acompressor",
                params={"threshold_db": -18, "ratio": 3, "makeup_db": 0},
            ),
        ],
    )
    filt = eng.build_track_filter(chain, None)
    assert "acompressor=threshold=-18dB:ratio=3:attack=15:release=150" in filt
    assert "makeup=" not in filt


def test_build_track_filter_skips_bypassed():
    eng = FFmpegEngine()
    chain = ProcessingChain(
        track_id="host",
        effects=[
            ProcessingEffect(effect="highpass", params={"frequency": 100}),
            ProcessingEffect(
                effect="acompressor",
                params={"threshold_db": -20, "ratio": 2},
                bypass=True,
            ),
        ],
    )
    filt = eng.build_track_filter(chain, None)
    assert "highpass" in filt
    assert "acompressor" not in filt


def test_build_track_filter_all_bypassed_is_anull():
    eng = FFmpegEngine()
    chain = ProcessingChain(
        track_id="host",
        effects=[
            ProcessingEffect(effect="highpass", params={"frequency": 80}, bypass=True),
        ],
    )
    assert eng.build_track_filter(chain, None) == "anull"


def test_build_track_filter_envelope():
    eng = FFmpegEngine()
    env = AutomationEnvelope(
        track_id="music",
        points=[
            AutomationPoint(time=0.0, value=0.0),
            AutomationPoint(time=1.0, value=1.0),
        ],
    )
    filt = eng.build_track_filter(None, env)
    assert "volume" in filt


def test_render_single_segment(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    out = tmp_path / "cut.wav"
    from podcast_mcp.engines.ffmpeg import RenderSegment

    eng.render_track_to_file(
        sample_wav,
        out,
        [RenderSegment(0.0, 1.0)],
        crossfade_ms=5,
        af_chain="anull",
    )
    assert out.is_file()
    assert eng.probe(out).duration_sec > 0.4


def test_apply_gain(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    out = tmp_path / "gain.wav"
    eng.apply_gain(sample_wav, out, -3.0)
    assert out.is_file()


def test_check_available_failure_paths():
    eng = FFmpegEngine()
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        run.return_value = MagicMock(returncode=1, stderr="broken", stdout="")
        ok, msg = eng.check_available()
        assert ok is False
        assert "broken" in msg

    with patch(
        "podcast_mcp.engines.ffmpeg.run",
        side_effect=FileNotFoundError,
    ):
        ok, msg = eng.check_available()
        assert ok is False
        assert "not found" in msg

    with patch(
        "podcast_mcp.engines.ffmpeg.run",
        side_effect=subprocess.TimeoutExpired("ffmpeg", 10),
    ):
        ok, msg = eng.check_available()
        assert ok is False
        assert "timed out" in msg


def test_probe_parsed_from_json(tmp_path: Path):
    eng = FFmpegEngine()
    wav = tmp_path / "x.wav"
    wav.write_bytes(b"x")
    payload = {
        "format": {"duration": "3.5"},
        "streams": [
            {"codec_type": "video"},
            {"codec_type": "audio", "sample_rate": "44100", "channels": 2},
        ],
    }
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        run.return_value = MagicMock(stdout=json.dumps(payload), returncode=0)
        probe = eng.probe(wav)
    assert probe.duration_sec == 3.5
    assert probe.sample_rate == 44100
    assert probe.channels == 2


def test_segments_after_edits_edge_cases():
    eng = FFmpegEngine()
    edits = [
        EditDecision(
            id="1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.5,
            end=0.8,
            applied=True,
        ),
        EditDecision(
            id="2",
            track_id="guest",
            type=EditDecisionType.REMOVE,
            start=0.0,
            end=0.2,
            applied=True,
        ),
        EditDecision(
            id="3",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.2,
            end=0.4,
            applied=False,
        ),
    ]
    segs = eng.segments_after_edits(2.0, edits, "host")
    assert len(segs) == 2
    assert segs[0].end == 0.5
    assert segs[1].start == 0.8

    full = eng.segments_after_edits(1.5, [], "host")
    assert len(full) == 1
    assert full[0].start == 0.0 and full[0].end == 1.5


def test_build_track_filter_all_effects_and_anull():
    eng = FFmpegEngine()
    chain = ProcessingChain(
        track_id="host",
        effects=[
            ProcessingEffect(effect="loudnorm", params={"integrated_lufs": -14}),
            ProcessingEffect(effect="afftdn", params={"nr": 10, "nf": -20}),
            ProcessingEffect(effect="bandreject", params={"f": 7000, "w": 2000}),
            ProcessingEffect(
                effect="agate",
                params={
                    "threshold_db": -28,
                    "range_db": -18,
                    "attack_ms": 4,
                    "release_ms": 40,
                },
            ),
            ProcessingEffect(
                effect="equalizer",
                params={"f": 2000, "t": "h", "w": 2.0, "g": 3},
            ),
        ],
    )
    filt = eng.build_track_filter(chain, None)
    assert "loudnorm" in filt
    assert "afftdn" in filt
    assert "bandreject" in filt
    assert "agate" in filt
    assert "equalizer" in filt
    assert eng.build_track_filter(None, None) == "anull"


def test_volume_expression_variants():
    eng = FFmpegEngine()
    assert eng._volume_expression(AutomationEnvelope(track_id="m", points=[])) == "1"
    flat = AutomationEnvelope(
        track_id="m",
        points=[AutomationPoint(time=1.0, value=0.5)],
    )
    assert "gte(t,1.0)" in eng._volume_expression(flat)
    overlap = AutomationEnvelope(
        track_id="m",
        points=[
            AutomationPoint(time=0.0, value=0.0),
            AutomationPoint(time=0.0, value=1.0),
            AutomationPoint(time=2.0, value=1.0),
        ],
    )
    expr = eng._volume_expression(overlap)
    assert "between(t" in expr or "gte(t" in expr


def test_render_track_to_file_no_segments_raises(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    with pytest.raises(ValueError, match="no segments"):
        eng.render_track_to_file(sample_wav, tmp_path / "out.wav", [], 0, "anull")


def test_render_timeline_no_segments_raises(sample_wav: Path, tmp_path: Path):
    from podcast_mcp.engines.ffmpeg import PlacedSegment

    eng = FFmpegEngine()
    with pytest.raises(ValueError, match="no segments"):
        eng.render_timeline(sample_wav, tmp_path / "out.wav", [], "anull")

    assert PlacedSegment(0.0, 1.0).crossfade_prev_sec == 0.0


def test_render_timeline_single_segment_applies_fx_once(sample_wav: Path, tmp_path: Path):
    from podcast_mcp.engines.ffmpeg import PlacedSegment

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    out = tmp_path / "one.wav"
    commands: list[str] = []
    import podcast_mcp.engines.ffmpeg as ff

    real_run = ff.run

    def capture_run(cmd, *args, **kwargs):
        commands.append(" ".join(str(x) for x in cmd))
        return real_run(cmd, *args, **kwargs)

    with patch.object(ff, "run", side_effect=capture_run):
        eng.render_timeline(
            sample_wav,
            out,
            [PlacedSegment(0.0, 0.5, fade_in_sec=0.05, fade_out_sec=0.05)],
            "highpass=f=80",
        )
    assert len(commands) == 1
    assert "atrim=start=0.0:end=0.5" in commands[0]
    assert "highpass=f=80[out]" in commands[0]
    assert out.is_file()


def test_render_multi_segment_with_fades(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    out = tmp_path / "multi.wav"

    def fake_run(cmd, **kwargs):
        out_path = Path(cmd[-1])
        if out_path.suffix == ".wav":
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(b"RIFF")
        return MagicMock(returncode=0)

    segments = [RenderSegment(0.0, 0.5), RenderSegment(0.8, 1.2)]
    with patch("podcast_mcp.engines.ffmpeg.run", side_effect=fake_run):
        result = eng.render_track_to_file(
            sample_wav,
            out,
            segments,
            crossfade_ms=5,
            af_chain="highpass=f=80",
            fade_in_sec=0.05,
            fade_out_sec=0.05,
        )
    assert result == out
    assert out.is_file()


def test_mix_tracks_empty_and_single(tmp_path: Path, sample_wav: Path):
    eng = FFmpegEngine()
    with pytest.raises(ValueError, match="no tracks"):
        eng.mix_tracks([], tmp_path / "mix.wav")

    out = tmp_path / "solo.wav"
    with patch("podcast_mcp.engines.ffmpeg.shutil.copy2") as copy2:
        eng.mix_tracks([(sample_wav, 0.0)], out)
    copy2.assert_called_once_with(sample_wav, out)


def test_mix_tracks_single_applies_gain(tmp_path: Path, sample_wav: Path):
    eng = FFmpegEngine()
    out = tmp_path / "solo_gain.wav"
    with patch.object(eng, "apply_gain", return_value=out) as apply_gain:
        result = eng.mix_tracks([(sample_wav, -6.0)], out)
    assert result == out
    apply_gain.assert_called_once_with(sample_wav, out, -6.0)


def test_export_audio_options(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    out = tmp_path / "out.ogg"
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        run.return_value = MagicMock(returncode=0)
        eng.export_audio(
            sample_wav,
            out,
            codec="libvorbis",
            format="ogg",
            bitrate_kbps=96,
            sample_rate=22050,
            channels=2,
            metadata={"title": "test"},
            extra_args=["-vn"],
        )
    cmd = run.call_args[0][0]
    assert "-f" in cmd and "ogg" in cmd
    assert "-codec:a" in cmd
    assert "-b:a" in cmd and "96k" in cmd
    assert "-ar" in cmd and "22050" in cmd
    assert "-ac" in cmd and "2" in cmd
    assert any("title=test" in arg for arg in cmd)
    assert "-vn" in cmd


def test_measure_loudness_patterns(tmp_path: Path):
    eng = FFmpegEngine()
    wav = tmp_path / "x.wav"
    wav.write_bytes(b"x")

    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        run.return_value = MagicMock(
            stderr="Summary:\n  I:         -18.2 LUFS\n", stdout="", returncode=0
        )
        assert eng.measure_loudness(wav) == pytest.approx(-18.2)

    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        run.return_value = MagicMock(
            stderr="Integrated loudness: -20.5 LUFS", stdout="", returncode=0
        )
        assert eng.measure_loudness(wav) == pytest.approx(-20.5)

    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        run.return_value = MagicMock(stderr="no loudness", stdout="", returncode=0)
        assert eng.measure_loudness(wav) is None


_LOUDNORM_JSON_STDERR = """
[Parsed_loudnorm_0 @ 0x0]
{
    "input_i" : "-23.71",
    "input_tp" : "-6.54",
    "input_lra" : "18.86",
    "input_thresh" : "-34.24",
    "output_i" : "-16.02",
    "output_tp" : "-1.50",
    "output_lra" : "8.00",
    "output_thresh" : "-26.42",
    "normalization_type" : "dynamic",
    "target_offset" : "-0.02"
}
"""


def test_measure_loudnorm_stats_parses_json(tmp_path: Path):
    eng = FFmpegEngine()
    wav = tmp_path / "x.wav"
    wav.write_bytes(b"x")
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        run.return_value = MagicMock(stderr=_LOUDNORM_JSON_STDERR, stdout="", returncode=0)
        stats = eng.measure_loudnorm_stats(wav, -16.0, -1.5)
    assert stats == {
        "input_i": -23.71,
        "input_tp": -6.54,
        "input_lra": 18.86,
        "input_thresh": -34.24,
        "target_offset": -0.02,
    }


def test_measure_loudnorm_stats_returns_none_on_bad_output(tmp_path: Path):
    eng = FFmpegEngine()
    wav = tmp_path / "x.wav"
    wav.write_bytes(b"x")
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        run.return_value = MagicMock(stderr="nothing useful here", stdout="", returncode=0)
        assert eng.measure_loudnorm_stats(wav, -16.0, -1.5) is None


def test_measure_loudness_full_parses_summary(tmp_path: Path):
    eng = FFmpegEngine()
    wav = tmp_path / "x.wav"
    wav.write_bytes(b"x")
    summary = (
        "Summary:\n\n  Integrated loudness:\n    I:         -16.0 LUFS\n\n"
        "  Loudness range:\n    LRA:         7.0 LU\n\n  True peak:\n    Peak:       -1.4 dBFS\n"
    )
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        run.return_value = MagicMock(stderr=summary, stdout="", returncode=0)
        result = eng.measure_loudness_full(wav)
    assert result == {"integrated_lufs": -16.0, "true_peak_db": -1.4, "lra": 7.0}
    cmd = run.call_args[0][0]
    af = cmd[cmd.index("-af") + 1]
    assert "peak=true" in af, "ebur128 must request peak=true or no True peak section is printed"


def test_measure_loudness_full_returns_none_without_integrated(tmp_path: Path):
    eng = FFmpegEngine()
    wav = tmp_path / "x.wav"
    wav.write_bytes(b"x")
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        run.return_value = MagicMock(stderr="nothing useful", stdout="", returncode=0)
        assert eng.measure_loudness_full(wav) is None


def test_master_loudnorm_two_pass_uses_measured_values(tmp_path: Path):
    eng = FFmpegEngine()
    src = tmp_path / "premix.wav"
    src.write_bytes(b"x")
    out = tmp_path / "mastered.wav"
    with (
        patch.object(
            eng,
            "probe",
            return_value=AudioProbe(duration_sec=1.0, sample_rate=44100, channels=1),
        ),
        patch("podcast_mcp.engines.ffmpeg.run") as run,
    ):
        run.side_effect = [
            MagicMock(stderr=_LOUDNORM_JSON_STDERR, stdout="", returncode=0),
            MagicMock(returncode=0),
        ]
        eng.master_loudnorm(src, out, integrated_lufs=-16.0, true_peak_db=-1.5)
    assert run.call_count == 2
    second_cmd = run.call_args_list[1][0][0]
    af = second_cmd[second_cmd.index("-af") + 1]
    assert "measured_I=-23.71" in af
    assert "linear=true" in af
    assert second_cmd[second_cmd.index("-ar") + 1] == "44100"
    assert second_cmd[second_cmd.index("-ac") + 1] == "1"


def test_master_loudnorm_falls_back_when_measure_fails(tmp_path: Path):
    eng = FFmpegEngine()
    src = tmp_path / "premix.wav"
    src.write_bytes(b"x")
    out = tmp_path / "mastered.wav"
    with (
        patch.object(
            eng,
            "probe",
            return_value=AudioProbe(duration_sec=1.0, sample_rate=48000, channels=2),
        ),
        patch.object(eng, "measure_loudnorm_stats", return_value=None),
    ):
        with patch("podcast_mcp.engines.ffmpeg.run") as run:
            run.return_value = MagicMock(returncode=0)
            eng.master_loudnorm(src, out, integrated_lufs=-16.0, true_peak_db=-1.5)
    cmd = run.call_args[0][0]
    af = cmd[cmd.index("-af") + 1]
    assert "measured_I" not in af
    assert af == "loudnorm=I=-16.0:TP=-1.5:LRA=11.0"
    assert cmd[cmd.index("-ar") + 1] == "48000"
    assert cmd[cmd.index("-ac") + 1] == "2"


def test_build_track_filter_deesser():
    eng = FFmpegEngine()
    chain = ProcessingChain(
        track_id="host",
        effects=[ProcessingEffect(effect="deesser", params={"intensity": 0.7, "frequency": 0.4})],
    )
    filt = eng.build_track_filter(chain, None)
    assert filt == "deesser=i=0.7:f=0.4"


def test_build_track_filter_arnndn_uses_bootstrapped_model(tmp_path: Path):
    model = tmp_path / "model.rnnn"
    model.write_bytes(b"fake")
    eng = FFmpegEngine()
    chain = ProcessingChain(
        track_id="host",
        effects=[ProcessingEffect(effect="arnndn", params={"model": str(model)})],
    )
    filt = eng.build_track_filter(chain, None)
    assert filt == f"arnndn=m={model}"


def test_build_track_filter_arnndn_resolves_model_when_unset(tmp_path: Path):
    model = tmp_path / "resolved.rnnn"
    model.write_bytes(b"fake")
    eng = FFmpegEngine()
    chain = ProcessingChain(track_id="host", effects=[ProcessingEffect(effect="arnndn", params={})])
    with patch("podcast_mcp.engines.ffmpeg.resolve_rnnoise_model", return_value=model):
        filt = eng.build_track_filter(chain, None)
    assert filt == f"arnndn=m={model}"


def test_build_track_filter_arnndn_escapes_colons_in_path():
    eng = FFmpegEngine()
    chain = ProcessingChain(
        track_id="host",
        effects=[ProcessingEffect(effect="arnndn", params={"model": "C:/models/rn.rnnn"})],
    )
    filt = eng.build_track_filter(chain, None)
    assert filt == "arnndn=m=C\\:/models/rn.rnnn"


def test_ffmpeg_engine_defaults_resolve_binaries():
    with patch("podcast_mcp.engines.ffmpeg.resolve_ffmpeg", return_value="/resolved/ffmpeg"):
        with patch("podcast_mcp.engines.ffmpeg.resolve_ffprobe", return_value="/resolved/ffprobe"):
            eng = FFmpegEngine()
    assert eng.ffmpeg == "/resolved/ffmpeg"
    assert eng.ffprobe == "/resolved/ffprobe"


def test_ffmpeg_engine_explicit_paths_override_resolver():
    eng = FFmpegEngine(ffmpeg="/custom/ffmpeg", ffprobe="/custom/ffprobe")
    assert eng.ffmpeg == "/custom/ffmpeg"
    assert eng.ffprobe == "/custom/ffprobe"


def test_render_spectrogram(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    out_png = tmp_path / "spec.png"
    eng.render_spectrogram(sample_wav, out_png)
    assert out_png.is_file()


def test_visual_diagnostics_bound_ffmpeg_threads(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        run.return_value = MagicMock(returncode=0)
        eng.render_spectrogram(sample_wav, tmp_path / "spec.png")
        spectrogram_cmd = run.call_args[0][0]
        eng.render_showwavespic(sample_wav, tmp_path / "wave.png")
        waveform_cmd = run.call_args[0][0]
        eng.render_stacked_showwavespic([sample_wav, sample_wav], tmp_path / "stack.png")
        stacked_cmd = run.call_args[0][0]

    for cmd in (spectrogram_cmd, waveform_cmd, stacked_cmd):
        assert cmd[cmd.index("-threads") + 1] == "1"
        assert cmd[cmd.index("-filter_threads") + 1] == "1"
        assert cmd[cmd.index("-filter_complex_threads") + 1] == "1"


def test_extract_segment(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    out = tmp_path / "clip.wav"
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        run.return_value = MagicMock(returncode=0)
        result = eng.extract_segment(sample_wav, out, 0.5, 1.0)
    assert result == out
    cmd = run.call_args[0][0]
    assert "-ss" in cmd and "0.5" in cmd
    assert "-t" in cmd


def test_render_showwavespic_with_segment(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    png = tmp_path / "wave.png"
    with (
        patch.object(eng, "extract_segment") as extract,
        patch("podcast_mcp.engines.ffmpeg.run") as run,
    ):
        extract.return_value = tmp_path / "seg.wav"
        run.return_value = MagicMock(returncode=0)
        result = eng.render_showwavespic(sample_wav, png, start_sec=0.0, duration_sec=0.5)
    extract.assert_called_once()
    assert result == png


def test_render_showwavespic_full_file(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    png = tmp_path / "wave.png"
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        run.return_value = MagicMock(returncode=0)
        result = eng.render_showwavespic(sample_wav, png)
    assert result == png


def test_render_stacked_showwavespic(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    png = tmp_path / "stack.png"
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        run.return_value = MagicMock(returncode=0)
        result = eng.render_stacked_showwavespic([sample_wav, sample_wav], png)
    assert result == png
    fc = run.call_args[0][0]
    assert "vstack" in fc[fc.index("-filter_complex") + 1]

    with pytest.raises(ValueError, match="no inputs"):
        eng.render_stacked_showwavespic([], png)


def test_render_dialogue_track_delegates(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.models import Clip, load_project, save_project

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
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)
    out = tmp_workspace / "rendered.wav"
    eng = FFmpegEngine()
    with patch(
        "podcast_mcp.engines.timeline_render.render_track_from_timeline",
        return_value=out,
    ) as render:
        result = eng.render_dialogue_track(proj, proj.tracks[0], out, {})
    render.assert_called_once()
    assert result == out


def test_join_audio_parts_defaults_to_concat(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    p1 = tmp_path / "a.wav"
    p2 = tmp_path / "b.wav"
    eng.render_track_to_file(sample_wav, p1, [RenderSegment(0.0, 0.5)], 10, "anull")
    eng.render_track_to_file(sample_wav, p2, [RenderSegment(0.5, 1.0)], 10, "anull")
    out = tmp_path / "joined_default.wav"
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        eng.join_audio_parts([p1, p2], out)
        cmd = " ".join(str(x) for x in run.call_args[0][0])
        assert "concat" in cmd
    assert not (tmp_path / ".concat_joined_default.txt").exists()


def test_join_audio_parts_single_file(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    out = tmp_path / "single.wav"
    eng.join_audio_parts([sample_wav], out)
    assert out.is_file()
    with pytest.raises(ValueError, match="no parts"):
        eng.join_audio_parts([], tmp_path / "none.wav")


def test_join_audio_parts_concat_without_crossfade(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    p1 = tmp_path / "a.wav"
    p2 = tmp_path / "b.wav"
    eng.render_track_to_file(sample_wav, p1, [RenderSegment(0.0, 0.5)], 10, "anull")
    eng.render_track_to_file(sample_wav, p2, [RenderSegment(0.5, 1.0)], 10, "anull")
    out = tmp_path / "joined_hard.wav"
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        eng.join_audio_parts([p1, p2], out, crossfade_ms_between=[0])
        cmd = " ".join(str(x) for x in run.call_args[0][0])
        assert "concat" in cmd
        assert "acrossfade" not in cmd
    assert not (tmp_path / ".concat_joined_hard.txt").exists()


def test_join_audio_parts_uses_acrossfade(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    p1 = tmp_path / "a.wav"
    p2 = tmp_path / "b.wav"
    eng.render_track_to_file(sample_wav, p1, [RenderSegment(0.0, 0.5)], 10, "anull")
    eng.render_track_to_file(sample_wav, p2, [RenderSegment(0.5, 1.0)], 10, "anull")
    out = tmp_path / "joined.wav"
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        eng.join_audio_parts([p1, p2], out, crossfade_ms_between=[40])
        cmd = " ".join(str(x) for x in run.call_args[0][0])
        assert "acrossfade" in cmd


def test_pad_end_silence_extends_duration(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    out = tmp_path / "padded.wav"
    eng.pad_end_silence(sample_wav, out, 3.0)
    assert eng.probe(out).duration_sec == pytest.approx(3.0, abs=0.05)
    with pytest.raises(ValueError, match="positive"):
        eng.pad_end_silence(sample_wav, tmp_path / "bad.wav", 0)


def test_annotate_vf_omits_drawtext_unless_requested() -> None:
    marks = [{"x": 0.28, "label": "cut1", "kind": "pending_edit"}]
    boxes = _annotate_vf(
        marks,
        plot_width=1200,
        window_start=2.0,
        window_end=6.0,
        font=Path("/tmp/Arial.ttf"),
        use_drawtext=False,
    )
    assert "drawbox" in boxes
    assert "drawtext" not in boxes
    labeled = _annotate_vf(
        marks,
        plot_width=1200,
        window_start=2.0,
        window_end=6.0,
        font=Path("/tmp/Arial.ttf"),
        use_drawtext=True,
    )
    assert "drawtext" in labeled
    assert "cut1" in labeled
    empty = _annotate_vf(
        [],
        plot_width=1200,
        window_start=None,
        window_end=None,
        font=None,
        use_drawtext=False,
    )
    assert empty == ""


def test_escape_drawtext_strips_c0_controls() -> None:
    escaped = _escape_drawtext("hi\nthere\x01x")
    assert "\n" not in escaped
    assert "\x01" not in escaped
    assert "hi" in escaped


def test_generate_tone_writes_wav(tmp_path: Path) -> None:
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    dest = tmp_path / "tone.wav"
    out = eng.generate_tone(dest, duration_sec=0.2, freq_hz=440.0, gain_db=-12.0)
    assert out.is_file()
    assert out.stat().st_size > 0


def test_annotate_time_marks_writes_png(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    png = tmp_path / "wave.png"
    eng.render_showwavespic(sample_wav, png, start_sec=0.0, duration_sec=1.0)
    out = tmp_path / "wave_marked.png"
    result = eng.annotate_time_marks(
        png,
        [{"x": 0.28, "label": "cut1", "kind": "pending_edit"}],
        out,
        window_start=2.0,
        window_end=6.0,
    )
    assert result.is_file()
    assert result.stat().st_size > 0


def test_annotate_time_marks_missing_png(tmp_path: Path):
    eng = FFmpegEngine()
    with pytest.raises(FileNotFoundError, match="png not found"):
        eng.annotate_time_marks(tmp_path / "missing.png", [], tmp_path / "out.png")


def test_overlay_png_returns_false_on_bad_filter(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    png = tmp_path / "wave.png"
    eng.render_showwavespic(sample_wav, png, start_sec=0.0, duration_sec=1.0)
    assert eng._overlay_png(png, tmp_path / "out.png", "not_a_real_filter") is False


def test_filter_names_cached_and_empty_on_error():
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    first = eng._filter_names()
    assert "drawbox" in first
    assert eng._filter_names() is first
    broken = FFmpegEngine()
    with patch("podcast_mcp.engines.ffmpeg.run", side_effect=FileNotFoundError):
        assert broken._filter_names() == set()
        assert broken._has_filter("drawbox") is False


def test_annotate_retries_boxes_when_drawtext_overlay_fails(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    png = tmp_path / "wave.png"
    eng.render_showwavespic(sample_wav, png, start_sec=0.0, duration_sec=1.0)
    out = tmp_path / "marked.png"
    vfs: list[str] = []

    def overlay(_png: Path, _out: Path, vf: str) -> bool:
        vfs.append(vf)
        return "drawtext" not in vf

    with (
        patch.object(FFmpegEngine, "_has_filter", return_value=True),
        patch.object(FFmpegEngine, "_overlay_png", side_effect=overlay),
        patch("podcast_mcp.engines.ffmpeg._drawtext_font", return_value=Path("/tmp/Arial.ttf")),
    ):
        result = eng.annotate_time_marks(
            png,
            [{"x": 0.2, "label": "cut1", "kind": "pending_edit"}],
            out,
            window_start=1.0,
            window_end=2.0,
        )
    assert result == out
    assert any("drawtext" in vf for vf in vfs)
    assert any("drawtext" not in vf and "drawbox" in vf for vf in vfs)


def test_annotate_time_marks_empty_copies_png(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    png = tmp_path / "wave.png"
    eng.render_showwavespic(sample_wav, png, start_sec=0.0, duration_sec=1.0)
    out = tmp_path / "copy.png"
    with patch.object(FFmpegEngine, "_has_filter", return_value=False):
        result = eng.annotate_time_marks(png, [], out)
    assert result.is_file()
    assert result.read_bytes() == png.read_bytes()
    same = eng.annotate_time_marks(png, [], png)
    assert same == png
