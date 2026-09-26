from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.edits.fillers import analyze_fillers_and_pauses
from podcast_mcp.edits.transcript_cuts import search_transcript
from podcast_mcp.edits.transcript_reconcile import (
    maybe_auto_reconcile,
    overlap_duplicate_report,
    run_reconciliation,
)
from podcast_mcp.edits.transcript_refine_status import status_is_clear
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    compute_word_audibility_map,
    list_flagged_words,
)
from podcast_mcp.engines.reconciliation_state import (
    audio_state_fingerprint,
    mark_reconciliation_fresh,
    mark_reconciliation_stale,
    reconciliation_is_stale,
    reconciliation_status,
)
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.engines.transcript_reconcile import (
    ReconciliationResult,
    _reconcile_word,
    reconcile_transcript,
)
from podcast_mcp.history.session import run_mutation
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    save_project,
)
from podcast_mcp.pipeline.runner import STEP_NAMES
from podcast_mcp.services import EditService, PipelineService, ProjectWorkspace


def _two_track_project(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    for tid, speaker in (("host", "Host"), ("guest", "Guest")):
        raw = tmp_path / "raw" / f"{tid}.wav"
        raw.parent.mkdir(exist_ok=True)
        raw.write_bytes(b"\x00" * 100)
        project.timeline.tracks.append(
            Track(
                id=tid,
                label=speaker,
                role=TrackRole.DIALOGUE,
                speaker=speaker,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=10.0),
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"c-{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=10.0,
                timeline_start=0.0,
            )
        )
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.5, confidence=0.9),
                TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.9),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="world", start=0.0, end=0.5, confidence=0.9),
            ],
        ),
    ]
    return project


def test_extracted_reconcile_word_exact_contract() -> None:
    transcript = Transcript(
        track_id="host",
        words=[TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.9)],
    )
    result = ReconciliationResult()
    _reconcile_word(
        transcript,
        0,
        {"audibility_status": "bleed", "dominant_track": "guest", "reason": "dominant"},
        result,
        update_status=True,
        apply_suppression=True,
        start_sec=0.0,
        end_sec=2.0,
    )
    assert result.to_dict() == {
        "suppress": [
            {
                "track_id": "host",
                "word_index": 0,
                "text": "bleed",
                "start": 1.0,
                "end": 1.5,
                "audibility_status": "bleed",
                "dominant_track": "guest",
                "reason": "dominant",
            }
        ],
        "unsuppress": [],
        "reattribute": [
            {
                "track_id": "host",
                "word_index": 0,
                "text": "bleed",
                "start": 1.0,
                "end": 1.5,
                "audibility_status": "bleed",
                "dominant_track": "guest",
                "reason": "dominant",
                "attributed_to_track": "guest",
            }
        ],
        "status_updates": 1,
        "applied": False,
        "suppress_count": 1,
        "unsuppress_count": 0,
        "reattribute_count": 1,
    }
    assert transcript.words[0].suppressed is True
    assert transcript.words[0].audibility_status == "bleed"
    assert transcript.words[0].dominant_track == "guest"

    outside = ReconciliationResult()
    _reconcile_word(
        transcript,
        0,
        {"audibility_status": "audible"},
        outside,
        update_status=True,
        apply_suppression=True,
        start_sec=2.0,
        end_sec=None,
    )
    assert outside.to_dict()["status_updates"] == 0
    assert outside.unsuppress == []
    assert transcript.words[0].suppressed is True


def test_analysis_policy_bleed_defaults():
    pol = AnalysisPolicy.from_defaults()
    assert pol.bleed_dominance_db == 6.0
    assert pol.bleed_min_other_rms_db == -50.0
    assert pol.reconcile_on_render is True
    assert pol.transcript_mode == "reconcile"
    assert pol.bleed_text_match_enabled is True
    assert pol.bleed_text_match_min_overlap_sec == 0.02


