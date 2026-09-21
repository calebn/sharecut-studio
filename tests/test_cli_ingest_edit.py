from __future__ import annotations

import json
import shutil
from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.ingest.consolidate import ConsolidateResult
from podcast_mcp.models import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    EditDecision,
    EditDecisionType,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.ingest import VerifyResult

runner = CliRunner()


def _ingest_fixture(tmp_path: Path, sample_wav: Path) -> tuple[Path, Path]:
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    ref = audio_dir / "ref.wav"
    guest = audio_dir / "guest.wav"
    shutil.copy(sample_wav, ref)
    shutil.copy(sample_wav, guest)
    manifest = tmp_path / "ingest.yaml"
    manifest.write_text(
        """
session:
  reference_speaker: Ref
speakers:
  - name: Ref
    sources: [ref.wav]
  - name: Guest
    sources: [guest.wav]
""",
        encoding="utf-8",
    )
    return audio_dir, manifest


def _setup_edit_project(minimal_project: Path) -> Path:
    proj = load_project(minimal_project)
    proj.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    proj.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.4),
                TranscriptWord(text="world", start=0.5, end=1.0),
            ],
        )
    ]
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.0,
                text="hello world",
            )
        ]
    )
    save_project(proj, minimal_project)
    return minimal_project


def _pending_edit(minimal_project: Path) -> str:
    proj = load_project(minimal_project)
    proj.edit_decisions.append(
        EditDecision(
            id="e1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.0,
            end=0.1,
            reason="filler:um",
            review_required=True,
            applied=False,
        )
    )
    save_project(proj, minimal_project)
    return "e1"


# --- ingest alignment / consolidate ---


def test_ingest_report_cmd(tmp_path, sample_wav):
    audio_dir, manifest = _ingest_fixture(tmp_path, sample_wav)
    out = tmp_path / "report.json"
    result = runner.invoke(
        app,
        [
            "ingest",
            "report",
            "--audio-dir",
            str(audio_dir),
            "--manifest",
            str(manifest),
            "--analysis-start",
            "0",
            "--analysis-duration",
            "1.5",
            "--out",
            str(out),
        ],
    )
    assert result.exit_code == 0
    assert out.is_file()
    assert "Wrote" in result.stdout


def test_ingest_suggest_cmd(tmp_path, sample_wav):
    audio_dir, manifest = _ingest_fixture(tmp_path, sample_wav)
    result = runner.invoke(
        app,
        [
            "ingest",
            "suggest",
            "--audio-dir",
            str(audio_dir),
            "--manifest",
            str(manifest),
            "--analysis-duration",
            "1.5",
            "--sweep-max",
            "0.5",
            "--sweep-step",
            "0.5",
            "--no-waveforms",
        ],
    )
    assert result.exit_code == 0
    data = json.loads(result.stdout.split("\n# Suggested manifest fragment:")[0].strip())
    assert data["reference_speaker"] == "Ref"
    assert "yaml_snippet" in data
    assert "Suggested manifest fragment" in result.stdout


def test_ingest_verify_cmd(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    ws = Path(proj.workspace_dir)
    guest = ws / "raw" / "guest.wav"
    guest.write_bytes(sample_wav.read_bytes())
    proj.timeline.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            speaker="Guest",
            media=MediaAsset(path="raw/guest.wav", duration_sec=2.0),
        )
    )
    save_project(proj, minimal_project)
    fake = VerifyResult(
        status="pass",
        simultaneous_speech_sec=1.0,
        window_start_sec=0.0,
        window_end_sec=1.5,
        per_track_segments=[],
        warnings=[],
        play_commands=[],
    )
    with patch("podcast_mcp.cli.ingest.IngestService") as svc_cls:
        svc_cls.return_value.verify_alignment.return_value = fake
        result = runner.invoke(
            app,
            [
                "ingest",
                "verify",
                "--project",
                str(minimal_project),
                "--window",
                "0:1.5",
                "--no-waveforms",
            ],
        )
    assert result.exit_code == 0
    assert json.loads(result.stdout)["status"] == "pass"


def test_ingest_verify_fail_on_warn(minimal_project):
    fake = VerifyResult(
        status="warn",
        simultaneous_speech_sec=25.0,
        window_start_sec=0.0,
        window_end_sec=90.0,
        per_track_segments=[],
        warnings=["overlap"],
        play_commands=[],
    )
    with patch("podcast_mcp.cli.ingest.IngestService") as svc_cls:
        svc_cls.return_value.verify_alignment.return_value = fake
        result = runner.invoke(
            app,
            [
                "ingest",
                "verify",
                "--project",
                str(minimal_project),
                "--fail-on-warn",
                "--no-waveforms",
            ],
        )
    assert result.exit_code == 1


