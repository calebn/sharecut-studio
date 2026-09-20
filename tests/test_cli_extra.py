from __future__ import annotations

import json
from unittest.mock import patch

from typer.testing import CliRunner

from podcast_mcp.cli.history import history_app
from podcast_mcp.cli.main import app
from podcast_mcp.cli.speaker import speaker_app
from podcast_mcp.cli.transcript_cmd import transcript_app
from podcast_mcp.models import CombinedTranscript, CombinedUtterance, load_project, save_project

runner = CliRunner()


def _init_project(tmp_path):
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws), "--name", "cli-test"])
    return ws / "episode.project.json"


def test_history_list_and_record(tmp_path):
    project = _init_project(tmp_path)
    record = runner.invoke(
        history_app,
        ["record", "--project", str(project), "--label", "snap-a"],
    )
    assert record.exit_code == 0
    listing = runner.invoke(history_app, ["list", "--project", str(project)])
    assert listing.exit_code == 0
    assert "snap-a" in listing.stdout


def test_history_goto_invalid_index(tmp_path):
    project = _init_project(tmp_path)
    result = runner.invoke(
        history_app,
        ["goto", "--project", str(project), "--index", "99"],
    )
    assert result.exit_code == 1


def test_history_diff_cli(tmp_path):
    project = _init_project(tmp_path)
    runner.invoke(history_app, ["record", "--project", str(project), "--label", "a"])
    runner.invoke(history_app, ["record", "--project", str(project), "--label", "b"])
    result = runner.invoke(history_app, ["diff", "--project", str(project)])
    assert result.exit_code == 0
    data = json.loads(result.stdout)
    assert "diff" in data


def test_history_undo_redo_status(tmp_path):
    project = _init_project(tmp_path)
    runner.invoke(history_app, ["record", "--project", str(project), "--label", "one"])
    undo = runner.invoke(app, ["undo", "--project", str(project)])
    assert undo.exit_code == 0
    redo = runner.invoke(app, ["redo", "--project", str(project)])
    assert redo.exit_code == 0
    status = runner.invoke(app, ["history-status", "--project", str(project)])
    assert status.exit_code == 0
    data = json.loads(status.stdout)
    assert "cursor" in data


def test_speaker_doctor_cli():
    result = runner.invoke(speaker_app, ["doctor"])
    assert result.exit_code == 0
    data = json.loads(result.stdout)
    assert "available_backends" in data


def test_speaker_profiles_cli(tmp_path):
    project = _init_project(tmp_path)
    result = runner.invoke(speaker_app, ["profiles", "--project", str(project)])
    assert result.exit_code == 0
    assert json.loads(result.stdout) == []


