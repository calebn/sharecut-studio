"""``test_ffmpeg_engine.py`` run again on an ``in_process`` host row with a fake backend.

Tests that patch the engine's ``run``/``popen`` see the sentinel in the argv they assert; any
that reaches ``subprocess`` fails. Tests that need real media output or explicit binary
paths, or a session fixture that resolves the desktop pair, are dropped here (``DESKTOP_ONLY``) and belong to the device smoke test.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import ffmpeg as module
from podcast_mcp.util import process
from podcast_mcp.util.host_platform import IOS
from test_ffmpeg_engine import *  # noqa: F403
from test_process_in_process import FakeBackend

DESKTOP_ONLY = {
    "test_check_available_failure_paths",
    "test_check_available_handles_empty_version_output",
    "test_check_available_refreshes_live_pair_after_cached_probe_failure",
    "test_ffmpeg_engine_rejects_invalid_explicit_pair",
    "test_ffmpeg_engine_constructor_override_wins_per_slot",
    "test_real_wav_and_mp3_exports_decode",
    "test_concat_with_gap_real_round_trip_length_is_the_sum",
    "test_real_mix_true_peak_ceiling_after_independent_4x_resample",
    "test_apply_gain",
    "test_mix_tracks_single_applies_gain",
    "test_render_timeline_single_segment_applies_fx_once",
    "test_export_audio_options",
    "test_mix_tracks_empty_and_single",
    "test_probe_sample_wav",
    "test_render_showwavespic_with_segment",
    "test_render_spectrogram",
    "test_render_showwavespic_full_file",
    "test_join_audio_parts_defaults_to_concat",
    "test_join_audio_parts_uses_acrossfade",
    "test_join_audio_parts_single_file",
    "test_visual_diagnostics_bound_ffmpeg_threads",
    "test_render_stacked_showwavespic",
    "test_pad_end_silence_extends_duration",
    "test_join_audio_parts_concat_without_crossfade",
    "test_render_dialogue_track_delegates",
    "test_extract_segment",
    "test_annotate_time_marks_writes_png",
    "test_overlay_png_returns_false_on_bad_filter",
    "test_annotate_retries_boxes_when_drawtext_overlay_fails",
    "test_render_timeline_reuses_inputs_for_repeated_resolved_sources",
    "test_annotate_time_marks_empty_copies_png",
}


@pytest.fixture(autouse=True)
def in_process_row(host):
    host(replace(IOS, media_tools="in_process"))
    with process.using_in_process_backend(FakeBackend()):
        yield


for _name in DESKTOP_ONLY:
    globals().pop(_name, None)


class MediaBackend(FakeBackend):
    """Answers ffprobe's metadata and packet scan and ffmpeg's decode; ``route_progress`` sends ``-progress pipe:2`` to stderr."""

    def __init__(
        self, metadata: dict, *, route_progress: bool = True, scan: bytes = b"0,2\n2,2\n"
    ) -> None:
        super().__init__()
        self.scan = scan
        self.metadata = metadata
        self.route_progress = route_progress

    def run(self, argv, streams, cancel):
        self.calls.append(argv)
        if argv[0] == process.IN_PROCESS_FFPROBE:
            scan = "packet=pts_time,duration_time" in argv
            streams.stdout.write(self.scan if scan else json.dumps(self.metadata).encode())
        else:
            streams.stdout.write(np.zeros(48000, np.float32).tobytes())
            if self.route_progress and argv[1:3] == ["-progress", "pipe:2"]:
                streams.stderr.write(b"out_time_us=1000000\nprogress=end\n")
        return 0


@pytest.fixture
def sentinel_media(tmp_path, monkeypatch):
    path = tmp_path / "audio.mkv"
    path.write_bytes(b"media revision")
    metadata = {
        "format": {"duration": "5", "format_name": "matroska"},
        "streams": [
            {"codec_type": "audio", "sample_rate": "48000", "channels": 1, "duration": "4"},
            {"codec_type": "video"},
        ],
    }
    real_stat = Path.stat

    def stat(self, *args, **kwargs):
        if "in-process:" in str(self):
            pytest.fail(f"stat of the sentinel {self}")
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", stat)
    monkeypatch.setattr(shutil, "which", lambda *_a, **_k: pytest.fail("which"))
    module._cached_audio_extent.cache_clear()

    def install(backend):
        monkeypatch.setattr(process._in_process_backend, "run", backend.run)

    return path, metadata, install


def test_in_process_video_matroska_keeps_the_pcm_shortfall_check(sentinel_media):
    path, metadata, install = sentinel_media
    backend = MediaBackend(metadata)
    engine = module.FFmpegEngine()
    install(backend)
    assert engine.probe(path).audio_duration_sec == 4
    with pytest.raises(RuntimeError, match="ended short"):
        list(engine.stream_pcm_f32(path)[2])


def test_in_process_progress_is_argv_pipe2_and_an_unrouted_progress_fails_closed(sentinel_media):
    path, metadata, install = sentinel_media
    engine = module.FFmpegEngine()
    routed = MediaBackend(metadata)
    install(routed)
    with pytest.raises(RuntimeError, match="ended short"):
        list(engine.stream_pcm_f32(path)[2])
    decode = routed.calls[-1]
    assert decode[:3] == [process.IN_PROCESS_FFMPEG, "-progress", "pipe:2"]
    install(MediaBackend(metadata, route_progress=False))
    with pytest.raises(RuntimeError, match="no final timestamp"):
        list(engine.stream_pcm_f32(path)[2])


def test_in_process_extent_is_not_cached_across_backend_installs(sentinel_media):
    path, metadata, install = sentinel_media
    engine = module.FFmpegEngine()
    install(MediaBackend(metadata, scan=b"0,2\n2,2\n"))
    assert engine.probe(path).duration_sec == 4
    install(MediaBackend(metadata, scan=b"0,1\n"))
    assert engine.probe(path).duration_sec == 1