def test_ingest_verify_bad_window(minimal_project):
    result = runner.invoke(
        app,
        [
            "ingest",
            "verify",
            "--project",
            str(minimal_project),
            "--window",
            "bad",
        ],
    )
    assert result.exit_code != 0


def test_ingest_consolidate_cmd(minimal_project, tmp_path, sample_wav):
    audio_dir, manifest = _ingest_fixture(tmp_path, sample_wav)
    out_wav = tmp_path / "host_out.wav"
    out_wav.write_bytes(sample_wav.read_bytes())
    fake = ConsolidateResult(
        speaker_tracks={"Host": out_wav},
        alignments=[],
        cross_speaker_offsets={"Guest": 0.5},
        session_start_in_file_sec={"Host": 0.0, "Guest": 5.0},
        cross_speaker_align_method={"Guest": "audio"},
    )
    with patch("podcast_mcp.cli.ingest.IngestService") as svc_cls:
        svc = svc_cls.return_value
        svc.consolidate_to_dialogue_tracks.return_value = fake
        svc.apply_consolidated_tracks.return_value = ["host"]
        result = runner.invoke(
            app,
            [
                "ingest",
                "consolidate",
                "--audio-dir",
                str(audio_dir),
                "--manifest",
                str(manifest),
                "--project",
                str(minimal_project),
                "--analysis-duration",
                "1.5",
            ],
        )
    assert result.exit_code == 0
    assert "Consolidated 1 speaker track(s)" in result.stdout
    assert "cross_speaker_offsets_sec" in result.stdout
    svc.consolidate_to_dialogue_tracks.assert_called_once()
    svc.apply_consolidated_tracks.assert_called_once_with(fake)


# --- edit subcommands not covered elsewhere ---


def test_edit_cut_range_and_utterance(minimal_project):
    project = _setup_edit_project(minimal_project)
    r1 = runner.invoke(
        app,
        [
            "edit",
            "cut-range",
            "--project",
            str(project),
            "--track",
            "host",
            "--start",
            "0.1",
            "--end",
            "0.2",
            "--no-review",
        ],
    )
    assert r1.exit_code == 0
    assert "Cut host" in r1.stdout
    r2 = runner.invoke(
        app,
        [
            "edit",
            "cut-utterance",
            "--project",
            str(project),
            "--index",
            "0",
        ],
    )
    assert r2.exit_code == 0
    assert "Cut utterance 0" in r2.stdout


def test_edit_approve_reject_list(minimal_project):
    project = _setup_edit_project(minimal_project)
    edit_id = _pending_edit(project)
    approve = runner.invoke(
        app,
        ["edit", "approve", "--project", str(project), "--ids", edit_id],
    )
    assert approve.exit_code == 0
    assert "Approved 1 edit(s)." in approve.stdout
    assert "Warning" not in approve.stderr

    edit_id2 = _pending_edit(project)
    reject = runner.invoke(
        app,
        ["edit", "reject", "--project", str(project), "--ids", edit_id2],
    )
    assert reject.exit_code == 0
    assert "Removed 1 edit(s)" in reject.stdout

    _pending_edit(project)
    listing = runner.invoke(
        app,
        ["edit", "list", "--project", str(project), "--pending"],
    )
    assert listing.exit_code == 0
    data = json.loads(listing.stdout)
    assert len(data) == 1


def test_edit_approve_warns_when_nothing_approved(minimal_project):
    project = _setup_edit_project(minimal_project)
    result = runner.invoke(
        app,
        ["edit", "approve", "--project", str(project), "--ids", "nonexistent-id-12345"],
    )
    assert result.exit_code == 0
    assert "Approved 0 edit(s)." in result.stdout
    assert "no edits were approved" in result.stderr


def test_edit_approve_warns_for_stale_mute(minimal_project):
    project = _setup_edit_project(minimal_project)
    proj = load_project(project)
    proj.edit_decisions.append(
        EditDecision(
            id="stale-mute",
            track_id="host",
            type=EditDecisionType.MUTE,
            start=1000.0,
            end=1001.0,
            applied=False,
        )
    )
    save_project(proj, project)

    result = runner.invoke(
        app,
        ["edit", "approve", "--project", str(project), "--ids", "stale-mute"],
    )

    assert result.exit_code == 0
    assert "Approved 0 edit(s)." in result.stdout
    assert "no edits were approved" in result.stderr
    assert [decision.id for decision in load_project(project).edit_decisions] == ["stale-mute"]


