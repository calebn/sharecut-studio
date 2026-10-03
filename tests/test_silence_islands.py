"""Tests for silence-island handoff cut suggestions."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.edits.silence_islands import (
    SilenceIsland,
    _snap_to_quiet,
    silence_islands_from_hops,
    suggest_handoff_cut,
)
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _write_wav(path, samples):
    import wave

    import numpy as np

    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes((samples * 32767).astype(np.int16).tobytes())


def _project(tmp_path: Path) -> EpisodeProject:
    ws = tmp_path / "ws"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    import numpy as np

    _write_wav(raw / "host.wav", np.zeros(30 * 16000))
    p = EpisodeProject.create("t", str(ws))
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=30.0),
        ),
    ]
    p.timeline.clips = [
        Clip(
            id="h1",
            track_id="host",
            source_start=0.0,
            source_end=30.0,
            timeline_start=0.0,
        ),
    ]
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="sixty", start=1.0, end=1.3),
                TranscriptWord(text="seven", start=1.3, end=1.6),
                TranscriptWord(text="But", start=3.0, end=3.2),
                TranscriptWord(text="yeah", start=3.2, end=3.5),
                TranscriptWord(text="um", start=6.0, end=6.3),
                TranscriptWord(text="All", start=8.0, end=8.2),
                TranscriptWord(text="right", start=8.2, end=8.5),
            ],
        )
    ]
    return p


def test_silence_islands_from_hops_clusters_quiet():
    # Speech, silence, speech (um), silence, speech
    hops = [
        (0.0, -20.0),
        (0.5, -20.0),
        (1.0, -55.0),
        (1.5, -55.0),
        (2.0, -55.0),
        (2.5, -20.0),  # um
        (3.0, -20.0),
        (3.5, -55.0),
        (4.0, -55.0),
        (4.5, -55.0),
        (5.0, -20.0),
    ]
    islands = silence_islands_from_hops(hops, quiet_db=-48.0, min_duration_sec=0.12)
    assert len(islands) == 2
    assert islands[0].start == 1.0
    assert islands[0].end == 2.0
    assert islands[1].start == 3.5
    assert islands[1].end == 4.5
    assert abs(islands[0].midpoint - 1.5) < 1e-9


def test_silence_islands_from_irregular_hops_preserves_last_quiet_time():
    hops = [(2.0, -60.0), (0.0, -60.0), (0.4, -60.0), (0.4, -20.0), (1.0, -60.0)]
    assert silence_islands_from_hops(hops, min_duration_sec=0.3) == [
        SilenceIsland(start=0.0, end=0.4),
        SilenceIsland(start=1.0, end=2.0),
    ]


def test_suggest_handoff_retains_air_and_removes_um(tmp_path):
    """Retain ~1s on each keep; um in the middle is inside the cut."""
    p = _project(tmp_path)

    def fake_rms(_project, _tid, t0, t1, **_kw):
        mid = (t0 + t1) / 2.0
        if 1.7 <= mid < 2.8:
            return -55.0
        if 2.8 <= mid < 5.5:
            return -20.0
        if 5.5 <= mid < 5.9:
            return -55.0
        if 5.9 <= mid < 6.5:
            return -18.0
        if 6.5 <= mid < 7.9:
            return -55.0
        return -20.0

    with patch(
        "podcast_mcp.edits.silence_islands.measure_timeline_rms_db",
        side_effect=fake_rms,
    ):
        out = suggest_handoff_cut(p, ["host"], 1.6, 8.0, hop_ms=50)

    assert out["ok"] is True
    assert out["use_inaudible_opt"] is False
    assert out["cut_start"] is not None
    assert out["cut_end"] is not None
    assert 2.45 < out["cut_start"] < 2.75
    assert 6.8 < out["cut_end"] < 7.2
    assert out["retained_air_after_left_sec"] is not None
    assert out["retained_air_after_left_sec"] > 0.7
    assert out["retained_air_before_right_sec"] is not None
    assert out["retained_air_before_right_sec"] > 0.7
    assert out["cut_start"] < 6.0 < out["cut_end"]
    assert len(out["islands"]) >= 2


def test_suggest_handoff_ignores_puddle_glued_to_pivot(tmp_path):
    """IN target is keep_right - retain, not a puddle next to the pivot."""
    p = _project(tmp_path)

    def fake_rms(_project, _tid, t0, t1, **_kw):
        mid = (t0 + t1) / 2.0
        if 1.7 <= mid < 2.8:
            return -55.0
        if 2.8 <= mid < 6.5:
            return -20.0
        if 6.5 <= mid < 7.05:
            return -55.0
        if 7.05 <= mid < 7.55:
            return -18.0
        if 7.7 <= mid < 7.95:
            return -55.0
        return -20.0

    with patch(
        "podcast_mcp.edits.silence_islands.measure_timeline_rms_db",
        side_effect=fake_rms,
    ):
        out = suggest_handoff_cut(p, ["host"], 1.6, 8.0, hop_ms=50, retain_sec=1.0)

    assert out["ok"] is True
    assert out["cut_end"] is not None
    assert 6.85 < out["cut_end"] < 7.1
    assert out["in_island"] is not None
    assert out["in_island"]["start"] < 7.2
    assert out["retained_air_before_right_sec"] > 0.8


def test_suggest_handoff_refuses_um_at_retain_target(tmp_path):
    """Audible um at keep_left+retain blocks the join even with no transcript token."""
    p = _project(tmp_path)

    def fake_rms(_project, _tid, t0, t1, **_kw):
        mid = (t0 + t1) / 2.0
        if 1.7 <= mid < 2.3:
            return -55.0
        if 2.3 <= mid < 2.9:
            return -18.0
        if 6.5 <= mid < 7.9:
            return -55.0
        return -20.0

    with patch(
        "podcast_mcp.edits.silence_islands.measure_timeline_rms_db",
        side_effect=fake_rms,
    ):
        out = suggest_handoff_cut(p, ["host"], 1.6, 8.0, hop_ms=50, retain_sec=1.0)

    assert out["ok"] is False
    assert "cut_start_not_quiet" in out["warnings"]
    assert out["cut_start"] is None


def test_suggest_handoff_ignores_brief_quiet_dip_in_um(tmp_path):
    """A 40ms quiet frame inside an um is not a silence island / join point."""
    p = _project(tmp_path)

    def fake_rms(_project, _tid, t0, t1, **_kw):
        mid = (t0 + t1) / 2.0
        if 2.58 <= mid < 2.62:
            return -55.0
        if 2.3 <= mid < 2.9:
            return -18.0
        if 6.5 <= mid < 7.9:
            return -55.0
        return -20.0

    with patch(
        "podcast_mcp.edits.silence_islands.measure_timeline_rms_db",
        side_effect=fake_rms,
    ):
        out = suggest_handoff_cut(p, ["host"], 1.6, 8.0, hop_ms=20, retain_sec=1.0)

    assert out["ok"] is False
    assert "cut_start_not_quiet" in out["warnings"]


def test_suggest_handoff_missing_audio_is_not_room_tone(tmp_path):
    p = _project(tmp_path)
    with patch(
        "podcast_mcp.edits.silence_islands.measure_timeline_rms_db",
        return_value=None,
    ):
        out = suggest_handoff_cut(p, ["host"], 1.0, 5.0)
    assert out["ok"] is False
    assert "cut_start_not_quiet" in out["warnings"]


def test_suggest_handoff_refuses_when_bounds_are_speech(tmp_path):
    p = _project(tmp_path)
    with patch(
        "podcast_mcp.edits.silence_islands.measure_timeline_rms_db",
        return_value=-10.0,
    ):
        out = suggest_handoff_cut(p, ["host"], 1.0, 3.0)
    assert out["ok"] is False
    assert "cut_start_not_quiet" in out["warnings"]
    assert "cut_end_not_quiet" in out["warnings"]
    assert out["cut_start"] is None
    assert out["cut_end"] is None


def test_suggest_handoff_single_island_retains_target_air(tmp_path):
    """Long quiet gap: keep ~1s after left / before right, not 25%/75%."""
    p = _project(tmp_path)
    with patch(
        "podcast_mcp.edits.silence_islands.measure_timeline_rms_db",
        return_value=-55.0,
    ):
        out = suggest_handoff_cut(p, ["host"], 1.0, 13.0, hop_ms=50, retain_sec=1.0)
    assert out["ok"] is True
    assert len(out["islands"]) == 1
    assert out["cut_start"] is not None and out["cut_end"] is not None
    assert 1.85 < out["cut_start"] < 2.25
    assert 11.75 < out["cut_end"] < 12.15
    assert "proposed_bounds_too_tight_or_inverted" not in out["warnings"]


def test_suggest_handoff_snaps_to_quieter_hop(tmp_path):
    p = _project(tmp_path)

    def fake_rms(_project, _tid, t0, t1, **_kw):
        mid = (t0 + t1) / 2.0
        if 2.08 <= mid < 2.14:
            return -70.0
        return -55.0

    with patch(
        "podcast_mcp.edits.silence_islands.measure_timeline_rms_db",
        side_effect=fake_rms,
    ):
        out = suggest_handoff_cut(p, ["host"], 1.0, 5.0, hop_ms=20, retain_sec=1.0)
    assert out["ok"] is True
    assert out["cut_start"] is not None
    assert 2.05 < out["cut_start"] < 2.16


def test_suggest_handoff_side_blob_bounds_not_quiet(tmp_path):
    p = _project(tmp_path)
    with patch(
        "podcast_mcp.edits.silence_islands.timeline_rms_hops",
        return_value=[(1.0, -55.0), (1.4, -55.0), (1.7, -55.0)],
    ):
        out = suggest_handoff_cut(p, ["host"], 1.0, 8.0)
    assert out["ok"] is False
    assert "cut_start_not_quiet" in out["warnings"]
    assert "cut_end_not_quiet" in out["warnings"]
    assert out["cut_start"] is None


def test_suggest_handoff_keep_gap_too_short(tmp_path):
    p = _project(tmp_path)
    with patch(
        "podcast_mcp.edits.silence_islands.timeline_rms_hops",
        return_value=[(1.0, -55.0)],
    ):
        out = suggest_handoff_cut(p, ["host"], 1.0, 1.04)
    assert out["ok"] is False
    assert "keep_gap_too_short" in out["warnings"]


def test_suggest_handoff_clamps_retain_on_short_gap(tmp_path):
    p = _project(tmp_path)
    with patch(
        "podcast_mcp.edits.silence_islands.measure_timeline_rms_db",
        return_value=-55.0,
    ):
        out = suggest_handoff_cut(p, ["host"], 1.0, 1.9, hop_ms=50, retain_sec=1.0)
    assert out["ok"] is True
    assert out["cut_start"] is not None and out["cut_end"] is not None
    assert out["retained_air_after_left_sec"] is not None
    assert out["retained_air_before_right_sec"] is not None
    assert out["retained_air_after_left_sec"] < 0.7
    assert out["retained_air_before_right_sec"] < 0.7
    assert out["cut_end"] - out["cut_start"] > 0.04


def test_suggest_handoff_warns_when_requested_retain_is_short(tmp_path):
    p = _project(tmp_path)
    with patch(
        "podcast_mcp.edits.silence_islands.measure_timeline_rms_db",
        return_value=-55.0,
    ):
        out = suggest_handoff_cut(p, ["host"], 1.0, 13.0, hop_ms=50, retain_sec=0.3)
    assert out["ok"] is True
    assert "retained_air_after_left_short" in out["warnings"]
    assert "retained_air_before_right_short" in out["warnings"]


def test_timeline_rms_hops_uses_cache_builder(tmp_path):
    from podcast_mcp.edits.silence_islands import timeline_rms_hops
    from podcast_mcp.engines.audio_audit import TrackRmsCacheSet

    p = _project(tmp_path)
    import numpy as np

    from podcast_mcp.engines.audio_audit import TrackRmsCache

    empty = TrackRmsCacheSet(caches={"host": TrackRmsCache(np.zeros(16000))})
    with (
        patch(
            "podcast_mcp.edits.silence_islands.build_track_rms_caches",
            return_value=empty,
        ) as build,
        patch(
            "podcast_mcp.edits.silence_islands.measure_timeline_rms_db",
            return_value=-50.0,
        ) as measure,
    ):
        hops = timeline_rms_hops(p, ["host"], 0.0, 0.1, hop_ms=50)
    build.assert_called_once_with(p, track_ids=["host"])
    assert measure.called
    assert measure.call_args.kwargs.get("caches") is empty
    assert len(hops) >= 1


def test_suggest_handoff_rejects_inverted_keeps(tmp_path):
    p = _project(tmp_path)
    with pytest.raises(ValueError, match="keep_right_start"):
        suggest_handoff_cut(p, ["host"], 5.0, 4.0)


def test_silence_islands_empty_hops():
    assert silence_islands_from_hops([]) == []


def test_snap_to_quiet_none_when_empty_or_inverted():
    assert _snap_to_quiet([], 1.0, lo=2.0, hi=1.0, quiet_db=-48.0, islands=[]) is None
    assert _snap_to_quiet([(0.0, -20.0)], 1.5, lo=1.0, hi=2.0, quiet_db=-48.0, islands=[]) is None


def test_snap_to_quiet_requires_silence_island():
    hops = [(1.5, -55.0)]
    assert _snap_to_quiet(hops, 1.5, lo=1.0, hi=2.0, quiet_db=-48.0, islands=[]) is None
    island = SilenceIsland(start=1.4, end=1.7)
    assert _snap_to_quiet(hops, 1.5, lo=1.0, hi=2.0, quiet_db=-48.0, islands=[island]) == 1.5


def test_snap_to_quiet_picks_closest_to_target_not_earliest():
    island = SilenceIsland(start=1.0, end=2.0)
    hops = [(1.08, -55.0), (1.20, -55.0), (1.32, -55.0)]
    assert _snap_to_quiet(hops, 1.32, lo=1.0, hi=2.0, quiet_db=-48.0, islands=[island]) == 1.32


def test_suggest_handoff_warns_when_snaps_invert(tmp_path):
    p = _project(tmp_path)
    with patch(
        "podcast_mcp.edits.silence_islands.timeline_rms_hops",
        return_value=[(2.0, -55.0), (2.01, -55.0)],
    ):
        with patch(
            "podcast_mcp.edits.silence_islands._snap_to_quiet",
            side_effect=[2.0, 2.01],
        ):
            out = suggest_handoff_cut(p, ["host"], 1.0, 5.0)
    assert out["ok"] is False
    assert "proposed_bounds_too_tight_or_inverted" in out["warnings"]
    assert out["cut_start"] is None


@pytest.mark.parametrize("muted", [False, True])
def test_session_handoff_requires_quiet_peer_audio(tmp_path, muted):
    import numpy as np

    from podcast_mcp.models import save_project
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import EditService

    p = _project(tmp_path)
    samples = np.zeros(30 * 16000)
    samples[int(1.7 * 16000) : int(2.3 * 16000)] = 0.2
    _write_wav(Path(p.workspace_dir) / "raw/guest.wav", samples)
    p.timeline.tracks.append(
        Track(
            id="guest",
            label="Guest",
            speaker="Guest",
            role=TrackRole.DIALOGUE,
            muted=muted,
            media=MediaAsset(path="raw/guest.wav", duration_sec=30.0),
        )
    )
    p.timeline.clips.append(
        Clip(id="g1", track_id="guest", source_start=0, source_end=30, timeline_start=0)
    )
    path = Path(p.workspace_dir) / "episode.project.json"
    save_project(p, path)
    service = EditService(ProjectWorkspace.open(path))
    out = service.suggest_handoff_cut(keep_left_end=1, keep_right_start=5)
    assert out["track_ids"] == ["host", "guest"]
    assert out["track_id"] is None
    assert out["ok"] is False
    assert "cut_start_not_quiet" in out["warnings"]
    for selector in ({"track_id": "host"}, {"speaker": "Host"}):
        single = service.suggest_handoff_cut(keep_left_end=1, keep_right_start=5, **selector)
        assert single["ok"] is True
        assert (single["cut_start"], single["cut_end"]) == (2.0, 4.0)
        assert single["track_ids"] == ["host"]
        assert single["track_id"] == "host"


def test_missing_cache_blocks_even_positive_quiet_threshold_without_fallback(tmp_path):
    import math

    from podcast_mcp.edits.silence_islands import timeline_rms_hops
    from podcast_mcp.engines.audio_audit import TrackRmsCacheSet

    p = _project(tmp_path)
    with (
        patch(
            "podcast_mcp.edits.silence_islands.build_track_rms_caches",
            return_value=TrackRmsCacheSet(),
        ) as build,
        patch("podcast_mcp.edits.silence_islands.measure_timeline_rms_db") as measure,
    ):
        hops = timeline_rms_hops(p, ["host", "guest"], 1, 5)
        out = suggest_handoff_cut(p, ["host", "guest"], 1, 5, quiet_db=10)
    assert all(math.isinf(db) for _, db in hops)
    assert out["ok"] is False
    assert build.call_count == 2
    measure.assert_not_called()


def test_handoff_requires_nonempty_selection(tmp_path):
    with pytest.raises(ValueError, match="at least one dialogue track"):
        suggest_handoff_cut(_project(tmp_path), [], 1, 5)


@pytest.mark.parametrize("peer_quiet", [(1.95, 2.05), (3.5, 4.5)])
def test_handoff_refuses_short_or_disjoint_common_quiet(tmp_path, peer_quiet):
    import numpy as np

    from podcast_mcp.engines.audio_audit import TrackRmsCache, TrackRmsCacheSet

    p = _project(tmp_path)
    caches = TrackRmsCacheSet(
        {tid: TrackRmsCache(np.zeros(16000 * 6), sample_rate=16000) for tid in ["host", "guest"]}
    )

    def measured(_project, tid, start, end, **_kwargs):
        mid = (start + end) / 2
        quiet = (1.5 <= mid < 2.5) if tid == "host" else peer_quiet[0] <= mid < peer_quiet[1]
        return -60.0 if quiet else -15.0

    with (
        patch(
            "podcast_mcp.edits.silence_islands.build_track_rms_caches", return_value=caches
        ) as build,
        patch("podcast_mcp.edits.silence_islands.measure_timeline_rms_db", side_effect=measured),
    ):
        out = suggest_handoff_cut(p, ["host", "guest"], 1, 5)
    build.assert_called_once_with(p, track_ids=["host", "guest"])
    assert out["ok"] is False
    assert out["cut_start"] is None
    assert out["islands"] == []


@pytest.mark.parametrize("offset,size", [(0.0, 1600), (0.05, 16000)])
def test_incomplete_cache_windows_are_unknown(tmp_path, offset, size):
    import math

    import numpy as np

    from podcast_mcp.edits.silence_islands import timeline_rms_hops
    from podcast_mcp.engines.audio_audit import TrackRmsCache, TrackRmsCacheSet

    p = _project(tmp_path)
    cache = TrackRmsCache(np.zeros(size), sample_rate=16000, timeline_offset_sec=offset)
    with patch(
        "podcast_mcp.edits.silence_islands.build_track_rms_caches",
        return_value=TrackRmsCacheSet({"host": cache}),
    ):
        hops = timeline_rms_hops(p, ["host"], 0, 0.12, hop_ms=40)
    assert math.isinf(hops[-1 if offset == 0 else 0][1])


def test_real_wav_repeated_source_mapping_and_gain(tmp_path):
    import numpy as np

    from podcast_mcp.edits.silence_islands import timeline_rms_hops
    from podcast_mcp.engines.audio_audit import build_track_rms_caches
    from podcast_mcp.engines.ungated_audio import load_mono_full

    p = _project(tmp_path)
    audio = np.zeros(4 * 16000)
    audio[16000:32000] = 0.1
    _write_wav(Path(p.workspace_dir) / "raw/host.wav", audio)
    p.timeline.tracks[0].gain_db = 6
    p.timeline.clips = [
        Clip(id=f"c{i}", track_id="host", source_start=1, source_end=2, timeline_start=start)
        for i, start in enumerate([1, 3])
    ]
    with (
        patch(
            "podcast_mcp.edits.silence_islands.build_track_rms_caches", wraps=build_track_rms_caches
        ) as build,
        patch("podcast_mcp.engines.ungated_audio.load_mono_full", wraps=load_mono_full) as decode,
    ):
        hops = timeline_rms_hops(p, ["host"], 0, 4, hop_ms=500)
    build.assert_called_once_with(p, track_ids=["host"])
    assert decode.call_count == 1
    assert [t for t, _ in hops] == [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]
    assert [db < -48 for _, db in hops] == [True, True, False, False, True, True, False, False]
    assert hops[2][1] == pytest.approx(-14, abs=0.1)


def test_default_quiet_session_excludes_music_and_adapters_work(tmp_path):
    import json

    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app
    from podcast_mcp.mcp.tools.edits import suggest_handoff_cut_tool
    from podcast_mcp.models import save_project

    p = _project(tmp_path)
    p.timeline.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            muted=True,
            media=p.timeline.tracks[0].media.model_copy(),
        )
    )
    p.timeline.clips.append(
        Clip(id="g", track_id="guest", source_start=0, source_end=30, timeline_start=0)
    )
    p.timeline.tracks.append(Track(id="music", label="Music", role=TrackRole.MUSIC))
    path = Path(p.workspace_dir) / "episode.project.json"
    save_project(p, path)
    result = CliRunner().invoke(
        app,
        [
            "edit",
            "suggest-handoff-cut",
            "--project",
            str(path),
            "--keep-left-end",
            "1",
            "--keep-right-start",
            "5",
        ],
    )
    assert result.exit_code == 0, result.output
    cli = json.loads(result.stdout)
    mcp = json.loads(suggest_handoff_cut_tool(str(path), 1, 5))
    assert cli == mcp
    assert cli["ok"] is True
    assert cli["track_ids"] == ["host", "guest"]
    assert (cli["cut_start"], cli["cut_end"]) == (2.0, 4.0)


@pytest.mark.parametrize("measurement", [None, float("nan"), float("inf")])
def test_unavailable_rms_does_not_approve_quiet(tmp_path, measurement):
    with patch(
        "podcast_mcp.edits.silence_islands.measure_timeline_rms_db", return_value=measurement
    ):
        out = suggest_handoff_cut(_project(tmp_path), ["host"], 1, 5, quiet_db=float("inf"))
    assert out["ok"] is False
    assert out["islands"] == []


@pytest.mark.parametrize("processed", [False, True])
@pytest.mark.parametrize("selector", [{"track_id": "music"}, {"speaker": "Music"}])
def test_explicit_music_lane_keeps_handoff_and_waveform_evidence(tmp_path, processed, selector):
    import numpy as np

    from podcast_mcp.models import save_project
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import EditService

    p = _project(tmp_path)
    p.timeline.tracks[0].id = "music"
    p.timeline.tracks[0].label = "Music"
    p.timeline.tracks[0].speaker = "Music"
    p.timeline.tracks[0].role = TrackRole.MUSIC
    p.timeline.clips[0].track_id = "music"
    if processed:
        stem = Path(p.workspace_dir) / "artifacts/tracks/music.wav"
        stem.parent.mkdir(parents=True)
        _write_wav(stem, np.zeros(30 * 16000))
    path = Path(p.workspace_dir) / "episode.project.json"
    save_project(p, path)
    service = EditService(ProjectWorkspace.open(path))
    out = service.suggest_handoff_cut(keep_left_end=1, keep_right_start=5, **selector)
    assert out["ok"] is True
    assert out["track_ids"] == ["music"]
    assert (out["cut_start"], out["cut_end"]) == (2.0, 4.0)
    snap = service.waveform_snap_window(track_id="music", start=1, end=5, timeline=True)
    assert snap["islands"]