def test_run_reconciliation_applies_by_default(tmp_path: Path):
    project = _two_track_project(tmp_path)
    pol = AnalysisPolicy.from_defaults()

    def fake_rms(project, track_id, t_start, t_end, **kwargs):
        if track_id == "host" and t_start >= 1.0:
            return -40.0
        if track_id == "guest" and t_start >= 1.0:
            return -30.0
        return -30.0

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=fake_rms,
    ):
        result = run_reconciliation(project, dry_run=None, policy=pol)

    host = project.transcript_for_track("host")
    assert host is not None
    assert host.words[1].suppressed is True
    assert result["applied"] is True


@pytest.mark.refine_gate
def test_pipeline_refreshes_waiver_after_real_reconciliation(tmp_path: Path):
    project = _two_track_project(tmp_path)
    project_path = tmp_path / "episode.project.json"
    save_project(project, project_path)
    workspace = ProjectWorkspace.open(project_path)
    skip = [
        name
        for name in STEP_NAMES
        if name not in {"require_transcript_refine", "reconcile_transcript"}
    ]

    def fake_rms(project, track_id, t_start, t_end, **kwargs):
        if track_id == "host" and t_start >= 1.0:
            return -40.0
        return -30.0

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=fake_rms,
    ):
        PipelineService(workspace).run(
            from_step="require_transcript_refine",
            skip_steps=skip,
            unattended=True,
            config={"analysis": {"transcript_refine": {"mode": "waive_unattended"}}},
        )

    host = workspace.project.transcript_for_track("host")
    assert host is not None
    assert host.words[1].suppressed is True
    assert status_is_clear(workspace.project)
    assert EditService(workspace).approve([]) == 0


def test_compute_word_audibility_map_bleed(tmp_path: Path):
    project = _two_track_project(tmp_path)
    pol = AnalysisPolicy(audibility_rms_db=-42.0, bleed_dominance_db=6.0)

    def fake_rms(project, track_id, t_start, t_end, **kwargs):
        if track_id == "host" and t_start >= 1.0:
            return -40.0
        if track_id == "guest" and t_start >= 1.0:
            return -30.0
        if track_id == "host":
            return -30.0
        return -35.0

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=fake_rms,
    ):
        rows = compute_word_audibility_map(project, policy=pol)

    bleed_rows = [r for r in rows if r["audibility_status"] == "bleed"]
    assert len(bleed_rows) == 1
    assert bleed_rows[0]["text"] == "bleed"
    assert bleed_rows[0]["dominant_track"] == "guest"


def test_list_flagged_words_includes_inaudible_and_bleed(tmp_path: Path):
    project = _two_track_project(tmp_path)
    pol = AnalysisPolicy(audibility_rms_db=-35.0, bleed_dominance_db=6.0)

    def fake_rms(project, track_id, t_start, t_end, **kwargs):
        if track_id == "host" and t_start >= 1.0:
            return -40.0
        if track_id == "guest" and t_start >= 1.0:
            return -30.0
        return -50.0

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=fake_rms,
    ):
        flagged = list_flagged_words(project, policy=pol)

    assert len(flagged) >= 2
    statuses = {f["audibility_status"] for f in flagged}
    assert "bleed" in statuses
    assert "inaudible" in statuses


def test_reconcile_transcript_skips_text_match_when_disabled(tmp_path: Path):
    project = _two_track_project(tmp_path)
    guest = project.transcript_for_track("guest")
    assert guest is not None
    guest.words.append(TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.85))
    pol = AnalysisPolicy(
        transcript_mode="reconcile",
        bleed_text_match_enabled=False,
    )

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        return_value=-35.0,
    ):
        result = reconcile_transcript(project, policy=pol, dry_run=False, update_status=True)

    assert not any(s.get("reason") == "text_match_overlap" for s in result.suppress)


