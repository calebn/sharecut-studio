from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.clips_ops import split_clip_at
from podcast_mcp.edits.decisions import apply_auto_edits, approve_edits, reject_edits
from podcast_mcp.edits.fillers import analyze_fillers_and_pauses
from podcast_mcp.edits.mute_regions import (
    IgnoredWordRegions,
    MuteEnvelope,
    add_source_mute,
    merge_mute_regions,
    mute_regions_overlapping,
    mute_spans_for_source_window,
    subtract_source_mute,
)
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.edits.transcript_correct import set_words_ignored
from podcast_mcp.edits.transcript_cuts import append_remove_decision
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.audio_audit import measure_window_rms_db
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.timeline_render import render_track_from_timeline, render_track_segment
from podcast_mcp.models import (
    Clip,
    ClipMuteRegion,
    EditDecision,
    EditDecisionType,
    EditMode,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService, HistoryService


def _project_with_audio(tmp_path: Path, sample_wav: Path) -> EpisodeProject:
    ws = tmp_path / "ws"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    audio = raw / "host.wav"
    audio.write_bytes(sample_wav.read_bytes())
    guest = raw / "guest.wav"
    guest.write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("mute", str(ws))
    project.tracks = [
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
    project.clips = [
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
            timeline_start=0.5,
        ),
    ]
    project.timeline.duration_sec = 2.5
    return project


def test_merge_and_overlap_mute_regions():
    overlapping = merge_mute_regions(
        [
            ClipMuteRegion(start_s=1.0, end_s=1.4),
            ClipMuteRegion(start_s=1.3, end_s=1.8),
            ClipMuteRegion(start_s=3.0, end_s=3.2),
        ]
    )
    assert [(r.start_s, r.end_s) for r in overlapping] == [(1.0, 1.8), (3.0, 3.2)]
    cut = mute_regions_overlapping(overlapping, 1.5, 3.1)
    assert [(r.start_s, r.end_s) for r in cut] == [(1.0, 1.8), (3.0, 3.2)]
    assert merge_mute_regions([]) == []
    assert mute_regions_overlapping(overlapping, 2.0, 2.5) == []
    clip = Clip(
        id="c",
        track_id="host",
        source_start=0.0,
        source_end=1.0,
        timeline_start=0.0,
    )
    assert add_source_mute(clip, ClipMuteRegion(start_s=2.0, end_s=2.4)) is False
    assert clip.mute_regions == []
    add_source_mute(clip, ClipMuteRegion(start_s=0.2, end_s=0.4))
    assert mute_spans_for_source_window(clip, 0.0, 1.0) == (MuteEnvelope(0.2, 0.4, 0.005, 0.005),)
    assert subtract_source_mute(clip, 0.5, 0.4) is False
    assert subtract_source_mute(clip, 0.8, 0.9) is False
    assert subtract_source_mute(clip, 0.2, 0.4) is True
    assert clip.mute_regions == []
    assert subtract_source_mute(clip, 0.2, 0.4) is False
    assert (
        FFmpegEngine()._mute_chain(0.5, (MuteEnvelope(1.4, 1.6, 0.005, 0.005),), sample_rate=48000)
        == []
    )


def test_overlapping_mutes_render_one_envelope_whatever_their_fills():
    from podcast_mcp.models import RoomToneFill

    clip = Clip(id="c", track_id="host", source_start=0.0, source_end=4.0, timeline_start=0.0)
    clip.mute_regions = [
        ClipMuteRegion(start_s=1.0, end_s=1.5, fade_out_ms=5, fade_in_ms=40),
        ClipMuteRegion(
            start_s=1.4,
            end_s=1.9,
            fade_out_ms=20,
            fade_in_ms=120,
            fill=RoomToneFill(start_s=3.0, end_s=3.5),
        ),
        ClipMuteRegion(start_s=2.5, end_s=2.6),
    ]

    assert mute_spans_for_source_window(clip, 0.5, 3.0) == (
        MuteEnvelope(0.5, 1.4, 0.005, 0.12),
        MuteEnvelope(2.0, 2.1, 0.005, 0.005),
    )


def test_mute_region_fill_travels_with_its_span():
    from podcast_mcp.edits.mute_regions import mute_regions_payload, muted_source_spans
    from podcast_mcp.edits.timeline_ops import paste_segment
    from podcast_mcp.models import RoomToneFill

    tone = RoomToneFill(start_s=8.0, end_s=8.5)
    clip = Clip(id="c1", track_id="host", source_start=0.0, source_end=4.0, timeline_start=0.0)
    add_source_mute(clip, ClipMuteRegion(start_s=1.0, end_s=2.0, fill=tone))
    add_source_mute(clip, ClipMuteRegion(start_s=1.5, end_s=2.5))

    def spans(regions):
        return [(r.start_s, r.end_s, r.fill) for r in regions]

    # The later silent mute replaces the room tone under 1.5-2.0.
    assert spans(clip.mute_regions) == [(1.0, 1.5, tone), (1.5, 2.5, None)]
    assert spans(mute_regions_overlapping(clip.mute_regions, 1.2, 1.8)) == [
        (1.0, 1.5, tone),
        (1.5, 2.5, None),
    ]
    assert mute_regions_payload(clip.mute_regions) == [
        {
            "start_s": 1.0,
            "end_s": 1.5,
            "fade_out_ms": 5,
            "fade_in_ms": 5,
            "fill": {"start_s": 8.0, "end_s": 8.5, "source_id": None},
        },
        {"start_s": 1.5, "end_s": 2.5, "fade_out_ms": 5, "fade_in_ms": 5},
    ]
    project = EpisodeProject.create("p", "/tmp/ws")
    project.tracks = [Track(id="host", label="Host", role=TrackRole.DIALOGUE)]
    project.clips = [clip]
    assert spans(muted_source_spans(project)["host"]) == [(1.0, 2.5, None)]

    assert subtract_source_mute(clip, 1.1, 1.2) is True
    assert spans(clip.mute_regions) == [(1.0, 1.1, tone), (1.2, 1.5, tone), (1.5, 2.5, None)]
    assert add_source_mute(clip, ClipMuteRegion(start_s=1.05, end_s=1.25, fill=tone)) is True
    assert spans(clip.mute_regions) == [(1.0, 1.5, tone), (1.5, 2.5, None)]

    paste_segment(
        project,
        mode=EditMode.RIPPLE,
        insert_at=5.0,
        duration=4.0,
        extracts=[
            {
                "track_id": "host",
                "source_start": 0.0,
                "source_end": 4.0,
                "mute_regions": mute_regions_payload(clip.mute_regions),
            }
        ],
    )
    pasted = next(c for c in project.clips if abs(c.timeline_start - 5.0) < 1e-6)
    assert spans(pasted.mute_regions) == spans(clip.mute_regions)


def test_mute_mode_skips_pause_candidates():
    from unittest.mock import patch

    from podcast_mcp.edits.cut_quality import CutRisk
    from podcast_mcp.edits.fillers import _collect_candidates
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    words = [
        TranscriptWord(text="um", start=0.5, end=0.7),
        TranscriptWord(text="uh", start=0.75, end=0.95),
        TranscriptWord(text="hello", start=3.0, end=3.3),
    ]
    project = EpisodeProject.create("p", "/tmp/ws")
    project.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE),
    ]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
        )
    ]
    project.transcripts = [Transcript(track_id="host", words=words)]
    defaults = {
        "tighten": {
            "filler_words": ["um", "uh"],
            "breath_handling": {"enabled": False},
            "max_pause_sec": 1.2,
            "min_filler_cluster": 2,
            "edit_mode": "mute",
            "join_continuity_gate": True,
        }
    }
    cands = _collect_candidates(project.transcripts[0], defaults, project=project)
    assert cands
    assert all(c.cut_kind == "filler" for c in cands)

    def _opt(project, track_id, start, end, **kw):
        return (
            OptimizedCutRange(
                start=start,
                end=end,
                mode="vocal_transcript_guided",
                shifted_start_ms=0.0,
                shifted_end_ms=0.0,
                confidence=0.9,
                details={},
            ),
            CutRisk(score=0.1, reasons=[]),
        )

    with (
        patch("podcast_mcp.edits.fillers.optimize_and_assess", side_effect=_opt),
        patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=5),
        patch(
            "podcast_mcp.edits.join_continuity.assess_proposed_cut",
            side_effect=RuntimeError("scorer down"),
        ),
    ):
        decisions = analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert decisions
    assert all(d.type == EditDecisionType.MUTE for d in decisions)
    assert all((d.reason or "").startswith("filler:") for d in decisions)
    assert all(d.replace_gap_sec is None for d in decisions)


