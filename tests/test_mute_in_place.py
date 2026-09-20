from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.clips_ops import split_clip_at
from podcast_mcp.edits.decisions import apply_auto_edits, approve_edits, reject_edits
from podcast_mcp.edits.fillers import analyze_fillers_and_pauses
from podcast_mcp.edits.mute_regions import (
    MUTE_FADE_SEC,
    add_source_mute,
    intersect_mute_regions,
    merge_mute_regions,
    mute_spans_for_source_window,
    subtract_source_mute,
)
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.edits.transcript_cuts import append_remove_decision
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.audio_audit import measure_window_rms_db
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.models import (
    Clip,
    ClipMuteRegion,
    EditDecision,
    EditDecisionType,
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
from podcast_mcp.services import EditService, ProjectWorkspace
from podcast_mcp.services.history import HistoryService


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


def test_merge_and_intersect_mute_regions():
    overlapping = merge_mute_regions(
        [
            ClipMuteRegion(start_s=1.0, end_s=1.4),
            ClipMuteRegion(start_s=1.3, end_s=1.8),
            ClipMuteRegion(start_s=3.0, end_s=3.2),
        ]
    )
    assert [(r.start_s, r.end_s) for r in overlapping] == [(1.0, 1.8), (3.0, 3.2)]
    clipped = intersect_mute_regions(overlapping, 1.5, 3.1)
    assert [(r.start_s, r.end_s) for r in clipped] == [(1.5, 1.8), (3.0, 3.1)]
    assert merge_mute_regions([]) == []
    assert intersect_mute_regions(overlapping, 2.0, 2.5) == []
    clip = Clip(
        id="c",
        track_id="host",
        source_start=0.0,
        source_end=1.0,
        timeline_start=0.0,
    )
    assert add_source_mute(clip, 2.0, 2.4) is False
    assert clip.mute_regions == []
    assert add_source_mute(clip, 0.4, 0.2) is False
    add_source_mute(clip, 0.2, 0.4)
    assert mute_spans_for_source_window(clip, 0.0, 1.0) == ((0.2, 0.4),)
    assert subtract_source_mute(clip, 0.5, 0.4) is False
    assert subtract_source_mute(clip, 0.8, 0.9) is False
    assert subtract_source_mute(clip, 0.2, 0.4) is True
    assert clip.mute_regions == []
    assert subtract_source_mute(clip, 0.2, 0.4) is False
    assert FFmpegEngine()._mute_chain(0.5, ((1.4, 1.6),)) == []


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
        assert analyze_fillers_and_pauses(project, project.transcripts[0], defaults) == []
    with (
        patch("podcast_mcp.edits.fillers.optimize_and_assess", side_effect=_opt),
        patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=5),
        patch(
            "podcast_mcp.edits.join_continuity.assess_proposed_cut",
            return_value=SimpleNamespace(verdict="fail"),
        ),
    ):
        assert analyze_fillers_and_pauses(project, project.transcripts[0], defaults) == []
    with (
        patch("podcast_mcp.edits.fillers.optimize_and_assess", side_effect=_opt),
        patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=5),
        patch(
            "podcast_mcp.edits.join_continuity.assess_proposed_cut",
            return_value=SimpleNamespace(verdict="review"),
        ),
    ):
        reviewed = analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert reviewed
    assert all(d.review_required for d in reviewed)
    assert all(":join_review" in (d.reason or "") for d in reviewed)


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
            {"tighten": {"filler_words": ["um", "uh"], "min_filler_cluster": 2}},
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
    assert host.mute_regions
    assert host.mute_regions[0].start_s == pytest.approx(0.4)
    assert host.mute_regions[0].end_s == pytest.approx(0.7)


def test_rendered_mute_is_silent_inside_and_unchanged_outside(tmp_path, sample_wav):
    project = _project_with_audio(tmp_path, sample_wav)
    host = next(c for c in project.clips if c.track_id == "host")
    add_source_mute(host, 0.4, 0.7)
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
    assert MUTE_FADE_SEC <= 0.005


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

    project = _project_with_audio(tmp_path, sample_wav)
    add_source_mute(project.clips[0], 0.2, 0.4)
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
    assert loaded.clips[0].mute_regions[0].end_s == pytest.approx(0.4)