def test_reconcile_transcript_text_match_overlap(tmp_path: Path):
    project = _two_track_project(tmp_path)
    guest = project.transcript_for_track("guest")
    assert guest is not None
    guest.words.append(TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.85))
    pol = AnalysisPolicy(transcript_mode="reconcile", bleed_text_match_enabled=True)

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        return_value=-35.0,
    ):
        result = reconcile_transcript(project, policy=pol, dry_run=False, update_status=True)

    guest = project.transcript_for_track("guest")
    assert guest is not None
    assert guest.words[1].suppressed is True
    assert guest.words[1].dominant_track == "host"
    assert any(s.get("reason") == "text_match_overlap" for s in result.suppress)


def test_reconcile_transcript_suppresses_bleed(tmp_path: Path):
    project = _two_track_project(tmp_path)
    pol = AnalysisPolicy(transcript_mode="reconcile", bleed_dominance_db=6.0)

    def fake_rms(project, track_id, t_start, t_end, **kwargs):
        if track_id == "host" and t_start >= 1.0:
            return -40.0
        if track_id == "guest" and t_start >= 1.0:
            return -30.0
        return -30.0

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=fake_rms,
    ):
        result = reconcile_transcript(project, policy=pol, dry_run=False, update_status=True)

    host = project.transcript_for_track("host")
    assert host is not None
    assert host.words[1].suppressed is True
    assert host.words[1].audibility_status == "bleed"
    assert len(result.suppress) == 1
    assert project.combined_transcript is not None
    combined_text = " ".join(u.text for u in project.combined_transcript.utterances)
    assert "bleed" not in combined_text


def test_reconcile_unsuppresses_when_audible_again(tmp_path: Path):
    project = _two_track_project(tmp_path)
    host = project.transcript_for_track("host")
    assert host is not None
    host.words[1] = host.words[1].model_copy(
        update={"suppressed": True, "audibility_status": "bleed"}
    )
    pol = AnalysisPolicy(transcript_mode="reconcile")

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        return_value=-30.0,
    ):
        result = reconcile_transcript(project, policy=pol, dry_run=False, update_status=True)

    assert host.words[1].suppressed is False
    assert host.words[1].audibility_status == "audible"
    assert len(result.unsuppress) == 1


def test_audio_state_fingerprint_changes_on_effect(tmp_path: Path):
    project = _two_track_project(tmp_path)
    before = audio_state_fingerprint(project)
    project.processing_chains = [
        ProcessingChain(
            track_id="host",
            effects=[ProcessingEffect(effect="agate", params={"threshold_db": -30})],
        )
    ]
    after = audio_state_fingerprint(project)
    assert before != after


def test_reconciliation_stale_tracking(tmp_path: Path):
    project = _two_track_project(tmp_path)
    assert reconciliation_is_stale(project)
    mark_reconciliation_fresh(project)
    assert not reconciliation_is_stale(project)
    mark_reconciliation_stale(project)
    status = reconciliation_status(project)
    assert status["stale"] is True


def test_maybe_auto_reconcile_skips_when_fresh(tmp_path: Path):
    project = _two_track_project(tmp_path)
    mark_reconciliation_fresh(project)
    with patch("podcast_mcp.edits.transcript_reconcile.run_reconciliation") as run_rec:
        result = maybe_auto_reconcile(project)
    assert result is None
    run_rec.assert_not_called()


def test_maybe_auto_reconcile_runs_when_stale(tmp_path: Path):
    project = _two_track_project(tmp_path)
    mark_reconciliation_stale(project)
    with patch(
        "podcast_mcp.edits.transcript_reconcile.run_reconciliation",
        return_value={"status_updates": 2},
    ) as run_rec:
        result = maybe_auto_reconcile(project, force=True)
    assert result == {"status_updates": 2}
    run_rec.assert_called_once()