def test_mute_analyze_join_fail_and_pacing_skip():
    from types import SimpleNamespace
    from unittest.mock import patch

    from podcast_mcp.edits.cut_quality import CutRisk
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    words = [
        TranscriptWord(text="um", start=0.5, end=0.7),
        TranscriptWord(text="uh", start=0.75, end=0.95),
    ]
    project = EpisodeProject.create("p", "/tmp/ws")
    project.tracks = [Track(id="host", label="Host", role=TrackRole.DIALOGUE)]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
        )
    ]
    project.transcripts = [Transcript(track_id="host", words=words)]
    defaults = {
        "tighten": {
            "filler_words": ["um", "uh"],
            "breath_handling": {"enabled": False},
            "min_filler_cluster": 2,
            "edit_mode": "mute",
            "join_continuity_gate": True,
        }
    }

    def _opt(project, track_id, start, end, **kw):
        return (
            OptimizedCutRange(
                start=start,
                end=end,
                mode="vocal_transcript_guided",
                shifted_start_ms=0.0,
                shifted_end_ms=0.0,
                confidence=0.9,
                details={},
            ),
            CutRisk(score=0.1, reasons=[]),
        )

    with (
        patch("podcast_mcp.edits.fillers.optimize_and_assess", side_effect=_opt),
        patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=5),
        patch("podcast_mcp.edits.fillers.apply_filler_pacing", return_value=None),
    ):
        skips: dict[str, int] = {}
        assert (
            analyze_fillers_and_pauses(project, project.transcripts[0], defaults, skip_counts=skips)
            == []
        )
    assert skips["pacing"] == 2
    # A mute butts nothing together, so the join continuity gate never scores it.
    for verdict in ("fail", "review"):
        with (
            patch("podcast_mcp.edits.fillers.optimize_and_assess", side_effect=_opt),
            patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
            patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=5),
            patch(
                "podcast_mcp.edits.join_continuity.assess_proposed_cut",
                return_value=SimpleNamespace(verdict=verdict),
            ) as assess,
        ):
            muted = analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
        assert [(d.type, d.reason, d.review_required) for d in muted] == [
            (EditDecisionType.MUTE, "filler:um", False),
            (EditDecisionType.MUTE, "filler:uh", False),
        ]
        assert assess.call_count == 0
        project.edit_decisions = []


def test_invalid_edit_mode_falls_back_to_ripple():
    from unittest.mock import patch

    from podcast_mcp.edits.cut_quality import CutRisk
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    words = [
        TranscriptWord(text="um", start=0.5, end=0.7),
        TranscriptWord(text="uh", start=0.75, end=0.95),
    ]
    project = EpisodeProject.create("p", "/tmp/ws")
    project.transcripts = [Transcript(track_id="host", words=words)]

    def _opt(project, track_id, start, end, **kw):
        return (
            OptimizedCutRange(
                start=start,
                end=end,
                mode="vocal_transcript_guided",
                shifted_start_ms=0.0,
                shifted_end_ms=0.0,
                confidence=0.9,
                details={},
            ),
            CutRisk(score=0.1, reasons=[]),
        )

    with (
        patch("podcast_mcp.edits.fillers.optimize_and_assess", side_effect=_opt),
        patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=15),
    ):
        proposed = propose_tighten_edits(
            project,
            {
                "tighten": {
                    "filler_words": ["um", "uh"],
                    "breath_handling": {"enabled": False},
                    "min_filler_cluster": 2,
                }
            },
            edit_mode="nope",
        )
    assert proposed.decisions
    assert all(d.type == EditDecisionType.REMOVE for d in proposed.decisions)


def test_apply_mute_keeps_timeline_and_peer_offsets(tmp_path, sample_wav):
    project = _project_with_audio(tmp_path, sample_wav)
    guest_start = project.clips[1].timeline_start
    duration = project.timeline.duration_sec
    project.edit_decisions = [
        EditDecision(
            id="m1",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=0.4,
            end=0.7,
            reason="filler:um",
            review_required=False,
            applied=False,
        )
    ]
    n = apply_auto_edits(project)
    assert n == 1
    assert project.timeline.duration_sec == pytest.approx(duration)
    guest = next(c for c in project.clips if c.track_id == "guest")
    assert guest.timeline_start == pytest.approx(guest_start)
    host = next(c for c in project.clips if c.track_id == "host")
    (region,) = host.mute_regions
    # The region holds the edit and the fades either side of it.
    assert (region.start_s, region.fade_out_ms) == (pytest.approx(0.395), 5)
    assert region.end_s == pytest.approx(0.7 + region.fade_in_ms / 1000)


def test_rendered_mute_is_silent_inside_and_unchanged_outside(tmp_path, sample_wav):
    project = _project_with_audio(tmp_path, sample_wav)
    host = next(c for c in project.clips if c.track_id == "host")
    add_source_mute(host, ClipMuteRegion(start_s=0.4, end_s=0.7))
    out = Path(project.workspace_dir) / "artifacts" / "host.wav"
    render_track_from_timeline(project, project.tracks[0], out, {})
    inside = measure_window_rms_db(out, 0.45, 0.65)
    before = measure_window_rms_db(out, 0.05, 0.25)
    after = measure_window_rms_db(out, 1.2, 1.4)
    assert inside is not None and inside <= -60.0
    assert before is not None and before > -40.0
    assert after is not None and after > -40.0
    edge = load_mono_window(out, start_sec=0.39, duration_sec=0.03, sample_rate=16000)
    steps = np.abs(np.diff(edge.astype(np.float64)))
    assert float(np.max(steps)) < 0.2
    assert ClipMuteRegion(start_s=0.4, end_s=0.7).fade_out_ms == 5


def _noise_floor_project(tmp_path: Path, *, uh_sec: float = 0.3) -> EpisodeProject:
    """A 4 s mic track: white noise at -60 dBFS RMS, with a -20 dBFS ``uh`` at 1.0-1.3 s.

    The tone runs ``uh_sec`` from 1.0 s, on into the next word when longer than the uh.
    """
    import wave

    rate = 48_000
    samples = np.random.default_rng(11).standard_normal(4 * rate) * 10 ** (-60 / 20)
    t = np.arange(round(uh_sec * rate)) / rate
    samples[rate : rate + t.size] += np.sin(2 * np.pi * 180.0 * t) * np.sqrt(2) * 10 ** (-20 / 20)
    ws = tmp_path / "ws"
    (ws / "raw").mkdir(parents=True)
    with wave.open(str(ws / "raw" / "host.wav"), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes((np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes())
    project = EpisodeProject.create("room-tone", str(ws))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=4.0),
        )
    ]
    project.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=4.0, timeline_start=0.0)
    ]
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="uh", start=1.0, end=1.3)])
    ]
    project.timeline.duration_sec = 4.0
    project.edit_decisions = [
        EditDecision(
            id="m1",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=1.0,
            end=1.3,
            reason="filler:uh",
            review_required=False,
            applied=False,
        )
    ]
    return project