def test_speaker_enroll_score_compare_cli(tmp_path, sample_wav):
    project = _init_project(tmp_path)
    from podcast_mcp.models import (
        Clip,
        MediaAsset,
        Track,
        TrackRole,
        Transcript,
        TranscriptWord,
        load_project,
        save_project,
    )

    proj = load_project(project)
    (proj.workspace_path() / "raw").mkdir(exist_ok=True)
    (proj.workspace_path() / "raw" / "host.wav").write_bytes(sample_wav.read_bytes())
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    proj.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=2.0, timeline_start=0.0)
    ]
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hi", start=0.1, end=0.4, confidence=0.9)],
        )
    ]
    save_project(proj, project)
    with patch(
        "podcast_mcp.cli.speaker.SpeakerService.enroll",
        return_value={"enrolled": [], "backend": "mock"},
    ):
        enroll = runner.invoke(
            speaker_app,
            ["enroll", "--project", str(project), "--track", "host"],
        )
    assert enroll.exit_code == 0
    with patch(
        "podcast_mcp.cli.speaker.SpeakerService.score",
        return_value={"best_track_id": "host"},
    ):
        score = runner.invoke(
            speaker_app,
            ["score", "--project", str(project), "--track", "host", "--start", "0", "--end", "1"],
        )
    assert score.exit_code == 0
    with patch(
        "podcast_mcp.cli.speaker.SpeakerService.compare_pair",
        return_value={"same_speaker_likely": True},
    ):
        compare = runner.invoke(
            speaker_app,
            [
                "compare",
                "--project",
                str(project),
                "--start",
                "0",
                "--end",
                "1",
                "--track-a",
                "host",
                "--start-a",
                "0",
                "--end-a",
                "1",
                "--track-b",
                "host",
                "--start-b",
                "1",
                "--end-b",
                "2",
            ],
        )
    assert compare.exit_code == 0
    with patch(
        "podcast_mcp.cli.speaker.SpeakerService.compare_window",
        return_value={"tracks": []},
    ):
        window_cmp = runner.invoke(
            speaker_app,
            ["compare", "--project", str(project), "--start", "0", "--end", "1"],
        )
    assert window_cmp.exit_code == 0
    with patch(
        "podcast_mcp.cli.speaker.SpeakerService.label",
        return_value={"labeled": 0},
    ):
        label = runner.invoke(
            speaker_app,
            [
                "label",
                "--project",
                str(project),
                "--track",
                "host",
                "--start",
                "0",
                "--end",
                "1",
            ],
        )
    assert label.exit_code == 0
    with patch(
        "podcast_mcp.cli.speaker.SpeakerService.set_expected_speaker_count",
        return_value={"expected_speaker_count": 2},
    ):
        count = runner.invoke(
            speaker_app,
            ["set-speaker-count", "--project", str(project), "--speakers", "2"],
        )
    assert count.exit_code == 0
    with patch(
        "podcast_mcp.cli.speaker.SpeakerService.gate_track",
        return_value={"words_would_suppress": 1, "words_suppressed": 0},
    ):
        gate = runner.invoke(
            speaker_app,
            ["gate-track", "--project", str(project), "--track", "host"],
        )
    assert gate.exit_code == 0
    assert json.loads(gate.stdout)["words_would_suppress"] == 1
    with patch(
        "podcast_mcp.cli.speaker.SpeakerService.attribute",
        return_value={"attributions_would_change": 3, "attributions_changed": 0},
    ):
        attr = runner.invoke(
            speaker_app,
            ["attribute", "--project", str(project)],
        )
    assert attr.exit_code == 0
    assert json.loads(attr.stdout)["attributions_would_change"] == 3


def test_transcript_export_srt_vtt(tmp_path):
    project = _init_project(tmp_path)
    proj = load_project(project)
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.0,
                text="Subtitle line",
            )
        ]
    )
    save_project(proj, project)
    srt = runner.invoke(
        transcript_app,
        ["export-srt", "--project", str(project)],
    )
    assert srt.exit_code == 0
    assert srt.stdout.strip().endswith(".srt")
    vtt = runner.invoke(
        transcript_app,
        ["export-vtt", "--project", str(project)],
    )
    assert vtt.exit_code == 0


def test_transcript_context_show_and_set(tmp_path):
    project = _init_project(tmp_path)
    show = runner.invoke(
        transcript_app,
        ["context", "show", "--project", str(project)],
    )
    assert show.exit_code == 0
    set_ctx = runner.invoke(
        transcript_app,
        [
            "context",
            "set",
            "--project",
            str(project),
            "--show-title",
            "Demo Show",
            "--term",
            "Puro Pinché",
        ],
    )
    assert set_ctx.exit_code == 0
    assert "transcript_context.yaml" in set_ctx.stdout


def test_transcript_precorrect_dry_run(tmp_path):
    project = _init_project(tmp_path)
    with patch(
        "podcast_mcp.cli.transcript_cmd.TranscriptPrecorrectService.precorrect",
        return_value={"applied": 0, "deferred_queue": []},
    ):
        result = runner.invoke(
            transcript_app,
            ["precorrect", "--project", str(project), "--dry-run"],
        )
    assert result.exit_code == 0
    assert "applied" in result.stdout


def test_pipeline_export_audio_cli(tmp_path, sample_wav):
    project = _init_project(tmp_path)
    with patch("podcast_mcp.cli.pipeline.PipelineService.export_audio") as export:
        export.return_value = [tmp_path / "out.mp3"]
        result = runner.invoke(
            app,
            [
                "pipeline",
                "export-audio",
                "--project",
                str(project),
                "--formats",
                '[{"ext":"mp3"}]',
            ],
        )
    assert result.exit_code == 0
    assert "out.mp3" in result.stdout


def test_e2e_project_path_env_override(tmp_path, monkeypatch):
    from podcast_mcp.e2e_fixture import e2e_project_path

    ws = tmp_path / "custom"
    ws.mkdir()
    project = ws / "episode.project.json"
    project.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("PODCAST_E2E_PROJECT", str(ws))
    assert e2e_project_path() == project.resolve()

    monkeypatch.setenv("PODCAST_E2E_PROJECT", str(project))
    assert e2e_project_path() == project.resolve()