def test_extract_segment_honours_mute_spans(tmp_path, sample_wav):
    out = tmp_path / "muted.wav"
    FFmpegEngine().extract_segment(
        sample_wav,
        out,
        0.0,
        1.5,
        mute_spans=((0.4, 0.7),),
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


def test_split_clip_keeps_intersected_mute_regions():
    clip = Clip(
        id="c1",
        track_id="host",
        source_start=0.0,
        source_end=2.0,
        timeline_start=0.0,
        mute_regions=[ClipMuteRegion(start_s=0.2, end_s=0.8)],
    )
    before, after = split_clip_at(clip, 0.5)
    assert [(r.start_s, r.end_s) for r in before.mute_regions] == [(0.2, 0.5)]
    assert [(r.start_s, r.end_s) for r in after.mute_regions] == [(0.5, 0.8)]


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
    add_source_mute(c1, 0.1, 0.4)
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
    add_source_mute(host, 0.2, 0.35)
    add_source_mute(host, 0.9, 1.15)
    out = Path(project.workspace_dir) / "artifacts" / "host.wav"
    render_track_from_timeline(project, project.tracks[0], out, {})
    first = measure_window_rms_db(out, 0.24, 0.32)
    second = measure_window_rms_db(out, 0.96, 1.1)
    mid = measure_window_rms_db(out, 0.5, 0.7)
    assert first is not None and first <= -60.0
    assert second is not None and second <= -60.0
    assert mid is not None and mid > -40.0
    chain = FFmpegEngine()._mute_chain(0.5, ((0.4, 0.4), (0.1, 0.3)))
    assert any(p.startswith("volume=") for p in chain)
    assert any(p.startswith("asetnsamples=") for p in chain)
    assert sum(1 for p in chain if p.startswith("volume=")) == 1


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
        build_clips_after_removes,
        extract_clips_in_timeline_range,
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
    assert [(r.start_s, r.end_s) for r in extracted[0].mute_regions] == [(0.3, 0.6)]

    project = EpisodeProject.create("p", "/tmp/ws")
    project.tracks = [Track(id="host", label="Host", role=TrackRole.DIALOGUE)]
    project.clips = [clip]
    rebuilt = build_clips_after_removes(project, "host", [(0.4, 0.5)])
    mutes = [(round(r.start_s, 6), round(r.end_s, 6)) for c in rebuilt for r in c.mute_regions]
    assert (0.2, 0.4) in mutes
    assert (0.5, 0.8) in mutes


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
    add_source_mute(project.clips[0], 0.2, 0.4)
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
    assert approve_edits(project, ["miss"]) == 1
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


def test_paste_and_trim_keep_intersected_mute_regions():
    from podcast_mcp.edits.clips_ops import roll_clip_join, trim_clip_edge
    from podcast_mcp.edits.timeline_ops import paste_segment

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
    assert [(r.start_s, r.end_s) for r in pasted[0].mute_regions] == [(1.5, 2.5)]

    trim_clip_edge(project, "c1", "out", 2.0)
    trimmed = next(c for c in project.clips if c.id == "c1")
    assert [(r.start_s, r.end_s) for r in trimmed.mute_regions] == [(1.0, 2.0)]

    roll_clip_join(project, "c1", "c2", 0.5)
    left = next(c for c in project.clips if c.id == "c1")
    right = next(c for c in project.clips if c.id == "c2")
    assert all(r.end_s <= left.source_end + 1e-9 for r in left.mute_regions)
    assert all(r.start_s >= right.source_start - 1e-9 for r in right.mute_regions)


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


def test_mute_skip_reason_shared_with_play_range_ts():
    from podcast_mcp.edits.pending_preview import SKIP_REASON_MUTE, resolve_pending_preview

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
    window = resolve_pending_preview(project, "m1")
    assert window.can_skip is False
    assert window.skip_reason == SKIP_REASON_MUTE
    ts = (
        Path(__file__).resolve().parents[1] / "gui" / "web" / "src" / "utils" / "playRange.ts"
    ).read_text(encoding="utf-8")
    assert SKIP_REASON_MUTE in ts


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


def test_mute_chain_folds_spans_and_guards_short_holes():
    from podcast_mcp.edits.mute_regions import MUTE_FADE_SEC

    folded = FFmpegEngine()._mute_chain(1.0, ((0.1, 0.3), (0.5, 0.7)))
    assert len([p for p in folded if p.startswith("volume=")]) == 1
    assert folded[0] == "asetnsamples=n=48:p=0"
    short = FFmpegEngine()._mute_chain(1.0, ((0.1, 0.1 + MUTE_FADE_SEC),))
    assert "1-(t-" not in short[1]
    rate = FFmpegEngine()._mute_chain(1.0, ((0.1, 0.3),), sample_rate=44100)
    assert rate[0] == "asetnsamples=n=44:p=0"


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
        add_source_mute(p.clips[0], 0.2, 0.4)
        raise RuntimeError("mutate failed")

    with pytest.raises(RuntimeError, match="mutate failed"):
        run_mutation(path, project, "before", "after", boom)
    after = [(c.id, [(r.start_s, r.end_s) for r in c.mute_regions]) for c in project.clips]
    assert after == before


def test_revert_mute_error_paths_and_per_track_source(tmp_path, sample_wav):
    from podcast_mcp.edits.edit_log import revert_applied_edit
    from podcast_mcp.models import AppliedEditRecord

    project = _project_with_audio(tmp_path, sample_wav)
    add_source_mute(project.clips[0], 0.4, 0.7)
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
    add_source_mute(host, 0.4, 0.7)
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