# rms_db floors digital silence at -80 dB.
@pytest.mark.parametrize(
    ("pad_mode", "fill", "inside_db"),
    # The nearest stretch of the -60 dBFS floor clear of the uh's onset, as a ripple pad
    # samples it.
    [("room_tone", (pytest.approx(0.55), pytest.approx(0.85)), -60.0), ("silence", None, -80.0)],
)
def test_approved_mute_is_filled_like_the_ripple_pad(tmp_path, pad_mode, fill, inside_db):
    from unittest.mock import patch

    project = _noise_floor_project(tmp_path)
    with patch("podcast_mcp.edits.decisions.filler_pad_mode", return_value=pad_mode):
        assert approve_edits(project, ["m1"]) == 1
    (region,) = project.clips[0].mute_regions
    assert (None if region.fill is None else (region.fill.start_s, region.fill.end_s)) == fill
    out = Path(project.workspace_dir) / "artifacts" / "host.wav"
    render_track_from_timeline(project, project.tracks[0], out, {})

    assert measure_window_rms_db(out, 1.01, 1.29) == pytest.approx(inside_db, abs=1.5)
    assert measure_window_rms_db(out, 0.2, 0.8) == pytest.approx(-60.0, abs=1.5)
    assert measure_window_rms_db(out, 1.5, 3.5) == pytest.approx(-60.0, abs=1.5)
    assert project.timeline.duration_sec == pytest.approx(4.0)
    # A window starting inside the mute (playback, bounce) lays the same fill.
    window = Path(project.workspace_dir) / "artifacts" / "window.wav"
    render_track_segment(project, "host", 1.1, 2.0, window, {})
    assert measure_window_rms_db(window, 0.0, 0.18) == pytest.approx(inside_db, abs=1.5)
    assert measure_window_rms_db(window, 0.4, 0.9) == pytest.approx(-60.0, abs=1.5)


@pytest.mark.parametrize(
    ("next_burst_sec", "region", "resume_db"),
    [
        # A hot resume gets the longest post-pad fade-in, as a padded cut would.
        (None, (0.995, 1.42, 5, 120), (-46.1, -35.1, -23.9)),
        # A plosive burst caps it: the clip is back at full level when the burst begins.
        (1.33, (0.995, 1.33, 5, 30), (-34.1, -23.0, -20.0)),
    ],
)
def test_approved_mute_fades_like_a_padded_cut(tmp_path, next_burst_sec, region, resume_db):
    from unittest.mock import patch

    project = _noise_floor_project(tmp_path, uh_sec=0.8)
    project.transcripts[0].words.append(TranscriptWord(text="go", start=1.3, end=1.8))
    project.edit_decisions[0].next_burst_sec = next_burst_sec

    with patch("podcast_mcp.edits.decisions.filler_pad_mode", return_value="silence"):
        assert approve_edits(project, ["m1"]) == 1

    (muted,) = project.clips[0].mute_regions
    assert (muted.start_s, muted.end_s, muted.fade_out_ms, muted.fade_in_ms) == (
        pytest.approx(region[0]),
        pytest.approx(region[1]),
        region[2],
        region[3],
    )
    out = Path(project.workspace_dir) / "artifacts" / "host.wav"
    render_track_from_timeline(project, project.tracks[0], out, {})
    assert measure_window_rms_db(out, 0.9, 0.99) == pytest.approx(-60.5, abs=0.5)
    assert measure_window_rms_db(out, 1.0, 1.3) == pytest.approx(-80.0)
    assert [
        measure_window_rms_db(out, a, b) for a, b in ((1.3, 1.31), (1.31, 1.33), (1.35, 1.4))
    ] == [pytest.approx(level, abs=0.5) for level in resume_db]
    assert measure_window_rms_db(out, 1.45, 1.75) == pytest.approx(-20.0, abs=0.1)


def test_approve_reject_undo_mute(tmp_path, sample_wav):
    project = _project_with_audio(tmp_path, sample_wav)
    path = tmp_path / "ws" / "episode.project.json"
    from podcast_mcp.project_store import ProjectStore

    ProjectStore(path).commit(project)
    ws = ProjectWorkspace.open(path)
    ws.project.edit_decisions = [
        EditDecision(
            id="m1",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=0.4,
            end=0.7,
            reason="filler:um",
            review_required=True,
            applied=False,
        )
    ]

    def _approve(p):
        return approve_edits(p, ["m1"])

    ws.mutate("before approve mute", "after approve mute", _approve)
    host = next(c for c in ws.project.clips if c.track_id == "host")
    assert host.mute_regions
    HistoryService(ws).undo()
    host = next(c for c in ws.project.clips if c.track_id == "host")
    assert host.mute_regions == []

    ws.project.edit_decisions = [
        EditDecision(
            id="m2",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=0.4,
            end=0.7,
            reason="filler:um",
            review_required=True,
            applied=False,
        )
    ]
    assert reject_edits(ws.project, ["m2"]) == 1
    assert all(e.id != "m2" for e in ws.project.edit_decisions)


def test_clip_mute_regions_schema_round_trip(tmp_path, sample_wav):
    import jsonschema

    from podcast_mcp.models import RoomToneFill

    project = _project_with_audio(tmp_path, sample_wav)
    add_source_mute(project.clips[0], ClipMuteRegion(start_s=0.2, end_s=0.4))
    add_source_mute(
        project.clips[0],
        ClipMuteRegion(start_s=0.6, end_s=0.7, fill=RoomToneFill(start_s=1.5, end_s=1.6)),
    )
    dumped = json.loads(project.model_dump_json())
    schema = json.loads(
        (
            Path(__file__).resolve().parents[1] / "schemas" / "episode.project.schema.json"
        ).read_text()
    )
    clip = dumped["timeline"]["clips"][0]
    clip_schema = {**schema["$defs"]["Clip"], "$defs": schema["$defs"]}
    jsonschema.validate(instance=clip, schema=clip_schema)
    assert clip["mute_regions"][0]["start_s"] == pytest.approx(0.2)
    from podcast_mcp.project_store import ProjectStore

    path = Path(project.workspace_dir) / "episode.project.json"
    store = ProjectStore(path)
    store.commit(project)
    loaded = store.load()
    assert loaded.clips[0].mute_regions == project.clips[0].mute_regions
    assert loaded.clips[0].mute_regions[1].fill == RoomToneFill(start_s=1.5, end_s=1.6)


def test_extract_segment_honours_mute_spans(tmp_path, sample_wav):
    out = tmp_path / "muted.wav"
    FFmpegEngine().extract_segment(
        sample_wav,
        out,
        0.0,
        1.5,
        mute_spans=(MuteEnvelope(0.4, 0.7, 0.005, 0.005),),
    )
    inside = measure_window_rms_db(out, 0.45, 0.65)
    before = measure_window_rms_db(out, 0.05, 0.25)
    assert inside is not None and inside <= -60.0
    assert before is not None and before > -40.0


def test_suggest_pending_edit_accepts_mute(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    dumped = EditService(ws).suggest_pending_edit(
        "host",
        0.2,
        0.5,
        reason="guest:suggest",
        edit_type="mute",
    )
    assert dumped["type"] == "mute"
    with pytest.raises(ValueError, match="remove or mute"):
        EditService(ws).suggest_pending_edit("host", 0.2, 0.5, edit_type="split")
    with pytest.raises(ValueError, match="remove or mute"):
        append_remove_decision(
            ws.project,
            "host",
            0.1,
            0.2,
            decision_type=EditDecisionType.SPLIT,
        )


def test_split_clip_keeps_a_cut_mute_region_whole():
    clip = Clip(
        id="c1",
        track_id="host",
        source_start=0.0,
        source_end=2.0,
        timeline_start=0.0,
        mute_regions=[ClipMuteRegion(start_s=0.2, end_s=0.8)],
    )
    before, after = split_clip_at(clip, 0.5)
    assert [(r.start_s, r.end_s) for r in before.mute_regions] == [(0.2, 0.8)]
    assert [(r.start_s, r.end_s) for r in after.mute_regions] == [(0.2, 0.8)]


def test_propose_mute_keeps_existing_when_replace_false():
    project = EpisodeProject.create("p", "/tmp/ws")
    existing = EditDecision(
        id="keep",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=0.0,
        end=0.1,
        reason="filler:um",
        review_required=False,
        applied=False,
    )
    project.edit_decisions = [existing]
    proposed = propose_tighten_edits(
        project,
        {"tighten": {"filler_words": ["um"], "min_filler_cluster": 2}},
        replace_existing=False,
        edit_mode="mute",
    )
    assert proposed.decisions == []
    assert project.edit_decisions[0].id == "keep"


def test_multi_source_render_honours_mute_regions(tmp_path, sample_wav):
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
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/a.wav", duration_sec=2.0),
        )
    ]
    c1 = Clip(
        id="c1",
        track_id="host",
        source_start=0.0,
        source_end=0.8,
        timeline_start=0.0,
        source_id="s1",
    )
    add_source_mute(c1, ClipMuteRegion(start_s=0.1, end_s=0.4))
    project.clips = [
        c1,
        Clip(
            id="c2",
            track_id="host",
            source_start=0.0,
            source_end=0.8,
            timeline_start=0.9,
            source_id="s2",
        ),
    ]
    out = ws / "out.wav"
    render_track_from_timeline(project, project.tracks[0], out, {})
    inside = measure_window_rms_db(out, 0.15, 0.35)
    delayed = measure_window_rms_db(out, 1.0, 1.2)
    assert inside is not None and inside <= -60.0
    assert delayed is not None and delayed > -40.0