def test_edit_transcript_and_preview_cut(minimal_project):
    project = _setup_edit_project(minimal_project)
    transcript = runner.invoke(
        app,
        ["edit", "transcript", "--project", str(project)],
    )
    assert transcript.exit_code == 0
    assert "hello" in transcript.stdout

    preview = runner.invoke(
        app,
        [
            "edit",
            "preview-cut",
            "--project",
            str(project),
            "--track",
            "host",
            "--start",
            "0.1",
            "--end",
            "0.3",
        ],
    )
    assert preview.exit_code == 0
    assert "start" in json.loads(preview.stdout)


def test_edit_join_quality_cli(minimal_project, monkeypatch):
    project = _setup_edit_project(minimal_project)

    class _Rep:
        def to_dict(self):
            return {"verdict": "pass", "risk": 0.1, "disclaimer": "x"}

    monkeypatch.setattr(
        "podcast_mcp.services.edit.assess_existing_join",
        lambda *a, **k: _Rep(),
    )
    monkeypatch.setattr(
        "podcast_mcp.services.edit.assess_project_joins",
        lambda *a, **k: {"join_count": 1, "fail_count": 0},
    )
    jq = runner.invoke(
        app,
        [
            "edit",
            "join-quality",
            "--project",
            str(project),
            "--track",
            "host",
            "--join",
            "0.5",
        ],
    )
    assert jq.exit_code == 0
    assert json.loads(jq.stdout)["verdict"] == "pass"

    sweep = runner.invoke(
        app,
        ["edit", "join-sweep", "--project", str(project), "--track", "host"],
    )
    assert sweep.exit_code == 0
    assert json.loads(sweep.stdout)["join_count"] == 1

    label = runner.invoke(
        app,
        [
            "edit",
            "join-label",
            "--project",
            str(project),
            "--track",
            "host",
            "--join",
            "0.5",
            "--verdict",
            "fail",
            "--no-play",
        ],
    )
    assert label.exit_code == 0
    assert json.loads(label.stdout)["label"]["verdict"] == "fail"

    train = runner.invoke(
        app,
        ["edit", "join-train", "--project", str(project)],
    )
    assert train.exit_code == 0
    assert "n_labels" in json.loads(train.stdout)


def test_edit_timeline_ops(minimal_project):
    project = _setup_edit_project(minimal_project)
    ripple = runner.invoke(
        app,
        [
            "edit",
            "ripple-delete",
            "--project",
            str(project),
            "--start",
            "0.2",
            "--end",
            "0.3",
        ],
    )
    assert ripple.exit_code == 0
    assert json.loads(ripple.stdout)["operation"] == "ripple_delete"

    move = runner.invoke(
        app,
        [
            "edit",
            "move",
            "--project",
            str(project),
            "--from-start",
            "0.0",
            "--from-end",
            "0.1",
            "--to",
            "0.5",
        ],
    )
    assert move.exit_code == 0

    gap = runner.invoke(
        app,
        ["edit", "insert-gap", "--project", str(project), "--at", "0.5", "--duration", "0.25"],
    )
    assert gap.exit_code == 0

    fade_joins = runner.invoke(
        app,
        ["edit", "fade-joins", "--project", str(project), "--dry-run"],
    )
    assert fade_joins.exit_code == 0

    clips = runner.invoke(app, ["edit", "list-clips", "--project", str(project)])
    assert clips.exit_code == 0
    clip_data = json.loads(clips.stdout)
    assert clip_data["clip_count"] >= 1
    assert "host" in clip_data["tracks"]

    added = runner.invoke(
        app,
        [
            "edit",
            "add-chapter",
            "--project",
            str(project),
            "--at-time",
            "0.0",
            "--title",
            "Intro",
        ],
    )
    assert added.exit_code == 0
    listed = runner.invoke(app, ["edit", "list-chapters", "--project", str(project)])
    assert listed.exit_code == 0
    assert any(ch["title"] == "Intro" for ch in json.loads(listed.stdout))
    removed = runner.invoke(
        app,
        ["edit", "remove-chapter", "--project", str(project), "--title", "Intro"],
    )
    assert removed.exit_code == 0
    assert json.loads(removed.stdout)["removed"] is True

    applied = runner.invoke(
        app, ["edit", "list-applied", "--project", str(project), "--track", "host"]
    )
    assert applied.exit_code == 0
    assert "records" in json.loads(applied.stdout)

    render = runner.invoke(app, ["edit", "render-status", "--project", str(project)])
    assert render.exit_code == 0
    assert "needs_rerender" in json.loads(render.stdout)

    gaps = runner.invoke(
        app,
        ["edit", "shorten-gaps", "--project", str(project), "--max-gap", "0.2"],
    )
    assert gaps.exit_code == 0