def test_run_mutation_marks_stale_on_audio_change(tmp_path: Path):
    from podcast_mcp.models import save_project
    from podcast_mcp.project_store import ProjectStore

    project = _two_track_project(tmp_path)
    path = save_project(project)
    mark_reconciliation_fresh(project)
    ProjectStore(path).commit(project)

    def add_gate(p: EpisodeProject) -> None:
        p.processing_chains = [
            ProcessingChain(
                track_id="host",
                effects=[ProcessingEffect(effect="agate", params={})],
            )
        ]

    run_mutation(path, project, "before", "after", add_gate)
    assert project.reconciliation_stale is True


def test_run_mutation_skips_auto_reconcile_when_stems_stale(tmp_path: Path):
    from podcast_mcp.engines.play_audit import write_stem_hash
    from podcast_mcp.models import save_project
    from podcast_mcp.project_store import ProjectStore

    project = _two_track_project(tmp_path)
    path = save_project(project)
    mark_reconciliation_fresh(project)
    ProjectStore(path).commit(project)

    for tid in ("host", "guest"):
        stem = project.artifacts_dir() / "tracks" / f"{tid}.wav"
        stem.parent.mkdir(parents=True, exist_ok=True)
        stem.write_bytes(b"\x00" * 100)
        write_stem_hash(project, tid)

    def add_gate(p: EpisodeProject) -> None:
        p.processing_chains = [
            ProcessingChain(
                track_id="host",
                effects=[ProcessingEffect(effect="agate", params={})],
            )
        ]

    with patch(
        "podcast_mcp.history.session.maybe_auto_reconcile",
        return_value={"status_updates": 1},
    ) as auto_rec:
        run_mutation(path, project, "before", "after", add_gate)

    auto_rec.assert_not_called()
    assert project.reconciliation_stale is True


def test_fillers_skip_suppressed_words(tmp_path: Path):
    project = _two_track_project(tmp_path)
    tr = project.transcript_for_track("host")
    assert tr is not None
    tr.words[0] = tr.words[0].model_copy(update={"text": "um", "suppressed": True})
    defaults = {"tighten": {"filler_words": ["um"], "max_pause_sec": 99.0}}
    decisions = analyze_fillers_and_pauses(project, tr, defaults)
    assert len(decisions) == 0


def test_search_transcript_excludes_suppressed_by_default(tmp_path: Path):
    project = _two_track_project(tmp_path)
    host = project.transcript_for_track("host")
    assert host is not None
    host.words[1] = host.words[1].model_copy(update={"suppressed": True})
    project.combined_transcript = TranscriptionEngine().merge_transcripts(project)

    matches = search_transcript(project, "bleed", track_id="host")
    assert len(matches) == 0

    matches_all = search_transcript(project, "bleed", track_id="host", include_suppressed=True)
    assert len(matches_all) == 1


def test_overlap_report_matches_pairwise_for_unsorted_and_long_words(tmp_path: Path) -> None:
    project = _two_track_project(tmp_path)
    host = project.transcript_for_track("host")
    guest = project.transcript_for_track("guest")
    assert host is not None and guest is not None
    host.words = [
        TranscriptWord(text="late", start=8.0, end=8.4),
        TranscriptWord(text="long", start=0.0, end=9.0),
        TranscriptWord(text="middle", start=4.0, end=4.3),
    ]
    guest.words = [
        TranscriptWord(text="end", start=8.2, end=8.5),
        TranscriptWord(text="early", start=1.0, end=1.2),
        TranscriptWord(text="middle", start=4.1, end=4.2),
    ]
    host.words.append(TranscriptWord(text="tail", start=8.3, end=8.35))
    first, second = guest, host
    expected = [
        (ia, ib)
        for ia, a in enumerate(first.words)
        for ib, b in enumerate(second.words)
        if min(a.end, b.end) > max(a.start, b.start)
    ]
    expected.sort(key=lambda pair: first.words[pair[0]].start)
    with patch(
        "podcast_mcp.edits.transcript_reconcile.compute_word_audibility_map", return_value=[]
    ):
        rows = overlap_duplicate_report(project)["pairs"]
    assert [(row["word_index_a"], row["word_index_b"]) for row in rows] == expected