def test_two_mute_spans_and_degenerate_chain(tmp_path, sample_wav):
    project = _project_with_audio(tmp_path, sample_wav)
    host = next(c for c in project.clips if c.track_id == "host")
    add_source_mute(host, ClipMuteRegion(start_s=0.2, end_s=0.35))
    add_source_mute(host, ClipMuteRegion(start_s=0.9, end_s=1.15))
    out = Path(project.workspace_dir) / "artifacts" / "host.wav"
    render_track_from_timeline(project, project.tracks[0], out, {})
    first = measure_window_rms_db(out, 0.24, 0.32)
    second = measure_window_rms_db(out, 0.96, 1.1)
    mid = measure_window_rms_db(out, 0.5, 0.7)
    assert first is not None and first <= -60.0
    assert second is not None and second <= -60.0
    assert mid is not None and mid > -40.0


def test_update_pending_mute_and_split_at_bounds(minimal_project):
    from podcast_mcp.edits.decisions import update_pending_edit

    ws = ProjectWorkspace.open(minimal_project)
    decision = EditDecision(
        id="m1",
        track_id="host",
        type=EditDecisionType.MUTE,
        start=0.2,
        end=0.5,
        reason="filler:um",
        review_required=True,
        applied=False,
    )
    ws.project.edit_decisions = [decision]
    updated = update_pending_edit(ws.project, "m1", start=0.3, end=0.6, snap=False)
    assert updated.start == pytest.approx(0.3)
    assert updated.end == pytest.approx(0.6)
    clip = Clip(
        id="c1",
        track_id="host",
        source_start=0.0,
        source_end=2.0,
        timeline_start=0.0,
        mute_regions=[ClipMuteRegion(start_s=0.2, end_s=0.8)],
    )
    with pytest.raises(ValueError, match="strictly inside"):
        split_clip_at(clip, 0.0)


def test_extract_and_rebuild_clips_keep_mute_regions():
    from podcast_mcp.edits.clips_ops import (
        extract_clips_in_timeline_range,
        remove_timeline_range_from_clips,
    )

    clip = Clip(
        id="c1",
        track_id="host",
        source_start=0.0,
        source_end=2.0,
        timeline_start=0.0,
        mute_regions=[ClipMuteRegion(start_s=0.2, end_s=0.8)],
    )
    extracted = extract_clips_in_timeline_range([clip], 0.3, 0.6)
    assert extracted
    assert [(r.start_s, r.end_s) for r in extracted[0].mute_regions] == [(0.2, 0.8)]

    rebuilt = remove_timeline_range_from_clips([clip], 0.4, 0.5)
    mutes = [(r.start_s, r.end_s) for c in rebuilt for r in c.mute_regions]
    assert mutes == [(0.2, 0.8), (0.2, 0.8)]


def test_update_pending_split_track_ids():
    from podcast_mcp.edits.decisions import update_pending_edit
    from podcast_mcp.edits.transcript_cuts import append_split_decision

    project = EpisodeProject.create("p", "/tmp/ws")
    split = append_split_decision(project, 1.0, ["host", "guest"])
    updated = update_pending_edit(
        project, split.id, start=1.2, end=1.2, snap=False, track_ids=["guest", "host"]
    )
    assert updated.type == EditDecisionType.SPLIT
    assert updated.track_id == "guest"
    assert updated.track_ids == ["guest", "host"]
    empty = update_pending_edit(project, split.id, start=1.3, end=1.3, snap=False, track_ids=[])
    assert empty.track_ids == []
    assert empty.track_id == "guest"


def test_apply_prefix_skips_zero_length_mute(tmp_path, sample_wav):
    project = _project_with_audio(tmp_path, sample_wav)
    project.edit_decisions = [
        EditDecision(
            id="m0",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=0.4,
            end=0.4,
            reason="filler:um",
            review_required=False,
            applied=False,
        )
    ]
    assert apply_auto_edits(project) == 0
    host = next(c for c in project.clips if c.track_id == "host")
    assert host.mute_regions == []


def test_rendered_ignored_word_is_silent_and_leaves_mute_regions_empty(tmp_path, sample_wav):
    project = _project_with_audio(tmp_path, sample_wav)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="skip", start=0.4, end=0.7, confidence=0.9, ignored=True)],
        )
    ]
    host = next(c for c in project.clips if c.track_id == "host")
    out = Path(project.workspace_dir) / "artifacts" / "host.wav"
    render_track_from_timeline(project, project.tracks[0], out, {})
    inside = measure_window_rms_db(out, 0.45, 0.65)
    before = measure_window_rms_db(out, 0.05, 0.25)
    after = measure_window_rms_db(out, 1.2, 1.4)
    assert inside is not None and inside <= -60.0
    assert before is not None and before > -40.0
    assert after is not None and after > -40.0
    assert host.mute_regions == []


def test_render_track_segment_honours_ignored_words(tmp_path, sample_wav):
    from podcast_mcp.engines.timeline_render import render_track_segment

    project = _project_with_audio(tmp_path, sample_wav)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="skip", start=0.4, end=0.7, confidence=0.9, ignored=True)],
        )
    ]
    out = Path(project.workspace_dir) / "artifacts" / "segment.wav"
    render_track_segment(project, "host", 0.0, 1.0, out, {})
    inside = measure_window_rms_db(out, 0.45, 0.65)
    assert inside is not None and inside <= -60.0


def test_ignored_word_regions_clamps_to_clip_and_source(tmp_path, sample_wav):
    project = _project_with_audio(tmp_path, sample_wav)
    project.transcripts = [
        Transcript(
            track_id="host",
            source_id=None,
            words=[
                TranscriptWord(text="before", start=-1.0, end=-0.5, confidence=0.9, ignored=True),
                TranscriptWord(text="in", start=0.4, end=0.7, confidence=0.9, ignored=True),
                TranscriptWord(text="not-ignored", start=0.8, end=1.0, confidence=0.9),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[TranscriptWord(text="hi", start=0.0, end=0.2, confidence=0.9, ignored=True)],
        ),
    ]
    host = next(c for c in project.clips if c.track_id == "host")
    lookup = IgnoredWordRegions(project)
    regions = lookup.for_clip(host)
    assert [(r.start_s, r.end_s) for r in regions] == [(0.4, 0.7)]
    assert lookup.for_clip(host) == regions  # deterministic, no source bleed


def test_ignored_word_regions_scan_the_transcript_once_per_source(
    tmp_path, sample_wav, monkeypatch
):
    project = _project_with_audio(tmp_path, sample_wav)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="a", start=0.2, end=0.4, confidence=0.9, ignored=True),
                TranscriptWord(text="b", start=1.2, end=1.4, confidence=0.9, ignored=True),
            ],
        )
    ]
    first = Clip(id="h1", track_id="host", source_start=0.0, source_end=1.0, timeline_start=0.0)
    second = Clip(id="h2", track_id="host", source_start=1.0, source_end=2.0, timeline_start=1.0)
    calls: list[tuple[str, str | None]] = []
    real = EpisodeProject.transcript_for_source

    def counting(self, track_id, source_id):
        calls.append((track_id, source_id))
        return real(self, track_id, source_id)

    monkeypatch.setattr(EpisodeProject, "transcript_for_source", counting)
    lookup = IgnoredWordRegions(project)
    assert [(r.start_s, r.end_s) for r in lookup.for_clip(first)] == [(0.2, 0.4)]
    assert [(r.start_s, r.end_s) for r in lookup.for_clip(second)] == [(1.2, 1.4)]
    assert calls == [("host", None)]


