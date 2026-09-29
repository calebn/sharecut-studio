from __future__ import annotations

import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np
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


def test_reconcile_word_never_auto_suppresses_ignored_word() -> None:
    transcript = Transcript(
        track_id="host",
        words=[TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.9, ignored=True)],
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
    assert result.to_dict()["status_updates"] == 0
    assert result.suppress == []
    assert result.reattribute == []
    assert transcript.words[0].suppressed is False
    assert transcript.words[0].audibility_status is None
    assert transcript.words[0].ignored is True


def test_reconcile_word_never_auto_flips_locked_word() -> None:
    """A word a person/agent explicitly unsuppressed stays that way (#768)."""
    transcript = Transcript(
        track_id="host",
        words=[
            TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.9, audibility_locked=True)
        ],
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
    assert result.to_dict()["status_updates"] == 0
    assert result.suppress == []
    assert result.reattribute == []
    assert transcript.words[0].suppressed is False
    assert transcript.words[0].audibility_status is None
    assert transcript.words[0].audibility_locked is True


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


def test_reconcile_honors_word_suppressed_through_service(tmp_path: Path):
    """A word a person/agent unsuppressed via the service outlives a later reconcile (#768)."""
    project = _two_track_project(tmp_path)
    host = project.transcript_for_track("host")
    assert host is not None
    host.words.append(TranscriptWord(text="unlocked", start=2.0, end=2.5, confidence=0.9))
    project_path = tmp_path / "episode.project.json"
    save_project(project, project_path)
    workspace = ProjectWorkspace.open(project_path)

    # First reconcile would classify word 1 ("bleed") as bleed; the user disagrees
    # and explicitly keeps it audible.
    EditService(workspace).set_word_suppressed("host", 1, False)
    host = workspace.project.transcript_for_track("host")
    assert host is not None
    assert host.words[1].audibility_locked is True
    assert host.words[1].suppressed is False

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
        run_reconciliation(workspace.project, dry_run=None)

    host = workspace.project.transcript_for_track("host")
    assert host is not None
    # Locked word: the user's decision is unchanged.
    assert host.words[1].suppressed is False
    assert host.words[1].audibility_status is None
    # Unlocked word at the same acoustic conditions: still reconciled normally.
    assert host.words[2].suppressed is True
    assert host.words[2].audibility_status == "bleed"


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


def test_reconcile_apply_writes_status_for_text_match_loser_with_update_status_false(
    tmp_path: Path,
):
    """apply_suppression must write the status behind a text-match suppression even when
    a direct engine call passes update_status=False (#791 follow-up: this combination is
    unreachable through run_reconciliation, but trunk left it suppressing the word while
    leaving its audibility_status/dominant_track stale)."""
    project = _two_track_project(tmp_path)
    guest = project.transcript_for_track("guest")
    assert guest is not None
    guest.words.append(TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.85))
    pol = AnalysisPolicy(transcript_mode="reconcile", bleed_text_match_enabled=True)

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        return_value=-35.0,
    ):
        reconcile_transcript(project, policy=pol, dry_run=False, update_status=False)

    guest = project.transcript_for_track("guest")
    assert guest is not None
    assert guest.words[1].suppressed is True
    assert guest.words[1].audibility_status == "bleed"
    assert guest.words[1].dominant_track == "host"


def test_reconcile_flag_mode_tags_text_match_loser_without_suppressing(tmp_path: Path):
    """flag mode (update_status without apply_suppression) must tag a text-match loser's
    audibility_status/dominant_track as bleed/the winner's track without suppressing it
    (#791 follow-up: flag mode previously skipped the text-match override entirely, so the
    loser stayed tagged audible)."""
    project = _two_track_project(tmp_path)
    guest = project.transcript_for_track("guest")
    assert guest is not None
    guest.words.append(TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.85))
    pol = AnalysisPolicy(transcript_mode="flag", bleed_text_match_enabled=True)

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        return_value=-35.0,
    ):
        run_reconciliation(project, policy=pol, dry_run=None)

    guest = project.transcript_for_track("guest")
    assert guest is not None
    assert guest.words[1].suppressed is False
    assert guest.words[1].audibility_status == "bleed"
    assert guest.words[1].dominant_track == "host"


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