def test_edit_ripple_delete_and_move_bad_params(minimal_project):
    project = _setup_edit_project(minimal_project)
    ripple = runner.invoke(app, ["edit", "ripple-delete", "--project", str(project)])
    assert ripple.exit_code != 0
    move = runner.invoke(app, ["edit", "move", "--project", str(project)])
    assert move.exit_code != 0


@pytest.mark.parametrize(
    "command,extra,patch_method,return_value",
    [
        (
            "strip-silence",
            ["--track", "host"],
            "strip_silence",
            {"removed_sec": 0.0, "cuts": []},
        ),
        (
            "analyze-cleanup",
            [],
            "analyze_cleanup",
            {"summary": {"tracks": 1}},
        ),
        (
            "audio-diagnostics",
            ["--track", "host"],
            "audio_diagnostics",
            {"track_id": "host", "spectrogram_png": "spec.png", "waveform_png": "wave.png"},
        ),
        (
            "recommend-fades",
            [],
            "recommend_fades",
            {"recommendations": []},
        ),
        (
            "low-audibility",
            [],
            "low_audibility_words",
            {"words": []},
        ),
        (
            "suppress-low-audibility",
            [],
            "suppress_low_audibility",
            {"suppressed_count": 0},
        ),
        (
            "gate-overreach",
            [],
            "gate_overreach",
            {"overreach": []},
        ),
        (
            "audibility-map",
            [],
            "audibility_map",
            {"tracks": {}},
        ),
        (
            "flagged-words",
            [],
            "flagged_words",
            {"words": []},
        ),
        (
            "reconciliation-status",
            [],
            "reconciliation_status",
            {"stale": False},
        ),
        (
            "reconcile-transcript",
            ["--dry-run"],
            "reconcile_transcript",
            {"applied": 0},
        ),
        (
            "bleed-words",
            [],
            "list_bleed_words",
            {"words": []},
        ),
        (
            "suppress-bleed",
            ["--dry-run"],
            "suppress_bleed",
            {"suppressed_count": 0},
        ),
        (
            "overlap-duplicates",
            [],
            "overlap_duplicates",
            {"pairs": []},
        ),
        (
            "apply-bleed-mute",
            ["--dry-run"],
            "apply_bleed_mute",
            {"candidate_count": 0},
        ),
    ],
)
def test_edit_service_wrapped_commands(
    minimal_project,
    command,
    extra,
    patch_method,
    return_value,
):
    project = _setup_edit_project(minimal_project)
    args = ["edit", command, "--project", str(project), *extra]
    with patch(f"podcast_mcp.cli.edit.EditService.{patch_method}", return_value=return_value):
        result = runner.invoke(app, args)
    assert result.exit_code == 0
    assert json.loads(result.stdout) == return_value


def test_edit_ripple_delete_by_query(minimal_project):
    project = _setup_edit_project(minimal_project)
    with patch("podcast_mcp.cli.edit.EditService") as svc_cls:
        svc_cls.return_value.ripple_delete_text.return_value = {
            "operation": "ripple_delete_text",
            "removed_sec": 0.5,
        }
        result = runner.invoke(
            app,
            [
                "edit",
                "ripple-delete",
                "--project",
                str(project),
                "--query",
                "hello",
            ],
        )
    assert result.exit_code == 0
    assert json.loads(result.stdout)["operation"] == "ripple_delete_text"


def test_edit_move_by_query(minimal_project):
    project = _setup_edit_project(minimal_project)
    with patch("podcast_mcp.cli.edit.EditService") as svc_cls:
        svc_cls.return_value.move_by_text.return_value = {"moved": True}
        result = runner.invoke(
            app,
            [
                "edit",
                "move",
                "--project",
                str(project),
                "--from-query",
                "hello",
                "--to-after",
                "world",
            ],
        )
    assert result.exit_code == 0
    assert json.loads(result.stdout)["moved"] is True


def test_edit_suppress_bleed_bad_words_json(minimal_project):
    project = _setup_edit_project(minimal_project)
    result = runner.invoke(
        app,
        [
            "edit",
            "suppress-bleed",
            "--project",
            str(project),
            "--words-json",
            '{"not": "array"}',
        ],
    )
    assert result.exit_code != 0