def test_ignored_words_follow_the_clip_source_on_a_multi_source_track(tmp_path):
    """Ignore flags the track-level transcript (the one the GUI maps); its spans
    mute only clips playing that media, never an extra source's clip.
    """
    project = EpisodeProject.create("ms", str(tmp_path / "ws"))
    project.sources.append(
        SourceRecording(id="s2", path="raw/b.wav", speaker="Host", duration_sec=2.0)
    )
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/a.wav", duration_sec=2.0),
        )
    ]
    primary = Clip(id="c1", track_id="host", source_start=0.0, source_end=0.8, timeline_start=0.0)
    extra = Clip(
        id="c2",
        track_id="host",
        source_start=0.0,
        source_end=0.8,
        timeline_start=0.9,
        source_id="s2",
    )
    project.clips = [primary, extra]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="a", start=0.1, end=0.4, confidence=0.9)],
        ),
        Transcript(
            track_id="host",
            source_id="s2",
            words=[TranscriptWord(text="b", start=0.1, end=0.4, confidence=0.9)],
        ),
    ]
    set_words_ignored(project, "host", 0, 0, True)
    track_level = project.transcript_for_track("host")
    assert track_level is not None and track_level.source_id is None
    assert track_level.words[0].ignored
    lookup = IgnoredWordRegions(project)
    assert [(r.start_s, r.end_s) for r in lookup.for_clip(primary)] == [(0.1, 0.4)]
    assert lookup.for_clip(extra) == []


def test_track_render_hash_follows_ignored_words(tmp_path, sample_wav):
    from podcast_mcp.engines.play_audit import stem_is_fresh, track_render_hash, write_stem_hash

    project = _project_with_audio(tmp_path, sample_wav)
    artifacts = Path(project.workspace_dir) / "artifacts" / "tracks"
    artifacts.mkdir(parents=True)
    stem = artifacts / "host.wav"
    stem.write_bytes(sample_wav.read_bytes())
    h1 = track_render_hash(project, "host")
    write_stem_hash(project, "host")
    assert stem_is_fresh(project, "host")

    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="skip", start=0.4, end=0.7, confidence=0.9, ignored=True)],
        )
    ]
    h2 = track_render_hash(project, "host")
    assert h2 != h1
    assert not stem_is_fresh(project, "host")


def test_track_render_hash_and_stem_freshness_follow_mute_regions(tmp_path, sample_wav):
    from podcast_mcp.engines.play_audit import stem_is_fresh, track_render_hash, write_stem_hash
    from podcast_mcp.engines.reconciliation_state import audio_state_fingerprint
    from podcast_mcp.project_store import ProjectStore

    project = _project_with_audio(tmp_path, sample_wav)
    artifacts = Path(project.workspace_dir) / "artifacts" / "tracks"
    artifacts.mkdir(parents=True)
    stem = artifacts / "host.wav"
    stem.write_bytes(sample_wav.read_bytes())
    h1 = track_render_hash(project, "host")
    fp1 = audio_state_fingerprint(project)
    write_stem_hash(project, "host")
    assert stem_is_fresh(project, "host")
    add_source_mute(project.clips[0], ClipMuteRegion(start_s=0.2, end_s=0.4))
    assert track_render_hash(project, "host") != h1
    assert audio_state_fingerprint(project) != fp1
    assert not stem_is_fresh(project, "host")
    path = Path(project.workspace_dir) / "episode.project.json"
    store = ProjectStore(path)
    store.commit(project)
    loaded = store.load()
    assert loaded.clips[0].mute_regions
    from podcast_mcp.edits.timeline_ops import list_clips

    listed = list_clips(loaded, track_id="host")
    assert listed["tracks"]["host"][0]["mute_regions"][0]["start_s"] == pytest.approx(0.2)


def test_apply_mute_skips_archive_when_nothing_written(tmp_path, sample_wav):
    project = _project_with_audio(tmp_path, sample_wav)
    project.edit_decisions = [
        EditDecision(
            id="miss",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=9.0,
            end=9.4,
            reason="filler:um",
            review_required=True,
            applied=False,
        )
    ]
    assert approve_edits(project, ["miss"]) == 0
    assert [decision.id for decision in project.edit_decisions] == ["miss"]
    assert project.editorial.edit_log == []
    host = next(c for c in project.clips if c.track_id == "host")
    assert host.mute_regions == []


def test_revert_mute_subtracts_regions_without_ripple(tmp_path, sample_wav):
    from podcast_mcp.mcp import server as mcp_server

    project = _project_with_audio(tmp_path, sample_wav)
    guest_start = project.clips[1].timeline_start
    duration = project.timeline.duration_sec
    clip_count = len(project.clips)
    project.edit_decisions = [
        EditDecision(
            id="m1",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=0.4,
            end=0.7,
            reason="filler:um",
            review_required=True,
            applied=False,
        )
    ]
    assert approve_edits(project, ["m1"]) == 1
    host = next(c for c in project.clips if c.track_id == "host")
    assert host.mute_regions
    record = project.editorial.edit_log[0]
    path = Path(project.workspace_dir) / "episode.project.json"
    save_project(project, path)
    reverted = json.loads(mcp_server.revert_applied_edit_tool(str(path), record.id))
    assert reverted["operation"] == "revert_applied_edit"
    loaded = load_project(path)
    host = next(c for c in loaded.clips if c.track_id == "host")
    guest = next(c for c in loaded.clips if c.track_id == "guest")
    assert host.mute_regions == []
    assert guest.timeline_start == pytest.approx(guest_start)
    assert loaded.timeline.duration_sec == pytest.approx(duration)
    assert len(loaded.clips) == clip_count


def test_paste_trim_and_roll_keep_overlapping_mute_regions_whole():
    from podcast_mcp.edits.clips_ops import roll_clip_join
    from podcast_mcp.edits.timeline_ops import paste_segment
    from ripple_helpers import trim

    project = EpisodeProject.create("p", "/tmp/ws")
    project.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE),
        Track(id="guest", label="Guest", role=TrackRole.DIALOGUE),
    ]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
            mute_regions=[ClipMuteRegion(start_s=1.0, end_s=3.0)],
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=5.0,
            source_end=8.0,
            timeline_start=5.0,
            mute_regions=[ClipMuteRegion(start_s=5.0, end_s=5.4)],
        ),
    ]
    paste_segment(
        project,
        mode=EditMode.RIPPLE,
        insert_at=10.0,
        duration=1.0,
        extracts=[
            {
                "track_id": "host",
                "source_start": 1.5,
                "source_end": 2.5,
                "relative_timeline_start": 0.0,
                "mute_regions": [{"start_s": 1.0, "end_s": 3.0}],
            }
        ],
    )
    pasted = [c for c in project.clips if abs(c.timeline_start - 10.0) < 1e-6]
    assert pasted
    assert [(r.start_s, r.end_s) for r in pasted[0].mute_regions] == [(1.0, 3.0)]

    trim(project, "c1", "out", 2.0)
    trimmed = next(c for c in project.clips if c.id == "c1")
    assert [(r.start_s, r.end_s) for r in trimmed.mute_regions] == [(1.0, 3.0)]

    roll_clip_join(project, "c1", "c2", -0.8)
    left = next(c for c in project.clips if c.id == "c1")
    right = next(c for c in project.clips if c.id == "c2")
    assert (left.source_end, right.source_start) == (pytest.approx(1.2), pytest.approx(4.2))
    shared = [(1.0, 3.0), (5.0, 5.4)]
    assert [(r.start_s, r.end_s) for r in left.mute_regions] == shared
    assert [(r.start_s, r.end_s) for r in right.mute_regions] == shared

    roll_clip_join(project, "c1", "c2", -0.2)
    left = next(c for c in project.clips if c.id == "c1")
    assert [(r.start_s, r.end_s) for r in left.mute_regions] == shared