def _word_state(
    project: EpisodeProject,
) -> dict[tuple[str, int], tuple[bool, str | None, str | None]]:
    return {
        (tr.track_id, i): (w.suppressed, w.audibility_status, w.dominant_track)
        for tr in project.transcripts
        for i, w in enumerate(tr.words)
    }


def test_reconcile_second_pass_on_unchanged_project_is_a_no_op(tmp_path: Path):
    """Reconcile converges: the acoustic verdict and the text-match verdict agree on one
    target per word, so a repeat run on unchanged audio and text changes nothing (#782)."""
    project = _two_track_project(tmp_path)
    guest = project.transcript_for_track("guest")
    assert guest is not None
    guest.words.append(TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.85))
    pol = AnalysisPolicy(transcript_mode="reconcile", bleed_text_match_enabled=True)

    def fake_rms(project, track_id, t_start, t_end, **kwargs):
        # 0.0-0.5: host dominates -> guest "world" is acoustic bleed.
        # 1.0-1.5: both mics equal -> both "bleed" words are audible; the text-match rule
        # picks the host copy on ASR confidence (0.9 > 0.85).
        if t_start < 1.0:
            return -30.0 if track_id == "host" else -40.0
        return -35.0

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=fake_rms,
    ):
        first = run_reconciliation(project, policy=pol, dry_run=False)
        converged = _word_state(project)
        second = run_reconciliation(project, policy=pol, dry_run=False)

    assert converged == {
        ("host", 0): (False, "audible", None),
        ("host", 1): (False, "audible", None),
        ("guest", 0): (True, "bleed", "host"),
        ("guest", 1): (True, "bleed", "host"),
    }
    assert [(s["track_id"], s["word_index"], s["reason"]) for s in first["suppress"]] == [
        ("guest", 0, "cross_track_bleed"),
        ("guest", 1, "text_match_overlap"),
    ]
    assert first["unsuppress"] == []
    assert [r["attributed_to_track"] for r in first["reattribute"]] == ["host", "host"]
    assert first["status_updates"] == 4

    assert _word_state(project) == converged
    assert {k: second[k] for k in first if k != "reconciliation"} == {
        "suppress": [],
        "unsuppress": [],
        "reattribute": [],
        "status_updates": 0,
        "applied": True,
        "suppress_count": 0,
        "unsuppress_count": 0,
        "reattribute_count": 0,
    }


def _diff_keys(entries: list[dict]) -> set[tuple[str, int]]:
    return {(e["track_id"], e["word_index"]) for e in entries}


def test_reconcile_dry_run_preview_matches_apply_with_text_match_overlap(tmp_path: Path):
    """A dry-run preview must report the same per-word target an apply writes, including
    the text-match override, both on a fresh project and a converged one (#791).

    Before the fix, ``by_key`` only picked up the text-match verdict when
    ``apply_suppression`` was true, so a preview on a converged project fell back to the
    acoustic verdict alone: the acoustically-audible text-match loser read as a spurious
    ``unsuppress`` that the apply, which did see the text-match verdict, never made.
    """
    project = _two_track_project(tmp_path)
    guest = project.transcript_for_track("guest")
    assert guest is not None
    guest.words.append(TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.85))
    pol = AnalysisPolicy(transcript_mode="reconcile", bleed_text_match_enabled=True)

    def fake_rms(project, track_id, t_start, t_end, **kwargs):
        if t_start < 1.0:
            return -30.0 if track_id == "host" else -40.0
        return -35.0

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=fake_rms,
    ):
        before = _word_state(project)
        preview = run_reconciliation(project, policy=pol, dry_run=True)
        assert _word_state(project) == before, "preview must not write"

        applied = run_reconciliation(project, policy=pol, dry_run=False)
        converged = _word_state(project)
        assert converged != before

        for key in ("suppress", "unsuppress", "reattribute"):
            assert _diff_keys(preview[key]) == _diff_keys(applied[key]), key
        assert _diff_keys(preview["suppress"]) == {("guest", 0), ("guest", 1)}

        preview_converged = run_reconciliation(project, policy=pol, dry_run=True)
        assert _word_state(project) == converged, "preview must not write"

        applied_converged = run_reconciliation(project, policy=pol, dry_run=False)
        assert _word_state(project) == converged, "apply on a converged project is a no-op"

    for key in ("suppress", "unsuppress", "reattribute"):
        assert _diff_keys(preview_converged[key]) == _diff_keys(applied_converged[key]) == set(), (
            key
        )


