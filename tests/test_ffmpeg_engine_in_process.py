"""``test_ffmpeg_engine.py`` run again on an ``in_process`` host row with a fake backend.

Tests that patch the engine's ``run``/``popen`` see the sentinel in the argv they assert; any
that reaches ``subprocess`` fails. Tests that need real media output or explicit binary
paths, or a session fixture that resolves the desktop pair, are dropped here (``DESKTOP_ONLY``) and belong to the device smoke test.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

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