def test_coalesce_merges_same_track_mute():
    from podcast_mcp.edits.transcript_cuts import coalesce_edits

    project = EpisodeProject.create("p", "/tmp/ws")
    project.edit_decisions = [
        EditDecision(
            id="a",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=1.0,
            end=1.4,
        ),
        EditDecision(
            id="b",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=1.35,
            end=1.8,
        ),
        EditDecision(
            id="c",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=1.5,
        ),
    ]
    assert coalesce_edits(project) == 1
    mutes = [e for e in project.edit_decisions if e.type == EditDecisionType.MUTE]
    assert len(mutes) == 1
    assert mutes[0].end == pytest.approx(1.8)
    assert sum(1 for e in project.edit_decisions if e.type == EditDecisionType.REMOVE) == 1


def test_mute_has_a_suggested_preview():
    from podcast_mcp.edits.pending_preview import resolve_pending_preview

    project = EpisodeProject.create("p", "/tmp/ws")
    project.tracks = [Track(id="host", label="Host", role=TrackRole.DIALOGUE)]
    project.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=5.0, timeline_start=0.0)
    ]
    project.edit_decisions = [
        EditDecision(
            id="m1",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=1.0,
            end=1.4,
            review_required=True,
            applied=False,
        )
    ]
    assert resolve_pending_preview(project, "m1").suggest_reason is None


def test_edit_impact_and_invalidation_reason_for_mute(tmp_path, sample_wav):
    from podcast_mcp.edits.decisions import edit_impact_report
    from podcast_mcp.engines.render_invalidations import record_after_audio_mutation
    from podcast_mcp.models import AppliedEditRecord

    project = _project_with_audio(tmp_path, sample_wav)
    project.edit_decisions = [
        EditDecision(
            id="m1",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=0.4,
            end=0.7,
            reason="filler:um",
            review_required=True,
            applied=False,
        )
    ]
    report = edit_impact_report(project)
    assert report["pending_review_count"] == 1
    rec = AppliedEditRecord(
        id="alog_m",
        applied_at="2026-01-01T00:00:00Z",
        operation="approve_edits",
        track_ids=["host"],
        timeline_start=0.4,
        timeline_end=0.7,
        params={"mute": True},
    )
    created = record_after_audio_mutation(
        project,
        changed_track_ids=["host"],
        operation="approve_edits",
        new_edit_log=[rec],
    )
    assert created[0].reason == "mute"


def test_clip_mute_region_and_suggest_payload_reject_invalid():
    from pydantic import ValidationError

    from podcast_mcp.services.document_sync.payloads import SuggestPendingEditPayload

    with pytest.raises(ValidationError):
        ClipMuteRegion(start_s=1.0, end_s=0.5)
    with pytest.raises(ValidationError):
        ClipMuteRegion(start_s=0.2, end_s=float("nan"))
    with pytest.raises(ValidationError):
        SuggestPendingEditPayload(track_id="host", start=float("nan"), end=1.0)
    with pytest.raises(ValidationError):
        SuggestPendingEditPayload(track_id="host", start=1.0, end=0.5)


def test_apply_prefix_mutes_before_overlapping_remove(tmp_path, sample_wav):
    project = _project_with_audio(tmp_path, sample_wav)
    project.edit_decisions = [
        EditDecision(
            id="r1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.0,
            end=2.0,
            reason="filler:um",
            review_required=False,
            applied=False,
        ),
        EditDecision(
            id="m1",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=0.4,
            end=0.7,
            reason="filler:uh",
            review_required=False,
            applied=False,
        ),
    ]
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            "podcast_mcp.edits.decisions.load_defaults",
            lambda: {"tighten": {"inaudible_opt": False}},
        )
        n = apply_auto_edits(project)
    assert n == 2
    mute_logs = [r for r in project.editorial.edit_log if (r.params or {}).get("mute")]
    assert mute_logs
    assert mute_logs[0].source_start == pytest.approx(0.4)


def test_run_mutation_restores_mute_on_failure(tmp_path, sample_wav):
    from podcast_mcp.history.session import run_mutation
    from podcast_mcp.project_store import ProjectStore

    project = _project_with_audio(tmp_path, sample_wav)
    path = Path(project.workspace_dir) / "episode.project.json"
    store = ProjectStore(path)
    store.commit(project)
    project = store.load()
    before = [(c.id, [(r.start_s, r.end_s) for r in c.mute_regions]) for c in project.clips]

    def boom(p: EpisodeProject) -> None:
        add_source_mute(p.clips[0], ClipMuteRegion(start_s=0.2, end_s=0.4))
        raise RuntimeError("mutate failed")

    with pytest.raises(RuntimeError, match="mutate failed"):
        run_mutation(path, project, "before", "after", boom)
    after = [(c.id, [(r.start_s, r.end_s) for r in c.mute_regions]) for c in project.clips]
    assert after == before


def test_revert_mute_error_paths_and_per_track_source(tmp_path, sample_wav):
    from podcast_mcp.edits.edit_log import revert_applied_edit
    from podcast_mcp.models import AppliedEditRecord

    project = _project_with_audio(tmp_path, sample_wav)
    add_source_mute(project.clips[0], ClipMuteRegion(start_s=0.4, end_s=0.7))
    project.editorial.edit_log = [
        AppliedEditRecord(
            id="bad",
            applied_at="2026-01-01T00:00:00+00:00",
            operation="approve_edits",
            track_ids=["host"],
            params={"mute": True},
        )
    ]
    with pytest.raises(ValueError, match="lacks source"):
        revert_applied_edit(project, "bad")
    rec = project.editorial.edit_log[0]
    rec.source_start = 0.5
    rec.source_end = 0.5
    with pytest.raises(ValueError, match="invalid source"):
        revert_applied_edit(project, "bad")
    rec.source_start = 0.4
    rec.source_end = 0.7
    rec.params = {"mute": True, "per_track_source": {"host": [0.9, 0.8]}}
    revert_applied_edit(project, "bad")
    host = next(c for c in project.clips if c.track_id == "host")
    assert host.mute_regions
    add_source_mute(host, ClipMuteRegion(start_s=0.4, end_s=0.7))
    project.editorial.edit_log = [
        AppliedEditRecord(
            id="ok",
            applied_at="2026-01-01T00:00:00+00:00",
            operation="approve_edits",
            track_ids=["host"],
            source_start=0.4,
            source_end=0.7,
            params={"mute": True, "per_track_source": {"host": [0.4, 0.7], "x": "skip"}},
        )
    ]
    revert_applied_edit(project, "ok")
    host = next(c for c in project.clips if c.track_id == "host")
    assert host.mute_regions == []


def test_paste_skips_invalid_mute_region_entries():
    from podcast_mcp.edits.timeline_ops import paste_segment

    project = EpisodeProject.create("p", "/tmp/ws")
    project.tracks = [Track(id="host", label="Host", role=TrackRole.DIALOGUE)]
    project.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=2.0, timeline_start=0.0)
    ]
    paste_segment(
        project,
        mode=EditMode.RIPPLE,
        insert_at=3.0,
        duration=1.0,
        extracts=[
            {
                "track_id": "host",
                "source_start": 0.0,
                "source_end": 1.0,
                "join_in_mode": "not-a-mode",
                "mute_regions": [
                    "nope",
                    {"start_s": None, "end_s": 0.2},
                    {"start_s": 0.5, "end_s": 0.1},
                    {"start_s": 0.1, "end_s": 0.3},
                ],
            }
        ],
    )
    pasted = [c for c in project.clips if abs(c.timeline_start - 3.0) < 1e-6]
    assert pasted
    assert [(r.start_s, r.end_s) for r in pasted[0].mute_regions] == [(0.1, 0.3)]