def _sign_off_chain_project(tmp_path: Path) -> EpisodeProject:
    """Three identical "bye" words in a chain, as on the lab tape's sign-off (#805):
    host:0 loses to guest:0, and guest:0 loses to host:1."""
    project = _two_track_project(tmp_path)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="bye", start=1.0, end=1.5, confidence=0.9),
                TranscriptWord(text="bye", start=1.5, end=1.8, confidence=0.9),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[TranscriptWord(text="bye", start=1.3, end=1.8, confidence=0.95)],
        ),
    ]
    return project


def _sign_off_chain_rms(project, track_id, t_start, t_end, **kwargs):
    # Every mic gap stays under bleed_dominance_db, so all three words are acoustically
    # audible and only the text-match rule decides. Host is quieter than guest during
    # its first "bye" and louder during its second.
    if track_id == "host":
        return -36.0 if t_start < 1.5 else -30.0
    return -35.0


_SIGN_OFF_CHAIN_CONVERGED = {
    ("host", 0): (True, "bleed", "guest"),
    ("host", 1): (False, "audible", None),
    ("guest", 0): (True, "bleed", "host"),
}


def test_scoped_and_full_passes_alternate_without_flipping_a_word(tmp_path: Path):
    """A track- or window-scoped pass reads out-of-scope words by their computed target,
    not their stored flags, so it reaches the full pass's target for the words it writes.
    Under the pairwise chain rule a loser to a loser is still a loser (#805)."""
    project = _sign_off_chain_project(tmp_path)
    pol = AnalysisPolicy(transcript_mode="reconcile", bleed_text_match_enabled=True)

    def counts(out: dict) -> tuple[int, int, int, int]:
        return (
            out["suppress_count"],
            out["unsuppress_count"],
            out["reattribute_count"],
            out["status_updates"],
        )

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_sign_off_chain_rms,
    ):
        first = run_reconciliation(project, policy=pol, dry_run=False)
        assert _word_state(project) == _SIGN_OFF_CHAIN_CONVERGED
        assert [(s["track_id"], s["word_index"], s["reason"]) for s in first["suppress"]] == [
            ("host", 0, "text_match_overlap"),
            ("guest", 0, "text_match_overlap"),
        ]
        assert counts(first) == (2, 0, 2, 3)

        later = [
            counts(run_reconciliation(project, policy=pol, dry_run=False, track_id="host")),
            counts(run_reconciliation(project, policy=pol, dry_run=False)),
            counts(run_reconciliation(project, policy=pol, dry_run=False, track_id="guest")),
            counts(run_reconciliation(project, policy=pol, dry_run=False)),
            counts(
                run_reconciliation(project, policy=pol, dry_run=False, start_sec=1.0, end_sec=1.2)
            ),
            counts(run_reconciliation(project, policy=pol, dry_run=False, track_id="host")),
        ]

    assert later == [(0, 0, 0, 0)] * 6
    assert _word_state(project) == _SIGN_OFF_CHAIN_CONVERGED


