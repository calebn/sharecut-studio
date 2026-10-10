from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.session_air import SessionAir
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.models import (
    Clip,
    ClipMuteRegion,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    Transcript,
    TranscriptWord,
)


def _project(tmp_path: Path) -> EpisodeProject:
    raw = tmp_path / "raw"
    raw.mkdir()
    with wave.open(str(raw / "voice.wav"), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(48_000)
        output.writeframes(np.full(24_000, 8192, dtype="<i2").tobytes())
    project = EpisodeProject.create("sample-boundaries", str(tmp_path))
    project.tracks.append(
        Track(
            id="peer",
            label="Peer",
            media=MediaAsset(path="raw/voice.wav", duration_sec=0.5, sample_rate=16_000),
        )
    )
    project.clips.append(
        Clip(id="peer-clip", track_id="peer", source_start=0, source_end=0.5, timeline_start=0)
    )
    project.transcripts.append(Transcript(track_id="peer", words=[]))
    return project


def _render(project: EpisodeProject, tmp_path: Path) -> np.ndarray:
    output = tmp_path / "render.wav"
    render_track_from_timeline(project, project.track_by_id("peer"), output, {})
    return load_mono_window(output, duration_sec=0.5, sample_rate=48_000)


@pytest.mark.parametrize(
    "end,fade_out,fade_in,word,expected_spans,sample_indices,expected_audio",
    [
        (
            0.2,
            0,
            0,
            (9599, 9602),
            [(9601 / 48000, 9602 / 48000, "peer")],
            [9599, 9600, 9601],
            [0.0, 0.0, 0.25],
        ),
        (
            0.2,
            10,
            10,
            (9119, 9122),
            [(9121 / 48000, 9122 / 48000, "peer")],
            [9119, 9120, 9121],
            [0.0, 0.0, 0.25 / 480],
        ),
        (
            0.102,
            100,
            100,
            (4895, 4898),
            [(4896 / 48000, 4898 / 48000, "peer")],
            [4895, 4896, 4897],
            [0.0, 0.25, 0.25],
        ),
        (
            0.3,
            100,
            100,
            (9599, 9602),
            [(9599 / 48000, 0.2, "peer"), (9601 / 48000, 9602 / 48000, "peer")],
            [9599, 9600, 9601],
            [0.25 / 4800, 0.0, 0.25 / 4800],
        ),
    ],
    ids=["inclusive-hard-end", "inclusive-fade-end", "short-fade-half-open", "equal-fades"],
)
def test_projected_words_follow_literal_rendered_sample_boundaries(
    tmp_path, end, fade_out, fade_in, word, expected_spans, sample_indices, expected_audio
):
    project = _project(tmp_path)
    project.clips[0].mute_regions = [
        ClipMuteRegion(start_s=0.1, end_s=end, fade_out_ms=fade_out, fade_in_ms=fade_in)
    ]
    project.transcripts[0].words = [
        TranscriptWord(text="kept", start=word[0] / 48000, end=word[1] / 48000)
    ]

    assert list(SessionAir(project, sample_rate=16_000).placed_word_spans()) == expected_spans
    assert _render(project, tmp_path)[sample_indices] == pytest.approx(
        expected_audio, abs=1 / 32768
    )


def test_later_envelope_dispatch_keeps_the_shared_boundary_sample(tmp_path):
    project = _project(tmp_path)
    project.clips[0].mute_regions = [
        ClipMuteRegion(start_s=0.1, end_s=0.2, fade_out_ms=0, fade_in_ms=0),
        ClipMuteRegion(start_s=0.200002, end_s=0.3, fade_out_ms=10, fade_in_ms=0),
    ]
    project.transcripts[0].words = [TranscriptWord(text="kept", start=0.2, end=9601 / 48000)]

    assert list(SessionAir(project).placed_word_spans()) == [(0.2, 9601 / 48000, "peer")]
    assert _render(project, tmp_path)[[9599, 9600, 9601]] == pytest.approx(
        [0.0, 0.25, 0.25 * 479 / 480], abs=1 / 32768
    )


def test_renderer_skipped_envelope_does_not_truncate_the_previous_zero_run(tmp_path):
    project = _project(tmp_path)
    project.clips[0].mute_regions = [
        ClipMuteRegion(start_s=0.1, end_s=0.2, fade_out_ms=0, fade_in_ms=0),
        ClipMuteRegion(start_s=0.200002, end_s=0.2000025, fade_out_ms=10, fade_in_ms=0),
    ]
    project.transcripts[0].words = [TranscriptWord(text="kept", start=0.2, end=9602 / 48000)]
    assert list(SessionAir(project).placed_word_spans()) == [(9601 / 48000, 9602 / 48000, "peer")]
    assert _render(project, tmp_path)[[9599, 9600, 9601]] == pytest.approx([0.0, 0.0, 0.25])


def test_ignored_token_does_not_delete_a_kept_token_in_its_positive_fade_wing(tmp_path):
    project = _project(tmp_path)
    project.transcripts[0].words = [
        TranscriptWord(text="ignored", start=0.1, end=0.2, ignored=True),
        TranscriptWord(text="kept", start=0.101, end=0.103),
        TranscriptWord(text="after", start=0.3, end=0.35),
    ]

    assert list(SessionAir(project).placed_word_spans()) == [
        (0.101, 0.103, "peer"),
        (0.3, 0.35, "peer"),
    ]
    assert _render(project, tmp_path)[[4848, 4920]] == pytest.approx([0.2, 0.125], abs=1 / 32768)


def test_implicit_full_track_applies_its_own_ignored_words(tmp_path):
    project = _project(tmp_path)
    project.clips = []
    project.transcripts[0].words = [
        TranscriptWord(text="ignored", start=0.1, end=0.2, ignored=True),
        TranscriptWord(text="kept", start=0.3, end=0.35),
    ]

    assert list(SessionAir(project).placed_word_spans()) == [(0.3, 0.35, "peer")]
    assert _render(project, tmp_path)[[7200, 15600]] == pytest.approx([0.0, 0.25])


def test_physical_primary_fallback_keeps_ignored_word_without_destination_mask(tmp_path):
    project = _project(tmp_path)
    (tmp_path / "raw/parking.wav").write_bytes((tmp_path / "raw/voice.wav").read_bytes())
    project.tracks[0].media.path = "raw/parking.wav"
    project.tracks.append(
        Track(
            id="origin",
            label="Origin",
            timeline_empty=True,
            media=MediaAsset(path="raw/voice.wav", duration_sec=0.5),
        )
    )
    project.sources.append(SourceRecording(id="borrowed", path="raw/voice.wav", duration_sec=0.5))
    project.clips[0].source_id = "borrowed"
    project.transcripts = [
        Transcript(
            track_id="origin",
            words=[TranscriptWord(text="ignored-in-origin", start=0.1, end=0.2, ignored=True)],
        )
    ]

    assert list(SessionAir(project).placed_word_spans()) == [(0.1, 0.2, "peer")]
    assert _render(project, tmp_path)[[4800, 7200, 9599]] == pytest.approx([0.25, 0.25, 0.25])


def test_editorial_ignore_preserves_raw_room_calibration_frames(tmp_path):
    project = _project(tmp_path)
    project.transcripts[0].words = [
        TranscriptWord(text="ignored", start=0.1, end=0.2, ignored=True),
        TranscriptWord(text="kept", start=0.3, end=0.35),
    ]
    air = SessionAir(project)
    recording = next(iter(air._recordings.values()))
    expected = np.array([True] * 5 + [False] * 35 + [True] * 10)
    np.testing.assert_array_equal(air.session_silent_frames(recording, 50), expected)
    assert list(air.placed_word_spans()) == [(0.3, 0.35, "peer")]
    project.transcripts[0].words[0].ignored = False
    audible = SessionAir(project)
    np.testing.assert_array_equal(
        audible.session_silent_frames(next(iter(audible._recordings.values())), 50), expected
    )


def test_nonzero_source_origin_keeps_source_sample_boundary(tmp_path):
    project = _project(tmp_path)
    project.clips[0].source_start = 0.05
    project.clips[0].mute_regions = [
        ClipMuteRegion(start_s=0.1, end_s=0.2, fade_out_ms=0, fade_in_ms=0)
    ]
    project.transcripts[0].words = [TranscriptWord(text="kept", start=0.2, end=0.21)]

    spans = list(SessionAir(project).placed_word_spans())
    np.testing.assert_allclose(
        [(lo, hi) for lo, hi, track in spans if track == "peer"],
        [(0.15002083333333333, 0.16)],
        atol=1e-12,
        rtol=0,
    )
    assert _render(project, tmp_path)[[7199, 7200, 7201]] == pytest.approx([0.0, 0.0, 0.25])