def _um_uh_project() -> tuple[EpisodeProject, dict]:
    project = EpisodeProject.create("p", "/tmp/ws")
    project.tracks = [Track(id="host", label="Host", role=TrackRole.DIALOGUE)]
    project.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=5.0, timeline_start=0.0)
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="um", start=0.5, end=0.7),
                TranscriptWord(text="uh", start=0.75, end=0.95),
                TranscriptWord(text="hello", start=3.0, end=3.3),
            ],
        )
    ]
    defaults = {
        "tighten": {
            "filler_words": ["um", "uh"],
            "breath_handling": {"enabled": False},
            "min_filler_cluster": 2,
            "join_continuity_gate": True,
        }
    }
    return project, defaults


def _propose_with_stubbed_dsp(project: EpisodeProject, defaults: dict, edit_mode: str):
    from unittest.mock import patch

    from podcast_mcp.edits.cut_quality import CutRisk
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    def _opt(project, track_id, start, end, **kw):
        range_ = OptimizedCutRange(
            start=start,
            end=end,
            mode="vocal_transcript_guided",
            shifted_start_ms=0.0,
            shifted_end_ms=0.0,
            confidence=0.9,
            details={},
        )
        return range_, CutRisk(score=0.1, reasons=[])

    with (
        patch("podcast_mcp.edits.fillers.optimize_and_assess", side_effect=_opt),
        patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=5),
        patch("podcast_mcp.edits.join_continuity.assess_proposed_cut", side_effect=RuntimeError),
    ):
        return propose_tighten_edits(project, defaults, edit_mode=edit_mode)


def test_mute_mode_does_not_repropose_an_approved_mute():
    project, defaults = _um_uh_project()
    first = _propose_with_stubbed_dsp(project, defaults, "mute")
    assert [d.type for d in first.decisions] == [EditDecisionType.MUTE]
    assert "already_muted" not in first.skip_counts

    assert approve_edits(project, [d.id for d in first.decisions]) == 1
    assert project.clips[0].mute_regions

    again = _propose_with_stubbed_dsp(project, defaults, "mute")
    assert again.decisions == []
    assert [e for e in project.edit_decisions if not e.applied] == []
    # "um" and "uh" are two candidates that coalesced into the one approved mute.
    assert again.skip_counts["already_muted"] == 2


def test_mute_mode_still_proposes_a_filler_outside_the_muted_span():
    project, defaults = _um_uh_project()
    project.clips[0].mute_regions = [ClipMuteRegion(start_s=0.5, end_s=0.6)]

    proposed = _propose_with_stubbed_dsp(project, defaults, "mute")

    assert len(proposed.decisions) == 1
    assert "already_muted" not in proposed.skip_counts


def test_ripple_mode_ignores_existing_mute_regions():
    project, defaults = _um_uh_project()
    project.clips[0].mute_regions = [ClipMuteRegion(start_s=0.4, end_s=1.0)]

    proposed = _propose_with_stubbed_dsp(project, defaults, "ripple")

    assert [d.type for d in proposed.decisions] == [EditDecisionType.REMOVE]
    assert "already_muted" not in proposed.skip_counts


def test_already_muted_covers_acoustic_candidates_and_is_per_track():
    from podcast_mcp.edits.fillers import _AnalyzedCut, _CutCandidate, _resolve_analyzed_cuts

    def _cut(track: str, start: float, end: float) -> _AnalyzedCut:
        return _AnalyzedCut(
            hit_id=f"cut_filler_{round(start * 1000)}_{round(end * 1000)}_{track}",
            track_id=track,
            start=start,
            end=end,
            reason="filler:acoustic",
            review_required=True,
            crossfade_ms=5,
            cut_confidence=0.9,
            boundary_mode="test",
            decision_type="mute",
        )

    def _candidate(track: str) -> _CutCandidate:
        return _CutCandidate(
            track,
            0.8,
            1.2,
            "filler:acoustic",
            "filler",
            max_end=1.25,
            min_start=0.75,
            review_only=True,
        )

    candidates = [_candidate("host"), _candidate("guest")]
    muted = {"host": [ClipMuteRegion(start_s=0.78, end_s=1.22)]}
    skips: dict[str, int] = {}

    kept = _resolve_analyzed_cuts(
        candidates,
        [_cut("host", 0.8, 1.2), _cut("guest", 0.8, 1.2)],
        muted=muted,
        skip_counts=skips,
    )

    assert [(c.track_id, c.start, c.end) for c in kept] == [("guest", 0.8, 1.2)]
    assert skips == {"already_muted": 1}

    skips = {}
    partial = _resolve_analyzed_cuts(
        candidates[:1], [_cut("host", 0.8, 1.4)], muted=muted, skip_counts=skips
    )
    assert len(partial) == 1
    assert skips == {}


def _render_samples(project: EpisodeProject) -> np.ndarray:
    out = Path(project.workspace_dir) / "artifacts" / "host.wav"
    render_track_from_timeline(project, project.tracks[0], out, {})
    return load_mono_window(out, duration_sec=10.0, sample_rate=48_000)


def _approved_silent_mute(tmp_path: Path) -> tuple[EpisodeProject, ClipMuteRegion, np.ndarray]:
    """The noise-floor ``uh`` muted as digital silence, its region and its whole render."""
    from unittest.mock import patch

    project = _noise_floor_project(tmp_path)
    with patch("podcast_mcp.edits.decisions.filler_pad_mode", return_value="silence"):
        assert approve_edits(project, ["m1"]) == 1
    (region,) = project.clips[0].mute_regions
    return project, region, _render_samples(project)


def _silent_span(region: ClipMuteRegion) -> tuple[float, float]:
    return region.start_s + region.fade_out_ms / 1000, region.end_s - region.fade_in_ms / 1000


def _samples(audio: np.ndarray, start: float, end: float) -> np.ndarray:
    return audio[round(start * 48_000) : round(end * 48_000)]


def test_split_inside_a_mute_renders_like_the_unsplit_mute(tmp_path):
    from podcast_mcp.project_store import ProjectStore

    project, region, whole = _approved_silent_mute(tmp_path)
    silent_start, silent_end = _silent_span(region)
    path = Path(project.workspace_dir) / "episode.project.json"
    ProjectStore(path).commit(project)
    ws = ProjectWorkspace.open(path)
    unsplit = [c.model_dump() for c in ws.project.clips]

    EditService(ws).split_clip(1.15, track_id="host")

    split = [c.model_dump() for c in ws.project.clips]
    assert len(split) == 2
    rendered = _render_samples(ws.project)
    assert np.count_nonzero(_samples(rendered, silent_start, silent_end)) == 0
    assert np.max(np.abs(rendered - whole)) < 1e-4
    HistoryService(ws).undo()
    assert [c.model_dump() for c in ws.project.clips] == unsplit
    HistoryService(ws).redo()
    assert [c.model_dump() for c in ws.project.clips] == split


@pytest.mark.parametrize("edge", ["in", "out"])
def test_trim_inside_a_mute_keeps_the_kept_part_silent(tmp_path, edge):
    from ripple_helpers import trim

    project, region, whole = _approved_silent_mute(tmp_path)
    silent_start, silent_end = _silent_span(region)

    trim(project, "c1", edge, 1.15)

    rendered = _render_samples(project)
    if edge == "in":
        silent = (0.0, silent_end - 1.15)
        actual, expected = _samples(rendered, 0.0, 1.85), _samples(whole, 1.15, 3.0)
    else:
        silent = (silent_start, 1.15)
        actual, expected = _samples(rendered, 0.0, 1.15), _samples(whole, 0.0, 1.15)
    assert np.count_nonzero(_samples(rendered, *silent)) == 0
    assert np.max(np.abs(actual - expected)) < 1e-4


def test_partial_copy_of_a_mute_pastes_silent_up_to_the_cut(tmp_path):
    from podcast_mcp.edits.clips_ops import extract_clips_in_timeline_range
    from podcast_mcp.edits.mute_regions import mute_regions_payload
    from podcast_mcp.edits.timeline_ops import paste_segment

    project, region, whole = _approved_silent_mute(tmp_path)
    _, silent_end = _silent_span(region)
    (copied,) = extract_clips_in_timeline_range(project.clips, 1.15, 2.0)

    paste_segment(
        project,
        mode=EditMode.RIPPLE,
        insert_at=4.0,
        duration=0.85,
        extracts=[
            {
                "track_id": "host",
                "source_start": copied.source_start,
                "source_end": copied.source_end,
                "mute_regions": mute_regions_payload(copied.mute_regions),
            }
        ],
    )

    rendered = _render_samples(project)
    assert np.count_nonzero(_samples(rendered, 4.0, 4.0 + silent_end - 1.15)) == 0
    assert np.max(np.abs(_samples(rendered, 4.0, 4.85) - _samples(whole, 1.15, 2.0))) < 1e-4