def test_scoped_pass_writes_only_its_scope_at_the_full_target(tmp_path: Path):
    """A host-scoped pass leaves guest words untouched but writes host words at the target
    a full pass would reach, even when host:0's winner (guest:0) is already stored
    suppressed by an earlier pass. Reading that partner by its stored flag instead of
    its computed target left host:0 audible on trunk (#805)."""
    project = _sign_off_chain_project(tmp_path)
    guest = project.transcript_for_track("guest")
    assert guest is not None
    guest.words[0] = guest.words[0].model_copy(update={"suppressed": True})
    pol = AnalysisPolicy(transcript_mode="reconcile", bleed_text_match_enabled=True)

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        side_effect=_sign_off_chain_rms,
    ):
        scoped = run_reconciliation(project, policy=pol, dry_run=False, track_id="host")
        after_scoped = _word_state(project)
        full = run_reconciliation(project, policy=pol, dry_run=False)

    assert after_scoped == {
        ("host", 0): (True, "bleed", "guest"),
        ("host", 1): (False, "audible", None),
        ("guest", 0): (True, None, None),
    }
    assert [(s["track_id"], s["word_index"]) for s in scoped["suppress"]] == [("host", 0)]
    assert full["suppress"] == []
    assert full["unsuppress"] == []
    assert full["status_updates"] == 1
    assert _word_state(project) == _SIGN_OFF_CHAIN_CONVERGED


def test_window_pass_leaves_text_match_losers_outside_the_window_alone(tmp_path: Path):
    """A start_sec/end_sec pass writes the in-window text-match loser at its target and
    never suppresses or re-tags the losers just outside the window on either side; the
    next full pass picks those up (#805)."""
    project = _two_track_project(tmp_path)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="one", start=1.0, end=1.5, confidence=0.9),
                TranscriptWord(text="two", start=3.0, end=3.5, confidence=0.9),
                TranscriptWord(text="three", start=5.0, end=5.5, confidence=0.9),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="one", start=1.0, end=1.5, confidence=0.95),
                TranscriptWord(text="two", start=3.0, end=3.5, confidence=0.95),
                TranscriptWord(text="three", start=5.0, end=5.5, confidence=0.95),
            ],
        ),
    ]
    pol = AnalysisPolicy(transcript_mode="reconcile", bleed_text_match_enabled=True)

    with patch(
        "podcast_mcp.engines.audio_audit._rms_for_track_at_timeline",
        return_value=-35.0,
    ):
        windowed = run_reconciliation(
            project, policy=pol, dry_run=False, start_sec=2.0, end_sec=4.0
        )
        after_window = _word_state(project)
        full = run_reconciliation(project, policy=pol, dry_run=False)

    assert after_window == {
        ("host", 0): (False, None, None),
        ("host", 1): (True, "bleed", "guest"),
        ("host", 2): (False, None, None),
        ("guest", 0): (False, None, None),
        ("guest", 1): (False, "audible", None),
        ("guest", 2): (False, None, None),
    }
    assert [(s["track_id"], s["word_index"], s["reason"]) for s in windowed["suppress"]] == [
        ("host", 1, "text_match_overlap")
    ]
    assert windowed["status_updates"] == 2
    assert [(s["track_id"], s["word_index"]) for s in full["suppress"]] == [
        ("host", 0),
        ("host", 2),
    ]
    assert _word_state(project) == {
        ("host", 0): (True, "bleed", "guest"),
        ("host", 1): (True, "bleed", "guest"),
        ("host", 2): (True, "bleed", "guest"),
        ("guest", 0): (False, "audible", None),
        ("guest", 1): (False, "audible", None),
        ("guest", 2): (False, "audible", None),
    }


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


_STEM_RATE = 8000


def _voice(seconds: float, *, seed: int) -> np.ndarray:
    """Continuous wideband speech-like noise with syllable-rate bursts."""
    rng = np.random.default_rng(seed)
    n = int(seconds * _STEM_RATE)
    noise = np.convolve(rng.normal(0, 1.0, n), np.ones(2) / 2.0, mode="same")
    t = np.arange(n) / _STEM_RATE
    out = noise * (0.5 + 0.5 * np.sin(2 * np.pi * 4.0 * t + rng.uniform(0, 2 * np.pi)))
    return (0.2 * out / np.max(np.abs(out))).astype(np.float32)


def _zoom_host_stem(guest: np.ndarray) -> np.ndarray:
    """The guest's voice on the host mic: 3 ms late, 18 dB down for the first half of the
    tape and 1 dB *up* for the second, as Zoom's gain does when the host is silent."""
    copy = np.zeros_like(guest)
    copy[24:] = guest[:-24]
    half = guest.size // 2
    copy[:half] *= 10 ** (-18 / 20)
    copy[half:] *= 10 ** (1 / 20)
    return copy


def _write_stem(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(_STEM_RATE)
        handle.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())


def _echo_stem_project(tmp_path: Path) -> EpisodeProject:
    guest = _voice(20.0, seed=3)
    stems = {"guest": guest, "host": _zoom_host_stem(guest)}
    project = EpisodeProject.create("echo", str(tmp_path))
    project.ensure_dirs()
    for tid, samples in stems.items():
        _write_stem(tmp_path / "raw" / f"{tid}.wav", samples)
        _write_stem(project.artifacts_dir() / "tracks" / f"{tid}.wav", samples)
        project.timeline.tracks.append(
            Track(
                id=tid,
                label=tid,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=20.0),
            )
        )
        project.timeline.clips.append(
            Clip(id=f"c_{tid}", track_id=tid, source_start=0.0, source_end=20.0, timeline_start=0.0)
        )
    guest_words = [
        ("one", 11.0),
        ("two", 12.0),
        ("three", 13.0),
        ("four", 14.0),
        ("five", 15.0),
        ("six", 16.0),
    ]
    project.transcripts = [
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text=t, start=s, end=s + 0.3, confidence=0.9) for t, s in guest_words
            ]
            + [TranscriptWord(text="bye", start=18.0, end=18.4, confidence=0.9)],
        ),
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text=t, start=s - 0.14, end=s + 0.16, confidence=1.0)
                for t, s in guest_words
            ]
            + [TranscriptWord(text="bye", start=18.3, end=18.7, confidence=1.0)],
        ),
    ]
    project.combined_transcript = TranscriptionEngine().merge_transcripts(project)
    return project


def test_reconcile_picks_the_source_mic_on_a_measured_bleed_pair(tmp_path: Path) -> None:
    """End to end on synthetic stems, no mocks: the host mic carries the guest 3 ms late, at
    -18 dB early on (which is what flags the pair) and 1 dB louder later (Zoom's gain).
    Whisper put the host copies 140 ms before the guest words. Every copy loses to the
    guest word, the two "bye"s 300 ms apart both stay, and a second pass changes nothing."""
    project = _echo_stem_project(tmp_path)
    pol = AnalysisPolicy(transcript_mode="reconcile", bleed_text_match_enabled=True)

    result = reconcile_transcript(project, policy=pol, dry_run=False, update_status=True)

    host = project.transcript_for_track("host")
    guest = project.transcript_for_track("guest")
    assert host is not None and guest is not None
    assert [(w.text, w.suppressed, w.audibility_status, w.dominant_track) for w in host.words] == [
        ("one", True, "bleed", "guest"),
        ("two", True, "bleed", "guest"),
        ("three", True, "bleed", "guest"),
        ("four", True, "bleed", "guest"),
        ("five", True, "bleed", "guest"),
        ("six", True, "bleed", "guest"),
        ("bye", False, "audible", None),
    ]
    assert [(w.text, w.suppressed, w.audibility_status) for w in guest.words] == [
        ("one", False, "audible"),
        ("two", False, "audible"),
        ("three", False, "audible"),
        ("four", False, "audible"),
        ("five", False, "audible"),
        ("six", False, "audible"),
        ("bye", False, "audible"),
    ]
    assert [(e["track_id"], e["text"], e["reason"]) for e in result.suppress] == [
        ("host", t, "echo_twin") for t in ("one", "two", "three", "four", "five", "six")
    ]
    assert result.unsuppress == []

    again = reconcile_transcript(project, policy=pol, dry_run=False, update_status=True)
    assert (again.suppress, again.unsuppress, again.reattribute, again.status_updates) == (
        [],
        [],
        [],
        0,
    )