def _approved_mute_workspace(tmp_path: Path):
    from podcast_mcp.project_store import ProjectStore

    project, region, whole = _approved_silent_mute(tmp_path)
    path = Path(project.workspace_dir) / "episode.project.json"
    ProjectStore(path).commit(project)
    return ProjectWorkspace.open(path), region, whole


def _trim(ws: ProjectWorkspace, edge: str, source_sec: float) -> None:
    from podcast_mcp.services.document.boundary import TrimBoundaryTarget, boundary_context

    token = boundary_context(ws.project, TrimBoundaryTarget(clip_id="c1", edge=edge)).token
    EditService(ws).trim_clip_edge(
        "c1", edge, source_sec, mode=EditMode.RIPPLE, expected_token=token
    )


def _regions(ws: ProjectWorkspace) -> list[tuple[float, float]]:
    return [(r.start_s, r.end_s) for r in ws.project.clips[0].mute_regions]


@pytest.mark.parametrize(
    ("edge", "past", "back"),
    [("in", 2.0, 0.0), ("out", 0.5, 4.0)],
)
def test_trim_past_a_mute_then_back_keeps_the_span_silent(tmp_path, edge, past, back):
    ws, region, whole = _approved_mute_workspace(tmp_path)
    silent_start, silent_end = _silent_span(region)

    _trim(ws, edge, past)
    _trim(ws, edge, back)

    rendered = _render_samples(ws.project)
    assert np.count_nonzero(_samples(rendered, silent_start, silent_end)) == 0
    assert np.max(np.abs(rendered - whole)) < 1e-4
    assert _regions(ws) == [(region.start_s, region.end_s)]


def test_trim_past_a_mute_undo_and_redo_are_exact(tmp_path):
    ws, region, _ = _approved_mute_workspace(tmp_path)
    states = [[c.model_dump() for c in ws.project.clips]]

    _trim(ws, "in", 2.0)
    states.append([c.model_dump() for c in ws.project.clips])
    _trim(ws, "in", 0.0)
    states.append([c.model_dump() for c in ws.project.clips])

    assert _regions(ws) == [(region.start_s, region.end_s)]
    for expected in reversed(states[:-1]):
        HistoryService(ws).undo()
        assert [c.model_dump() for c in ws.project.clips] == expected
    for expected in states[1:]:
        HistoryService(ws).redo()
        assert [c.model_dump() for c in ws.project.clips] == expected


def test_repeated_trims_never_duplicate_the_saved_mute_region(tmp_path):
    ws, region, _ = _approved_mute_workspace(tmp_path)
    for edge, positions in (("in", (2.0, 0.0, 1.1, 0.5)), ("out", (0.5, 4.0, 1.2, 3.0))):
        for source_sec in positions:
            _trim(ws, edge, source_sec)

    saved = json.loads((Path(ws.project.workspace_dir) / "episode.project.json").read_text())
    (clip,) = saved["timeline"]["clips"]
    assert [(r["start_s"], r["end_s"]) for r in clip["mute_regions"]] == [
        (region.start_s, region.end_s)
    ]


def _roll(ws: ProjectWorkspace, delta_sec: float) -> None:
    from podcast_mcp.services.document.boundary import RollBoundaryTarget, boundary_context

    left, right = ws.project.clips[:2]
    target = RollBoundaryTarget(left_clip_id=left.id, right_clip_id=right.id)
    token = boundary_context(ws.project, target).token
    EditService(ws).roll_clip_join(left.id, right.id, delta_sec, expected_token=token)


def _split_workspace(tmp_path: Path, split_at: float):
    ws, region, whole = _approved_mute_workspace(tmp_path)
    EditService(ws).split_clip(split_at, track_id="host")
    assert len(ws.project.clips) == 2
    return ws, region, whole


def _clip_regions(ws: ProjectWorkspace) -> list[list[tuple[float, float]]]:
    return [[(r.start_s, r.end_s) for r in c.mute_regions] for c in ws.project.clips]


# The mute sits at 1.0-1.3 s. Rolling the join across it hands it to the other clip.
@pytest.mark.parametrize(
    ("split_at", "delta"),
    [(2.0, -1.2), (0.5, 1.2)],
    ids=["left_clip_rolled_past", "right_clip_rolled_past"],
)
def test_roll_past_a_mute_keeps_the_span_silent(tmp_path, split_at, delta):
    ws, region, whole = _split_workspace(tmp_path, split_at)
    silent_start, silent_end = _silent_span(region)

    _roll(ws, delta)

    left, right = ws.project.clips
    assert left.source_end == pytest.approx(split_at + delta)
    assert right.source_start == pytest.approx(split_at + delta)
    rendered = _render_samples(ws.project)
    assert np.count_nonzero(_samples(rendered, silent_start, silent_end)) == 0
    # Only the join's own micro-fade may differ from the unrolled mute.
    join = split_at + delta
    away = np.ones(rendered.size, dtype=bool)
    away[round((join - 0.05) * 48_000) : round((join + 0.05) * 48_000)] = False
    assert np.max(np.abs(rendered - whole)[away]) < 1e-4
    assert all(regions == [(region.start_s, region.end_s)] for regions in _clip_regions(ws))


def test_roll_past_a_mute_undo_and_redo_are_exact(tmp_path):
    ws, region, _ = _split_workspace(tmp_path, 2.0)
    states = [[c.model_dump() for c in ws.project.clips]]

    _roll(ws, -1.2)
    assert _clip_regions(ws) == [[(region.start_s, region.end_s)]] * 2
    states.append([c.model_dump() for c in ws.project.clips])
    _roll(ws, 1.2)
    states.append([c.model_dump() for c in ws.project.clips])

    for expected in reversed(states[:-1]):
        HistoryService(ws).undo()
        assert [c.model_dump() for c in ws.project.clips] == expected
    for expected in states[1:]:
        HistoryService(ws).redo()
        assert [c.model_dump() for c in ws.project.clips] == expected


def test_repeated_rolls_never_duplicate_the_saved_mute_region(tmp_path):
    ws, region, _ = _split_workspace(tmp_path, 2.0)
    for delta in (-1.2, 0.5, -0.4, 1.0, -1.5):
        _roll(ws, delta)

    saved = json.loads((Path(ws.project.workspace_dir) / "episode.project.json").read_text())
    for clip in saved["timeline"]["clips"]:
        assert [(r["start_s"], r["end_s"]) for r in clip["mute_regions"]] == [
            (region.start_s, region.end_s)
        ]


def test_roll_between_different_sources_keeps_each_clips_regions():
    from podcast_mcp.edits.clips_ops import roll_clip_join

    project = EpisodeProject.create("p", "/tmp/ws")
    project.sources.extend(
        [
            SourceRecording(id="s1", path="raw/a.wav", speaker="Host", duration_sec=10.0),
            SourceRecording(id="s2", path="raw/b.wav", speaker="Host", duration_sec=10.0),
        ]
    )
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/a.wav", duration_sec=10.0),
        )
    ]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_id="s1",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
            mute_regions=[ClipMuteRegion(start_s=1.0, end_s=3.0)],
        ),
        Clip(
            id="c2",
            track_id="host",
            source_id="s2",
            source_start=5.0,
            source_end=8.0,
            timeline_start=5.0,
            mute_regions=[ClipMuteRegion(start_s=5.0, end_s=5.4)],
        ),
    ]

    roll_clip_join(project, "c1", "c2", -0.8)

    left, right = project.clips
    assert [(r.start_s, r.end_s) for r in left.mute_regions] == [(1.0, 3.0)]
    assert [(r.start_s, r.end_s) for r in right.mute_regions] == [(5.0, 5.4)]
